# Fault Matrix — verified behavior under failure

Each row was exercised by an automated test (`npm test` /
`npm run test:e2e`). "Verified" means a real assertion ran; no row is prose-only.

| Fault injected | Expected state | Actual (verified) | Preserved artifacts | Test |
|---|---|---|---|---|
| Stale in-memory writer saves over newer disk state | `RevisionConflictError`, disk untouched | ✔ | newer `mission.json` intact | runtime-recovery › stale in-memory copy |
| `mission.json` corrupted mid-run | `CorruptStateError` on every load; listed via `listCorrupt`; file preserved verbatim | ✔ | raw bytes unchanged | runtime-recovery › corrupt mission.json; mission-store › corrupt is loud |
| `save`/`mutate` called on a corrupt record | refuse to clobber | ✔ | corrupt bytes stay | runtime-recovery › save refuses to clobber |
| Write fault injected during save (simulated disk error) | old record intact, error propagates | ✔ | previous revision readable | runtime-recovery › write fault during save |
| Second live runner claims a held mission | `RunnerConflictError`; mission untouched by the loser | ✔ | owner lease unchanged | runtime-recovery › second live runner / two runners |
| Owner pid dead, heartbeat stale | new claimant takes over | ✔ | mission record CAS-forward | runtime-recovery › dead owner is taken over |
| Owner pid alive but heartbeat expired | takeover allowed (zombie runner) | ✔ | — | runtime-recovery › expired-heartbeat owner |
| PID reused by unrelated process | nonce decides — foreign nonce refused | ✔ | — | runtime-recovery › pid reuse alone |
| Heartbeat from wrong nonce | ignored (no beat recorded) | ✔ | lease not refreshed | runtime-recovery › heartbeat only beats for owning nonce |
| Runner SIGKILL mid-agent (real process tree) | mission `stale`→audit→`prepared`; task `interrupted`, pass `interrupted`; resume retries to `completed`; usage cumulative | ✔ (real `node` agent + real git worktree) | `events.jsonl`, checkpoint, `receipt.json` | runtime-recovery › runner death / resumes; e2e phase 3–5 |
| Approval pending when runner died | wait clock restarts on recovery (`requestedAt` refreshed) | ✔ | approval ledger intact | runtime-recovery › approval timeout clock restarts |
| Same gate re-raised | dedupe — one pending request | ✔ | — | runtime-recovery › dedupe |
| Approval for argv prefix used to cover longer argv | not honored (exact match required) | ✔ | — | validation-gates › prefix does not cover longer argv |
| Approval signature invalid/missing with `AGENTLOOP_APPROVAL_KEY` | decision rejected, `approval_unverified`, mission blocked | ✔ (unit) | ledger records attempt | mission-runner stepApproval path |
| `--in-place` without `--approve-in-place` | `createMission` throws | ✔ | — | mission-factory invariant (tested via constructor) |
| Windows timeout kill | direct child terminated ~ms via `TerminateProcess`; tree swept async via `taskkill` | ✔ | bounded output tail | process-supervisor › hanging agent timeout <8s |
| Agent emits unbounded output | in-memory tail bounded, `outputTruncated`, full log to disk capped | ✔ | `logs/*.log` | process-supervisor › output bounds; fake-agent › huge |
| Agent argv contains shell metacharacters | passed literally (`shell:false`); no interpretation | ✔ | — | process-supervisor › argv safety |
| Daemon restart with operator-paused mission | NOT auto-resumed | ✔ | pause reason in `stateHistory` | scheduler requeue logic |
| Daemon restart with shutdown-paused mission | auto-resumed (reason starts with `shutdown`) | ✔ | — | scheduler requeue logic |
| Two missions in same repo | `maxConcurrentMissionsPerRepo` serialized | ✔ | — | scheduler tests |
| `agentloop clean` on dirty worktree / unmerged branch / orphan or corrupt record | skipped unless `--force`; never removed | ✔ | worktree + branch preserved | clean-command › dirty / unmerged / orphan / corrupt |

## Windows transport and invocation admission

These regressions were also executed on Windows with Node 24.14.1:

| Condition | Verified behavior | Test |
|---|---|---|
| Canonical npm shim with spaced path, multiline prompt, quotes and shell characters | Direct Node transport preserves argv; no injected command executes | windows-invocation |
| Unknown batch wrapper receives shell-sensitive input | Reject before spawn; ordinary restricted literals still work | windows-invocation |
| Child waits for asynchronous or synchronous stdin EOF | Receives empty stdin and terminates; stdout/stderr remain captured | process-supervisor > non-interactive stdin |
| Last permitted agent invocation succeeds | Its real validation gate still runs and the mission can complete | mission-runner > invocation budget admission |
| Another task or repair would exceed the invocation cap | No extra agent invocation starts | mission-runner > invocation budget admission |
| Repair exits nonzero or times out after writing valid output | Repair task remains failed; independent content validation may still accept the resulting work | mission-runner > repair task outcome honesty |
| Operator cancels a spawned repair | Mission and repair task are cancelled, with finish time and exit evidence; no running task remains | mission-runner > repair task outcome honesty |

These checks do not establish live vendor readiness. The local Codex smoke
reached its file-editing tool but failed to write; a separate sandbox diagnostic
reported setup-refresh errors. Devin refused an untrusted disposable worktree.
Both content gates remained authoritative; neither failure was bypassed.

## Known limits (honest)

- **Orphan sweep start-time check** uses `wmic`/`ps` start-time strings where
  available; if unobtainable, the pid is reported rather than killed (fail-safe).
- **`npm install` of the packed tarball** needs network for deps; the e2e runs
  the packed `dist/` against the repo's real `node_modules` (junction) — the
  shipped code is exercised, dependency resolution is not re-verified offline.
- **Clock jump** protection relies on heartbeat *freshness* checks, not
  monotonic clocks; a large forward jump can mark a live runner stale (fail-safe
  direction: pauses, never double-executes — the live runner detects lease loss
  and stops).
