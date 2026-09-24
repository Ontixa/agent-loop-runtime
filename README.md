# Agent Loop Runtime

A headless runtime for running coding agents continuously, safely, reproducibly — with explicit human control boundaries.

> **How do I safely run coding agents for hours or days without turning my repository into chaos?**

Agent Loop Runtime answers that with a persisted **Mission** model: every run has an objective, an isolated Git worktree, a deterministic policy, bounded budgets, validation gates, human approval points, and a durable record you can inspect afterward.

Run Codex, Claude Code, Devin, Gemini CLI, Qwen Code, OpenCode, Aider, or any configured terminal coding agent under one mission, policy, and recovery model.

## Boundary

| | |
|---|---|
| **Agent Loop Runtime** | Headless execution engine — missions, worktrees, policy, recovery |
| **AI CLI Editor** | Separate terminal-session UI; runtime mission integration is not implemented yet |

## Install

```bash
git clone https://github.com/Ontixa/agent-loop-runtime.git
cd agent-loop-runtime
npm ci
npm run build
node scripts/demo-mission.mjs
```

The final command runs a provider-free mission immediately. No global install
or AI account is needed for this demo.

Use Node.js 24.14.1 (the locally verified version) and Git. Node 18 is not
compatible with the locked dependency requirements. Windows (PowerShell, Git for
Windows) is supported without WSL; vendor CLI sandbox/trust setup is separate.

Package contents are explicitly allowlisted: executable/library output, source
and maps, legal/security documents, documentation and supported scripts/examples.
After building, run `npm run test:package` to verify inventory and exercise the
unpacked module, CLI and provider-free demo. See [package boundary](docs/package-boundary.md)
for the intentional contents and verification limits.

## Try a mission without an AI account

The install sequence above runs this demo. To run it again from the runtime
checkout after building:

```bash
node scripts/demo-mission.mjs
```

This uses a **deterministic Node fixture agent**, not a model. No AI credentials
or provider calls are needed. It creates a disposable temporary Git repository,
runs one bounded invocation in an isolated worktree, verifies exact file content,
and prints the persisted receipt path. It also checks that the original fixture
checkout and HEAD are unchanged. Your current project is not used as the mission
repository, and no commit is pushed or merged.

To see a successful agent process rejected by real validation:

```bash
node scripts/demo-mission.mjs --fail-validation
```

That deliberately writes incorrect bytes and exits **1**, after verifying the
mission failed and its receipt recorded the failing gate. `--help` has no mission
side effects. Both demonstrations retain the printed temporary directory for
inspection; remove only that exact disposable directory when finished.

These examples do not test a vendor CLI, sandbox containment, or crash recovery.
Run `node scripts/test-demo.mjs` to check both outcomes; packed crash recovery is
the separate `npm run test:e2e` gate. To use a real coding agent, continue below
and configure that CLI's authentication, sandbox and workspace trust.

## Quick start

The commands below use `agentloop` on PATH. **Optional:** from the built runtime
checkout (before changing into your target repository), create that command:

```bash
npm link
```

This changes your global npm command links; it is not needed for the demo. If you
skip linking, replace each `agentloop` below with
`node "<absolute-path-to-agent-loop-runtime>/dist/cli.js"` instead.

```bash
cd your-repo

# 1. Scaffold config + policy files
agentloop init --agent codex

# 2. Check environment (git, agents detected, config, policy)
agentloop doctor

# 3. Define acceptance criteria via validation commands in agentloop.config.json
#    (see Validation gates below)

# 4. Run a mission — isolated worktree, bounded, resumable
agentloop run "Fix the date-parsing bug in src/parser.ts" --no-plan --criteria "npm test passes"

# 5. Inspect
agentloop missions --all
agentloop status <missionId>
agentloop logs <missionId>
agentloop report <missionId>          # human + --json receipt: passes, gates, recovery audit, outcome

# 6. Reclaim workspace (mission records are kept)
agentloop clean --dry-run             # preview GC of terminal missions
agentloop clean                       # remove worktrees + merged agentloop/<id> branches
```

