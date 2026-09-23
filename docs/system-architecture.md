# System Architecture

## Component map

```text
┌────────────────────────── surfaces ──────────────────────────┐
│  CLI (src/cli.ts)   daemon HTTP API (:3210)   MCP (stdio)    │
└──────────────┬──────────────┬───────────────────┬────────────┘
               │              │                   │
        commands/        daemon/              mcp/
               │              │                   │
               └──────────────┴───────┬───────────┘
                                      ▼
                            engine/scheduler.ts
         (global + per-repo concurrency, fair ordering, host-pressure admission)
                                      │
        ┌─────────────────────────────┼──────────────────────────┐
        ▼                             ▼                          ▼
 engine/mission-runner.ts      engine/recovery.ts          engine/planner.ts
 execute→validate→review→      stale detection +           spec → task DAG
 repair state machine          resume logic                (schema-validated)
        │                             │
        ▼                             ▼
 mission/mission-store.ts  ←──  mission/state-machine.ts
 atomic JSON + events.jsonl       legal transition table
        │
        ├── engine/validation-gates.ts   (deterministic gates, policy-classified)
        ├── engine/reviewer.ts           (deterministic diff review)
        ├── git/worktree-manager.ts      (.agentloop/worktrees/<id>)
        ├── git/git-runner.ts            (argv-only, subcommand allowlist)
        ├── git/repo-inspector.ts        (dirty/detached/unborn/collision checks)
        ├── supervisor/process-supervisor.ts  (argv spawn, tree-kill, bounds)
        ├── agents/ (registry, vendor adapters, custom argv adapter)
        ├── policy/policy.ts + command-safety.ts + approvals.ts
        └── config/config-manager.ts     (agentloop.config.json + legacy migration)
```

## Data flow

1. `agentloop run` → `mission-factory` preflights the repo (dirty/detached/unborn/collision), snapshots policy, creates worktree + branch `agentloop/<id>`, persists `created → prepared`.
2. Planner (optional) turns the spec into a validated task DAG — planner output is untrusted and schema-checked (`PlanValidationError` lists every violation); it cannot touch policy/budget. A plan may *declare* needed paths/commands — declarations beyond the approved envelope pause on an exact-bound `scope-expansion` approval before any task executes (`engine/scope-expansion.ts`).
3. Runner `stepExecute` → adapter spawns agent argv in the worktree via `process-supervisor` (bounded tail, streamed log file, timeout, cancel, tree-kill). Exit classifies to `success | nonzero | timeout | cancelled | spawn-error` — only `success` completes a task.
4. `stepValidate` resolves gates from mission spec + `agentloop.config.json` `validationCommands`, classifies each argv through `command-safety`, executes allowed ones, collects `needsApproval` ones → `waiting_for_approval`. Persisted approved `commands` make re-validation run them (sticky approval).
5. Deterministic reviewer inspects the diff (protected paths, size, leftover markers). Verdict drives bounded repair passes (`maxRepairPasses`) or completion.
6. Outcome persisted + `receipt.json` written.

## Persistence layout

```text
repo/
├── .agentloop/
│   ├── missions/<mission-id>/
│   │   ├── mission.json        # atomic snapshot (state machine record)
│   │   ├── events.jsonl        # append-only structured events
│   │   ├── approvals.json      # pending/decided approval records
│   │   ├── receipt.json        # portable execution receipt
│   │   └── agent-pass-*.log    # bounded streamed agent output
│   ├── worktrees/<mission-id>/ # isolated mission checkout
│   └── daemon.json             # pid/url/status of running daemon
├── agentloop.config.json       # agents, validationCommands, daemon opts
└── agentloop.policy.json       # deterministic safety policy
```

`.agentloop/` is gitignored automatically. Agents cannot reach outside their worktree; protected paths (incl. `.agentloop/**` by default) are flagged by the reviewer.

## Control surfaces

- **CLI** (`src/cli.ts` + `src/commands/`): operator interface.
- **HTTP API** (`daemon/control-api.ts`): loopback JSON API v1 for AI CLI Editor and automation; token via `AGENTLOOP_API_TOKEN` when bound beyond loopback.
- **MCP** (`mcp/mcp-server.ts`): newline-delimited JSON-RPC tools over stdio. No approve-as-human tool by design.

## Trust boundaries

| Untrusted | Consequence |
|---|---|
| Repository content | Never executed without config/policy; protected paths enforced |
| Agent output/text | Logged (redacted), never parsed into commands or success claims |
| Planner output | Schema-validated; cannot modify policy/budget/permissions |
| Agent processes | argv-spawned in worktree, timeout + tree-kill supervised |
