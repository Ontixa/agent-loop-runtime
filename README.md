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

State is persisted atomically under `.agentloop/missions/<id>/` (mission.json + events.jsonl + agent logs). Crash the runtime — `agentloop resume` picks up safely; interrupted missions become `stale`, never falsely `completed`.

## Safety model

- **Worktree isolation by default** — each mission runs in `.agentloop/worktrees/<id>` on branch `agentloop/<id>`. In-place mode requires explicit `--in-place --approve-in-place`.
- **No unconditional push** — local checkpoint commits are configurable; push/PR/merge are policy-gated and require approval. Never force-push, never rewrite protected branches.
- **No shell execution** — agents, git, and validation commands spawn via explicit argv. No `shell: true`, no free-form command text from agent output.
- **Deterministic policy** — `agentloop.policy.json` decides what runs, what needs approval, and what is refused. Agents cannot modify their own policy.
- **Bounded everything** — mission wall-time, agent invocations, repair passes, output buffers, log files, concurrency. Limits expire to `blocked`/`failed`, never to infinity.
- **Secret hygiene** — known token patterns are redacted from logs and events.

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

| Adapter | Status |
|---------|--------|
| Qwen Code | supported |
| Codex CLI | supported |
| Claude Code | supported |
| Devin CLI | supported |
| OpenCode | supported |
| Gemini CLI | adapter shipped (untested — no local install) |
| Aider | adapter shipped (untested — no local install) |
| Custom argv | supported — any CLI agent |

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
