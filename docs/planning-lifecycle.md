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

## Planner output schema

Planner output is untrusted agent text. `validatePlan` accepts only a non-empty
JSON array (max 12 tasks) of objects with these fields — everything else is
ignored, never interpreted:

- `title` — required, non-empty, ≤ 2000 chars, unique across the plan
  (title-based dependencies would otherwise be ambiguous);
- `dependsOn` — optional array of 1-based indices or titles of earlier tasks;
- `paths` — optional array of repo-relative paths the task intends to touch
  (absolute paths, drive qualifiers, `..`/`.` segments, and NUL bytes are
  rejected);
- `commands` — optional array of argv arrays the task needs to run.

Aggregate declarations are capped (100 distinct paths / 50 distinct commands per
plan; 40 paths / 20 commands per task; bounded field lengths). Every violation
is collected into a `PlanValidationError` with the complete issue list in
deterministic order — the rejection never depends on which check happens to
fire first. Graph integrity (dependency existence, self-dependencies, cycles,
a runnable root) is verified after entry validation. A rejected plan resolves
to the deterministic fallback with the error recorded in `planning.error` and
the pass note; fallback plans carry no scope requests, so malformed output can
never smuggle an expansion request through the fallback path.

## Declared scope requests and the scope-expansion gate

`paths`/`commands` are *requests*, not grants. After a clean agent plan, the
runner compares the declared requests against the mission's approved envelope —
`spec.scope` for paths and `policy.allowedCommands` for commands — plus every
already-granted scope-expansion decision. Only the uncovered remainder is
gated: before any task executes, the mission moves to `waiting_for_approval`
with a persisted `scope-expansion` request carrying the exact path set and argv
set under decision, bound to the mission id, policy fingerprint, and worktree.
Approving widens the envelope by exactly those items for this mission only;
denial blocks the mission (`approval denied`), and an unanswered request times
out to `blocked` with the request still pending — a timeout is never a
decision. Re-driving a blocked mission re-raises the same uncovered gate; a
denied decision is never resurrected.

The same gate fires at validation time when the actual diff touches paths
outside the approved envelope — including `protectedPaths` — regardless of what
the plan declared. The review reports the exact violating paths and the
request is bound to them; an approval is a recorded operator override for those
paths only (requests are capped at 500 paths per gate; the remainder re-gates
on re-review). A grant for a directory entry covers its children; it never
covers siblings or other paths.

Scope-expansion decisions obey the same integrity rules as command approvals:
exact binding, no prefix bleed, and signature verification when
`AGENTLOOP_APPROVAL_KEY` is configured — an unsigned or forged ledger entry
grants nothing. Approved grants are visible in `approvals.json`, the mission
summary `pendingApprovals` (with `paths`/`commands`), the event stream, and the
mission receipt.

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