Choose the installed, authenticated CLI you intend to use (`codex` above is an
example). Without `--agent`, `init` defaults to Qwen; it does not automatically
select another detected CLI. The repository needs at least one existing commit.
`--criteria` describes acceptance but does not configure a validation command.
This first run uses `--no-plan` to create one implementation task without a
separate model-planning call; validation and review still run.

Without `--no-plan`, planning runs inside the prepared workspace under the same
runner lease and budget as implementation. `maxAgentInvocations` counts planning
attempts too: a cap of one permits a planner or a worker, not both. Interrupted
planning keeps its debit and falls back without automatically calling the planner
again. See [planning lifecycle and receipt compatibility](docs/planning-lifecycle.md).

Missions pause for human approval when policy demands it:

```bash
agentloop approve <missionId> <approvalId>
agentloop pause <missionId>
agentloop resume <missionId>
agentloop cancel <missionId>
```

## The Mission model

A Mission is the fundamental unit of work — never an infinite YOLO loop.

```text
created → prepared → running → validating → completed
                     ↓    ↑        ↓
                  paused ─┘   repairing (bounded)
                     ↓             ↓
          waiting_for_approval   failed / blocked / cancelled
```

Every mission carries: objective, acceptance criteria, non-goals, repository + base SHA, agent config, policy snapshot, workspace (worktree), budgets, task DAG, pass history, approvals, checkpoints, usage, and a final outcome with an execution receipt. Optionally that receipt is also Ed25519-signed into `receipt.signed.json` — see [signed receipts](docs/signed-receipts.md).

State is persisted under `.agentloop/missions/<id>/` (`mission.json` CAS + `mission.json.lock`, `events.jsonl` seq/id, `approvals.json`, `receipt.json`, `receipt.signed.json` when enabled, bounded agent logs). Only a live lease-holder (pid + nonce + heartbeat) may write. Crash the runtime — `agentloop resume` audits what was interrupted (tasks, passes, orphaned agent pids, lost-work suspicion) and re-enters through `prepared`; interrupted work is retried with a partial-work warning, never marked done. A corrupt `mission.json` is reported as corrupt, never treated as missing.

## Safety model

- **Worktree isolation by default** — each mission runs in `.agentloop/worktrees/<id>` on branch `agentloop/<id>`. In-place mode requires explicit `--in-place --approve-in-place`.
- **No unconditional push** — local checkpoint commits are configurable; push/PR/merge are policy-gated and require approval. Never force-push, never rewrite protected branches.
- **Explicit process arguments** — no `shell: true` or free-form command text from agent output. Native/Node processes receive argv; the restricted Windows batch transport is described below.
- **Deterministic runtime policy** — `agentloop.policy.json` governs runtime-invoked actions. It does not intercept commands executed internally by an agent or prevent that process from writing files; review and integrity checks detect specific violations. See the threat model before unattended use.
- **Bounded everything** — mission wall-time, agent invocations, repair passes, output buffers, log files, concurrency. Limits expire to `blocked`/`failed`, never to infinity.
- **Secret hygiene** — known token patterns are redacted from logs and events; `AGENTLOOP_*` runtime internals are scrubbed from agent child environments.
- **Approvals are exact** — a decision binds to the mission, the exact argv, the policy fingerprint, and the worktree. Approving `["node","-e"]` does not cover longer commands. Set `AGENTLOOP_APPROVAL_KEY` to require HMAC-signed decisions.
- **Honest recovery** — see [`docs/threat-model.md`](docs/threat-model.md) for what is enforced vs. detected vs. not claimed, and [`docs/fault-matrix.md`](docs/fault-matrix.md) for the verified fault-injection matrix.

## Validation gates

Acceptance is proven by deterministic commands you configure — not by the agent declaring "looks done".

Merge this field into `agentloop.config.json`, retaining the generated agent
configuration. Use actual commands provided by your project:

