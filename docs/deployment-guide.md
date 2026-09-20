# Deployment & Operations Guide

## Install

```bash
git clone https://github.com/Ontixa/agent-loop-runtime.git
cd agent-loop-runtime
npm install && npm run build
npm link   # provides `agentloop`
```

Requirements: Node.js 18+, Git. Windows 11 (PowerShell + Git for Windows) is first-class; WSL not required.

## Per-repository setup

```bash
cd <repo>
agentloop init      # writes agentloop.config.json + agentloop.policy.json
agentloop doctor    # verifies git, agents, config, policy
```

`agentloop.config.json` — agents, `validationCommands` (the deterministic gates), daemon settings.
`agentloop.policy.json` — allowlists, budgets, protected paths, push/PR modes, approval timeout.

## Running

Foreground (one mission):

```bash
agentloop run "objective" --criteria "npm test passes"
```

Daemon (continuous, multi-repo):

```bash
agentloop daemon    # serves loopback API on 127.0.0.1:3210
```

On start the daemon sweeps for interrupted missions: dead runners → `stale` → recovered to `prepared` and resumed. On SIGINT/SIGTERM it pauses active missions (they resume next start) — it does not kill work mid-flight.

## Control API (v1, loopback)

`GET  /v1/health` — daemon health
`GET  /v1/missions` — list missions
`GET  /v1/missions/:id` — inspect
`POST /v1/missions` — create
`POST /v1/missions/:id/pause | resume | cancel`
`GET  /v1/missions/:id/events` — JSONL event stream

Loopback needs no auth. If bound beyond loopback, require `AGENTLOOP_API_TOKEN` (Bearer).

## Operational runbook

| Situation | Action |
|---|---|
| Mission stuck `waiting_for_approval` | `agentloop status <id>` → `agentloop approve <id> <approvalId>` or let `approvalTimeoutMs` → `blocked` |
| Runtime killed mid-mission | Restart / `agentloop resume <id>` — runner heartbeat staleness → `stale` → `prepared` |
| Mission `blocked` | Read `mission.json` outcome + events; fix cause; create a new mission |
| Worktree cleanup | Missions keep `agentloop/<id>` branches by default; `git worktree remove .agentloop/worktrees/<id>` + `git branch -D agentloop/<id>` when done |
| Log growth | Agent logs bounded per-invocation under mission dir; `agentloop logs <id>` tails them |

## Upgrading from Qwen Loop

```bash
agentloop migrate   # qwen-loop.config.json → agentloop.config.json (+ .bak)
```

Legacy config is detected beside the target path (cwd or `--repo` dir), never destroyed. Qwen stays available as `{"type": "qwen"}` agent adapter.
