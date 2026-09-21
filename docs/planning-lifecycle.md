# Planning, budgets, and receipts

The CLI prepares and preflights a repository before invoking an agent planner.
Planning uses the prepared workspace, the runner's ownership lease, heartbeat,
cancellation signal, bounded output, and agent log. It is not a separate,
unaccounted provider call. The scheduler uses the same path.

`maxAgentInvocations` includes planning, implementation, and repair attempts.
Every attempt is debited and assigned an invocation ID before spawn; its PID is
recorded as soon as the process is spawned. A failed spawn, nonzero exit, invalid
plan, or timeout does not refund the attempt. A cap of one with planning enabled
leaves no invocation for implementation. Use `--no-plan` for one deterministic
implementation task, or budget for both planning and implementation.

Planning is limited by the smallest of 120 seconds, `agentTimeoutMs`, and the
remaining cumulative mission wall budget. An exhausted budget launches nothing.
The wall clock begins when the runner first starts and is retained across resume.
Preflight and workspace preparation do not invoke the planner.

Ordinary planner failures and invalid JSON produce a deterministic single-task
fallback. They do not make the mission successful: implementation still requires
budget admission, and the existing validation and review pipeline is unchanged.
Planner output can define task titles/dependencies, not permissions or budgets.

## Interruption and recovery

A paused or crashed planner is never automatically invoked again. Its attempt
remains spent, its pass is marked interrupted, and recovery selects the
deterministic fallback. A crash with no recorded exit keeps `agentExit` absent:
the outcome is unknown, not successful. Recovery audits the recorded PID using
the existing orphan-process checks. A cancelled planner ends the mission without
executing fallback work. Resume can run the fallback only when budget remains.

## Serialized compatibility

Mission and receipt schema version 1 have additive planning metadata. Older
records without `planning` retain their existing task graph and do not gain a
planner when run or resumed. Fresh scheduler-created objectives that need a plan
request it before preparation; already-prepared or preplanned missions are kept.

- Optional `planning` records `status` (`pending`, `running`, `resolved`, or
  `cancelled`), and when resolved, `source` (`agent` or `fallback`) plus an optional
  bounded error description.
- `passes[].kind` and `passes[].intent.kind` now also accept `plan`.
- Receipts carry planning metadata, pass notes, and interrupted/exit evidence.
  Consumers must not assume every pass implements a task or has validation gates,
  a review, or a checkpoint. A plan-only budget failure has none of those.
- Pass numbers remain sequential attempt numbers; the first implementation pass
  may be number 2. `usage.agentInvocations` includes the preceding planner debit.

No new mission state or approval bypass is introduced. A paused mission may move
to `prepared` after the existing recovery audit, then resume under a fresh lease.

The internal deep-import helper `engine/planner.planWithAgent` has been removed;
it was not exported by the package's public `index` entry point. Deep-import
consumers should request `planning: true` through `createMission`, call
`prepareMission`, and then use `MissionRunner`. `planFromResult` only validates
already-recorded output; it cannot spawn an unbudgeted process.
