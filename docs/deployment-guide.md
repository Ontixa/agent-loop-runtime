# Deployment & Operations Guide

## Install

```bash
git clone https://github.com/Ontixa/agent-loop-runtime.git
cd agent-loop-runtime
npm ci
npm run build
npm link   # provides `agentloop`
```

Use Node.js 24.14.1 (locally verified) and Git. Node 18 does not meet the locked
dependency requirements. Windows with PowerShell and Git for Windows does not
require WSL; verify vendor sandbox and workspace-trust setup separately.

## Per-repository setup

```bash
cd <repo>
agentloop init --agent codex # choose your installed, authenticated CLI
agentloop doctor    # verifies git, agents, config, policy
```

`agentloop.config.json` — agents, `validationCommands` (the deterministic gates), daemon settings.
`agentloop.policy.json` — allowlists, budgets, protected paths, push/PR modes, approval timeout.

The repository needs at least one commit. Without `--agent`, `init` defaults to
Qwen rather than automatically choosing an installed CLI.

Before running a mission, edit the generated config to add real validation
commands, keeping its agent configuration. For a project that defines `npm test`,
merge this field into `agentloop.config.json`:

```json
{
  "validationCommands": {
    "test": ["npm", "test"]
  }
}
```

Allow that exact command in policy or explicitly approve it when requested.
`--criteria` is descriptive text, not an executable gate definition. See
[Validation gates](../README.md#validation-gates) and the policy example; use
actual JSON without comments, and retain default protected paths when extending
the array.

## Running

Foreground (one mission):

```bash
agentloop run "objective" --no-plan --criteria "npm test passes"
```

For this first mission, `--no-plan` skips the separate model-planning call and
uses one implementation task. It does not skip validation or review.

Daemon (continuous, multi-repo):

```bash
agentloop daemon    # serves loopback API on 127.0.0.1:3210
```

To take the API off the network entirely, serve it on a Unix domain socket
(POSIX) or Windows named pipe instead of TCP — via `daemon.socketPath` in
`agentloop.config.json` or the `--socket` flag (overrides host/port):

```bash
agentloop daemon --socket /run/agentloop/ctl.sock        # POSIX
agentloop daemon --socket '\\.\pipe\agentloop-ctl'       # Windows named pipe
```

`daemon.json` then records `transport` (`"unix"`/`"pipe"`) + `socketPath`
instead of `url`. Bearer auth is unchanged — every route still needs the
token; the socket removes the TCP surface (port scans, DNS rebinding), it is
not a permission boundary. POSIX socket files are mode `0600`; a stale
socket file is reclaimed on restart, but a live peer on the endpoint refuses
the bind rather than sharing it.

On start the daemon sweeps for interrupted missions: dead runners → `stale` → recovered to `prepared` and resumed. On SIGINT/SIGTERM it pauses active missions (they resume next start) — it does not kill work mid-flight.

## Scheduler admission order and host-pressure deferral

When queued missions compete for free slots the daemon's scheduler admits
them in a deterministic order (implemented in `engine/scheduler.ts`):

1. **Priority first** — lower `priority` number wins (default `100`;
   set per mission via `POST /v1/missions` `priority`). Priority reorders
   *queued* work only: a running mission is never preempted or killed to
   make room — "preemption" means a later-arriving higher-priority mission
   passes queued lower-priority ones.
2. **Round-robin across repos** — among equal priorities, the repo whose
   most recent admission is oldest wins (a never-served repo counts as
   oldest). Every repo gets a turn before any repo gets a second slot in
   the same band, so a busy repository cannot starve quieter ones.
3. **FIFO** — equal priority and equal repo credit → earliest `queuedAt`.

Capacity is enforced before ordering: `maxConcurrentMissionsPerRepo` per
repo policy, and the effective global cap is the *minimum* of all
registered repos' `maxConcurrentMissions` (the most restrictive registered
policy wins, matching the pre-fairness loop's effective bound).

Separately, **resource-aware admission** samples host pressure before
starting queued missions and defers all new admissions while over
threshold — running and queued missions are untouched, and each queued
mission records a `mission_deferred` event (once per pressure episode)
with the measured sample and reason. Admission re-checks automatically
every `recheckMs` while work waits. Thresholds come from `daemon.admission`
in the `agentloop.config.json` of the directory where `agentloop daemon`
was started (same source as `daemon.port`/`token`):

```json
{
  "daemon": {
    "admission": {
      "enabled": true,
      "maxLoadPerCpu": 2,
      "minFreeMemRatio": 0.05,
      "recheckMs": 30000
    }
  }
}
```

`maxLoadPerCpu` compares `os.loadavg()[0]` divided by logical CPU count —
on Windows `loadavg` is always `0`, so that check is inert there and only
`minFreeMemRatio` guards admission. A threshold of `0` disables that check;
`"enabled": false` disables the gate entirely. `GET /v1/status` reports
`scheduler.admission` (`deferred`, `reason`, `since`, `sample`) while a
deferral episode is active.

## Control API (v1, loopback)

`GET  /v1/status` — daemon health
`GET  /v1/missions` — list missions
`GET  /v1/missions/:id` — inspect
`POST /v1/missions` — create
`POST /v1/missions/:id/pause | resume | cancel`
`GET  /v1/missions/:id/events` — event page (`?after=<seq>&limit=<n>`);
add `?follow` for a bounded NDJSON live tail (`?after=<seq>` also applies).
Follow streams emit one persisted event per line plus `{"meta":...}` control
lines (`begin`/`heartbeat`/`end`), close when the mission reaches a terminal
state, and are capped per connection and per daemon (`daemon.eventFollow`
config: `pollMs`, `heartbeatMs`, `maxDurationMs`, `maxConnections`).

API data/control requests require bearer authentication, including loopback. Configure
`daemon.token` or `AGENTLOOP_API_TOKEN` (an explicit credential is required for
non-loopback binding), or let the daemon
generate an ephemeral credential. After successful startup, operator tooling can
read the credential from `.agentloop/daemon.json` (or `AGENTLOOP_HOME/daemon.json`).
Never print or pass this administrative token to an agent. The status file is
created with POSIX mode `0600`; on Windows, restrict the directory's inherited ACL
to the operator account. This is not isolation from processes running as that user.
With port `0`, the operating system assigns an available port; read the running
daemon's actual URL from the status file. IPv6 literal URLs use brackets.
When `daemon.socketPath`/`--socket` selects the socket transport, clients
connect over the Unix socket or named pipe with `Host: localhost` — the same
routes, envelopes and auth apply (see docs/control-api-contract.md).

## Operational runbook

| Situation | Action |
|---|---|
| Mission stuck `waiting_for_approval` | `agentloop status <id>` → `agentloop approve <id> <approvalId>` or let `approvalTimeoutMs` → `blocked` |
| Runtime killed mid-mission | Restart / `agentloop resume <id>` — runner heartbeat staleness → `stale` → `prepared` |
| Mission `blocked` | Read `mission.json` outcome + events; fix cause; create a new mission |
| Worktree cleanup | `agentloop clean` removes worktrees + merged `agentloop/<id>` branches of terminal missions (`--dry-run` preview, `--force` for dirty/unmerged, `--keep-branch`, `--older-than 7d`); mission records under `.agentloop/missions/` are kept |
| Log growth | Agent logs bounded per-invocation under mission dir; `agentloop logs <id>` tails them |

## Upgrading from Qwen Loop

```bash
cd <target-repository>
agentloop migrate   # qwen-loop.config.json → agentloop.config.json (+ .bak)
```

Migration reads the legacy config in the current working directory and preserves
the original file. `migrate` does not accept `--repo`; change into the target
repository first. Qwen stays available as a `{"type": "qwen"}` agent adapter.