```json
{
  "validationCommands": {
    "lint":      ["npm", "run", "lint"],
    "typecheck": ["npx", "tsc", "--noEmit"],
    "test":      ["npm", "test"]
  }
}
```

Gates are classified against policy before execution:

- **allowed** → runs
- **needs-approval** → mission pauses at `waiting_for_approval`; `agentloop approve` lets it continue (approval is sticky for the mission — it never asks twice for the same command)
- **refused** → gate fails, command never executes (e.g. `git push --force`, wallet ops)

## Mission presets

Recurring maintenance work ships as named presets with strict scopes — a
bounded path allowlist, an explicit command envelope, tight budgets, required
validation gates and a restrictive approval posture, all resolved into the
ordinary mission/policy model:

```bash
agentloop presets                 # list built-ins + config-defined presets
agentloop presets dep-update      # inspect the resolved scope and posture
agentloop run --preset dep-update # bounded dependency-update mission
```

Built-ins: `dep-update` (manifests/lockfiles only, `test` gate required,
push=never) and `test-coverage` (test dirs + runner configs only). Custom
presets live under `presets` in `agentloop.config.json`. Presets can only
tighten repo policy — widening paths or commands mid-run goes through the
normal scope-expansion approval gate. See
[docs/mission-presets.md](docs/mission-presets.md).

## Policy

Example `agentloop.policy.json` (valid JSON; mode values are `never`, `approval`,
or `always` where supported):

```json
{
  "allowLocalCommit": true,
  "allowPush": "approval",
  "allowPullRequest": "never",
  "allowNetwork": true,
  "maxMissionMinutes": 180,
  "maxRepairPasses": 4,
  "agentTimeoutMs": 600000,
  "allowedCommands": [["npm", "test"], ["npm", "run", "lint"]],
  "approvalRequiredCommands": [["npm", "publish"]],
  "protectedPaths": [".agentloop/**", "agentloop.policy.json", "agentloop.config.json", ".git/**", "**/*.env", "**/secrets/**"],
  "approvalTimeoutMs": 3600000,
  "maxConcurrentMissionsPerRepo": 2,
  "maxConcurrentMissions": 4
}
```

Arrays such as `protectedPaths` replace defaults; retain the runtime/config/Git
paths shown above when adding your own patterns. Use JSON without comments.

## Agent adapters

"Supported" means the adapter contract is exercised by the test suite (spawn/argv/exit/cancellation/bounded output) and the recovery e2e (`npm run test:e2e` runs a real packed install → crash → resume). It does **not** mean every vendor CLI has been smoke-tested on this machine — adapter coverage beyond the fake/custom agents is limited by which CLIs are installed.

| Adapter | Status |
|---------|--------|
| Qwen Code | contract-tested (argv-pinned) |
| Codex CLI | contract-tested; flags help-verified at CLI 0.155.1 |
| Claude Code | contract-tested (argv-pinned) |
| Devin CLI | contract-tested; flags help-verified at CLI 3000.10.31 |
| OpenCode | contract-tested (argv-pinned) |
| Gemini CLI | adapter shipped (contract-tested; no live smoke on this machine) |
| Aider | adapter shipped (contract-tested; no live smoke on this machine) |
| Custom argv | contract-tested + e2e-verified — any CLI agent |

Per-adapter argv/env/stdin conventions and verification tiers:
[docs/adapter-matrix.md](docs/adapter-matrix.md).

Codex uses `exec --sandbox workspace-write` instead of the legacy
`--full-auto` alias, which is absent from Codex CLI `0.155.1` help.
The sandbox stays enabled. Live Windows execution still depends on a
working Codex sandbox installation; adapter contract tests do not verify it.

Devin uses `--print <prompt> --permission-mode accept-edits` for one
non-interactive turn, with optional `--model`. These flags were checked
against Devin CLI `3000.10.31` help; this is not a live authenticated
mission verification. Workspace trust remains enabled: trust the mission
worktree through Devin before running there, or provide an explicit
operator-chosen `args` override. Actions beyond workspace edits remain
subject to Devin's permission checks and may fail in non-interactive mode.

