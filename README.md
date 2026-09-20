# Agent Loop Runtime

A headless runtime for running coding agents continuously, safely, reproducibly — with explicit human control boundaries.

> **How do I safely run coding agents for hours or days without turning my repository into chaos?**

Agent Loop Runtime answers that with a persisted **Mission** model: every run has an objective, an isolated Git worktree, a deterministic policy, bounded budgets, validation gates, human approval points, and a durable record you can inspect afterward.

Run Codex, Claude Code, Devin, Gemini CLI, Qwen Code, OpenCode, Aider, or any configured terminal coding agent under one mission, policy, and recovery model.

## Boundary

| | |
|---|---|
| **Agent Loop Runtime** | Headless execution engine — missions, worktrees, policy, recovery |
| **AI CLI Editor** | Human-facing cockpit/control surface — consumes the runtime's machine-readable mission status and events |

## Install

```bash
git clone https://github.com/tang-vu/agent-loop-runtime.git
cd agent-loop-runtime
npm install
npm run build
npm link        # puts `agentloop` on PATH
```

Requires Node.js 18+ and Git. Windows (PowerShell, Git for Windows) is a first-class target — no WSL needed.

## Quick start

```bash
cd your-repo

# 1. Scaffold config + policy files
agentloop init

# 2. Check environment (git, agents detected, config, policy)
agentloop doctor

# 3. Define acceptance criteria via validation commands in agentloop.config.json
#    (see Configuration below)

# 4. Run a mission — isolated worktree, bounded, resumable
agentloop run "Fix the date-parsing bug in src/parser.ts" \
  --criteria "npm test passes"

# 5. Inspect
agentloop missions
agentloop status <missionId>
agentloop logs <missionId>
agentloop report <missionId>          # human + --json receipt: passes, gates, recovery audit, outcome
```

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

Every mission carries: objective, acceptance criteria, non-goals, repository + base SHA, agent config, policy snapshot, workspace (worktree), budgets, task DAG, pass history, approvals, checkpoints, usage, and a final outcome with an execution receipt.

State is persisted under `.agentloop/missions/<id>/` (`mission.json` CAS + `mission.json.lock`, `events.jsonl` seq/id, `approvals.json`, `receipt.json`, bounded agent logs). Only a live lease-holder (pid + nonce + heartbeat) may write. Crash the runtime — `agentloop resume` audits what was interrupted (tasks, passes, orphaned agent pids, lost-work suspicion) and re-enters through `prepared`; interrupted work is retried with a partial-work warning, never marked done. A corrupt `mission.json` is reported as corrupt, never treated as missing.

## Safety model

- **Worktree isolation by default** — each mission runs in `.agentloop/worktrees/<id>` on branch `agentloop/<id>`. In-place mode requires explicit `--in-place --approve-in-place`.
- **No unconditional push** — local checkpoint commits are configurable; push/PR/merge are policy-gated and require approval. Never force-push, never rewrite protected branches.
- **No shell execution** — agents, git, and validation commands spawn via explicit argv. No `shell: true`, no free-form command text from agent output.
- **Deterministic policy** — `agentloop.policy.json` decides what runs, what needs approval, and what is refused. Agents cannot modify their own policy.
- **Bounded everything** — mission wall-time, agent invocations, repair passes, output buffers, log files, concurrency. Limits expire to `blocked`/`failed`, never to infinity.
- **Secret hygiene** — known token patterns are redacted from logs and events; `AGENTLOOP_*` runtime internals are scrubbed from agent child environments.
- **Approvals are exact** — a decision binds to the mission, the exact argv, the policy fingerprint, and the worktree. Approving `["node","-e"]` does not cover longer commands. Set `AGENTLOOP_APPROVAL_KEY` to require HMAC-signed decisions.
- **Honest recovery** — see [`docs/threat-model.md`](docs/threat-model.md) for what is enforced vs. detected vs. not claimed, and [`docs/fault-matrix.md`](docs/fault-matrix.md) for the verified fault-injection matrix.

## Validation gates

Acceptance is proven by deterministic commands you configure — not by the agent declaring "looks done".

```jsonc
// agentloop.config.json
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

## Policy

```jsonc
// agentloop.policy.json
{
  "allowLocalCommit": true,
  "push": "approval",            // never | approval | always
  "pullRequest": "never",
  "allowNetwork": true,
  "maxMissionMinutes": 180,
  "maxRepairPasses": 4,
  "agentTimeoutMs": 600000,
  "allowedCommands": [["npm", "test"], ["npm", "run", "lint"]],
  "approvalRequiredCommands": [["npm", "publish"]],
  "protectedPaths": [".agentloop/**", "**/*.env", "**/secrets/**"],
  "approvalTimeoutMs": 3600000,
  "maxConcurrentMissionsPerRepo": 2,
  "maxConcurrentMissionsGlobal": 4
}
```

## Agent adapters

"Supported" means the adapter contract is exercised by the test suite (spawn/argv/exit/cancellation/bounded output) and the recovery e2e (`npm run test:e2e` runs a real packed install → crash → resume). It does **not** mean every vendor CLI has been smoke-tested on this machine — adapter coverage beyond the fake/custom agents is limited by which CLIs are installed.

| Adapter | Status |
|---------|--------|
| Qwen Code | contract-tested |
| Codex CLI | contract-tested |
| Claude Code | contract-tested |
| Devin CLI | contract-tested |
| OpenCode | contract-tested |
| Gemini CLI | adapter shipped (contract-tested; no live smoke on this machine) |
| Aider | adapter shipped (contract-tested; no live smoke on this machine) |
| Custom argv | contract-tested + e2e-verified — any CLI agent |

Custom agents use argv templates with validated placeholders — never shell strings:

```jsonc
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
agentloop mcp               # MCP server over stdio
agentloop health --json     # machine-readable runtime health
```

The daemon recovers interrupted missions on start, enforces concurrency limits, and pauses (not kills) active missions on shutdown. The HTTP control API binds loopback only; set `AGENTLOOP_API_TOKEN` if you extend it.

MCP tools: `list_missions`, `inspect_mission`, `create_mission`, `pause_mission`, `resume_mission`, `cancel_mission`, `list_approvals`. There is deliberately no "approve as human" tool — approvals stay with the operator.

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
