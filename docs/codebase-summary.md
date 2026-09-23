# Codebase Summary

TypeScript ESM project (`"type": "module"`), locally verified on Node 24.14.1, compiled to `dist/`. Entry: `src/cli.ts` (`agentloop` bin) and `src/index.ts` (library API). Node 18 does not satisfy the locked dependencies.

## Layout

| Path | Purpose |
|---|---|
| `src/types.ts` | Canonical domain types: Mission, MissionState, TaskNode, Policy, ApprovalRequest, GateResult, AgentConfig |
| `src/cli.ts` | Commander CLI — all `agentloop` subcommands |
| `src/commands/` | CLI command implementations (`setup-`, `mission-`, `inspect-`, `clean-command.ts`) |
| `src/index.ts` | Public library exports |
| `src/agents/` | Adapter contract (`cli-adapter-base`), `vendor-adapters`, `custom-adapter`, `registry` |
| `src/supervisor/process-supervisor.ts` | argv spawn, bounded buffers, log streaming, timeout, tree-kill, exit classification |
| `src/git/` | `git-runner` (argv allowlist), `repo-inspector` (safety checks), `worktree-manager` |
| `src/policy/` | `policy` (schema/load/defaults), `command-safety` (classifier), `approvals` (persistent gates) |
| `src/mission/` | `state-machine`, `mission-store` (atomic persist + events), `receipt` |
| `src/engine/` | `mission-factory`, `mission-runner`, `planner`, `task-graph`, `validation-gates`, `reviewer`, `scheduler`, `admission-control`, `recovery` |
| `src/config/config-manager.ts` | `agentloop.config.json` load/validate + `qwen-loop.config.json` migration |
| `src/daemon/` | `daemon` (lifecycle, stale sweep, signal handling), `control-api` (loopback HTTP v1) |
| `src/mcp/mcp-server.ts` | MCP tools over stdio |
| `src/health/health.ts` | `agentloop health --json` report |
| `src/util/` | `atomic-file` (tmp+rename writes), `redact` (secret scrubbing, bounded tails) |
| `src/logger.ts` | Winston logger → `.agentloop/logs/` |
| `src/__tests__/` | node:test suite (fake agents, no vendor CLIs needed) |

## Mission state machine

`created → prepared → running → validating → completed`, with `paused`, `waiting_for_approval`, `repairing`, `blocked`, `failed`, `cancelled`, `stale`. Terminal states are immutable; illegal transitions throw `IllegalTransitionError`. Recovery transitions: `stale → prepared`, `waiting_for_approval → prepared` (re-drives the persisted gate decision).

## Conventions

- ESM imports use `.js` suffix on relative paths.
- All process execution goes through `process-supervisor` — never `exec`/`shell:true`.
- All git ops go through `git-runner` allowlist — never raw strings.
- All persisted writes are atomic (`writeJsonAtomic`, tmp+rename).
- Event payloads are bounded; secrets are redacted before logging.
- Files >200 lines should be modularized (see `commands/` split).