Children receive closed stdin: prompts are passed in argv, not through an
interactive terminal. Configure each CLI for non-interactive operation. An
installed executable or passing `doctor` check does not prove it can edit a
mission worktree. Test a small disposable mission with a real content gate first;
inspect its agent log if sandbox setup or workspace trust fails. Do not disable
those controls to turn a failed check into a success.

On Windows, current npm-generated Node `.cmd` launchers are resolved to their
JavaScript entry point and invoked directly with Node. This preserves multiline
prompts, quotes and shell characters as literal arguments. The shim's adjacent
`node.exe` is used when present, otherwise the runtime's Node executable is used.
Bare CLI names are resolved from PATH; explicitly relative commands resolve from
the mission worktree. Other `.cmd`/`.bat` wrappers support only literal single-line
arguments without quotes, control characters or shell metacharacters. Configure a
native executable or a custom `node` plus entry-point argv for arbitrary prompts;
unknown batch wrappers are not silently reinterpreted as Node programs.
See [Node's Windows batch-file execution documentation](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
for why `.cmd` files need a different transport from native executables.

Custom agents use argv templates with validated placeholders — never shell strings:

```json
{
  "agents": [{
    "name": "my-agent",
    "type": "custom",
    "command": "myagent",
    "args": ["run", "--task", "{task}", "--dir", "{worktree}"]
  }]
}
```

Placeholders: `{objective}`, `{mission}`, `{task}`, `{worktree}`, `{repository}`.

## Daemon & control surfaces

```bash
agentloop daemon            # long-running scheduler + loopback API (127.0.0.1:3210)
agentloop daemon --socket /run/agentloop/ctl.sock   # or a Unix socket / Windows pipe instead of TCP
agentloop mcp               # MCP server over stdio
agentloop health --json     # machine-readable runtime health
```

The daemon recovers interrupted missions on start, enforces concurrency limits, and pauses (not kills) active missions on shutdown. The HTTP control API defaults to loopback and always requires a bearer token. Set `AGENTLOOP_API_TOKEN`, or use the generated credential in `.agentloop/daemon.json` after startup. Treat this file as secret; see [operator authentication and file permissions](docs/deployment-guide.md#control-api-v1-loopback). `daemon.socketPath`/`--socket` swaps the TCP listener for a Unix domain socket (POSIX) or named pipe (`\\.\pipe\<name>` on Windows) — same routes and auth, no TCP surface.

The frozen v1 HTTP contract (routes, envelopes, `?follow` NDJSON format, auth)
for ai-cli-editor and other consumers: [docs/control-api-contract.md](docs/control-api-contract.md).

MCP tools: `list_missions`, `inspect_mission`, `create_mission`, `pause_mission`, `resume_mission`, `cancel_mission`, `list_pending_approvals`. There is deliberately no "approve as human" tool — approvals stay with the operator.

## Migrating from Qwen Loop

An existing `qwen-loop.config.json` is detected automatically:

```bash
agentloop migrate
```

Writes `agentloop.config.json`, keeps the legacy file, and makes a `.bak` backup. Qwen Code remains a supported adapter — reproduce old behavior with `{"type": "qwen"}` in `agents`.

Notable behavior changes from Qwen Loop:

| Qwen Loop | Agent Loop Runtime |
|---|---|
| Infinite loop, `0 = forever` | Bounded missions with explicit budgets |
| Auto commit + push every task | Checkpoints configurable; push needs policy + approval |
| `.qwen/settings.json` yolo written into repos | No vendor config written into your repo |
| In-memory state, lost on crash | Atomic persisted mission + event log, resumable |
| `shell: true` spawning | argv-only execution |
| Agent declares success | Deterministic validation gates decide |

## Docs

See [`docs/`](docs/) for architecture, CLI reference, policy details, daemon/API/MCP contract, and the roadmap.

## License

MIT
