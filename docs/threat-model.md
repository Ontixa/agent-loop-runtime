# Threat Model — Agent Loop Runtime

Git subprocess output has an aggregate 8 MiB capture ceiling. Overflow is
explicit incomplete evidence, never a truncated successful inspection; preflight
blocks, review requests changes, and checkpoint overflow blocks the runner.
See [Git output limits and compatibility](git-output-limits.md) for exceptional
nullable inspection fields, caller behavior, and direct-child termination and
post-mutation limitations.

Scope: what the runtime **enforces**, what it **detects**, and what it **does not**
claim to prevent. Nothing below is aspirational — each line maps to code or a test.

## Trust boundaries

| Boundary | What crosses it | Enforcement |
|---|---|---|
| Operator → runtime | CLI/API/MCP commands, approval decisions | daemon API: bearer token (auto-generated per-daemon when not configured), `Host` allowlist, CORS off by default (`daemon.corsOrigins` opt-in), loopback-only default bind; optional Unix-socket/named-pipe transport (`daemon.socketPath`, POSIX file mode 0600) — narrows network exposure, NOT a substitute for the token |
| Runtime → agent CLI | argv + scrubbed env + cwd=worktree | native/Node argv with `shell:false`; restricted literal batch transport on Windows; `AGENTLOOP_*` env stripped; bounded output, timeout, cancellation |
| Agent → workspace | file edits inside the worktree | git worktree isolation; `protectedPaths` (`.agentloop/**`, policy/config files, `.git/**`) audited at validation time |
| Agent → repo (git) | commits on the mission branch | `allowLocalCommit` default true; `allowPush`/`allowPullRequest` = `approval`; `allowMerge` = `never` |
| Runner → mission state | persisted transitions | exclusive-create `mission.json.lock`, CAS `revision`, runner lease (pid + nonce + heartbeat); subject to the lock-reclamation limitations below |

## What is enforced (P0)

- **Single executor per mission.** `MissionStore.claimForRun` takes a lease under
  the mission lock: pid + random nonce + heartbeat. A second live runner is
  refused (`RunnerConflictError`). A dead/expired owner is taken over only by a
  new claimant — never shared.
- **No stale-writer clobber.** All mutation goes through `mutate()` under the
  file lock with a revision compare-and-swap. A process holding an old in-memory
  mission cannot overwrite newer disk state (`RevisionConflictError`).
- **Corruption is loud, never blank.** An unparseable `mission.json` throws
  `CorruptStateError` on every read path, is preserved byte-for-byte, is
  reported by `listCorrupt()`/`missions`/health, and is never overwritten by
  `save`/`mutate`/`transition`. The approvals ledger follows the same
  contract: a corrupt or malformed `approvals.json` throws
  `CorruptApprovalsError` and is never read as "no approvals" or silently
  rewritten — a wiped ledger is not a decision.
- **Interruption is honest.** Invocation intent and agent pid are persisted
  *before* spawn. A runner lost mid-task leaves `task.interrupted: true` +
  open pass marked `interrupted` — outcomes are recorded as *unknown*, never
  silently completed. Missing worktree + uncheckpointed work →
  `lostWorkSuspected`, reported, not hidden.
- **Approvals are bound, not prefix-shaped.** A decision covers the exact argv
  it was shown, the mission id, the policy fingerprint, and the worktree.
  Approving `["node","-e"]` does not cover `["node","-e","rm()"]`.
  With `AGENTLOOP_APPROVAL_KEY` set, unsigned or bad-signature decisions are
  rejected (`approval_unverified` → blocked) — both at the waiting step and
  again when the decision is consumed. The waiting step also fails closed on
  ledger integrity: a corrupt file, an empty ledger, or a ledger that lost a
  gate the mission recorded blocks the mission — resuming requires a real
  decision entry, never an absent file.
- **Scope expansion is explicit and exact.** The mission envelope —
  `spec.scope` paths and `policy.allowedCommands` — is fixed at creation.
  Planner output may *declare* paths/commands beyond it, and the diff may
  *touch* paths beyond it (including `protectedPaths`); either way the
  uncovered remainder pauses on a persisted `scope-expansion` approval bound
  to the exact paths/argv. Approval widens the envelope by only the listed
  items; denial or timeout fails closed (blocked) with the envelope unchanged,
  and re-driving re-raises the gate. Unsigned/forged grants widen nothing.
- **Planner output is schema-bound.** Only `title`/`dependsOn`/`paths`/
  `commands` are interpreted; every violation is reported in a deterministic
  issue list. Malformed plans fall back to a single deterministic task with
  no declared requests — a broken plan cannot smuggle scope through fallback.
- **In-place is a double flag.** `--in-place` alone is refused; both
  `--in-place` and `--approve-in-place` are required (enforced in
  `createMission`, not just the CLI).
- **Budgets are cumulative across resume.** `usage.agentInvocations`,
  `repairPasses`, and wall time are persisted. Invocation limits gate new
  attempts, not validation of the last permitted attempt; wall time is checked
  between steps. A crash does not reset spend. Approval wait time is tracked separately
  (`approvalWaitMs`) and reported.
  Planning is a counted `plan` attempt under the runner lease, after repository
  preflight/workspace preparation. Its timeout also respects the remaining wall
  budget. Interrupted planning keeps unknown/interrupted evidence and resolves to
  deterministic fallback without another planner call; see
  [planning lifecycle](planning-lifecycle.md) for the additive receipt fields.
- **No auto push/merge/publish.** Policy defaults make push/PR approval-gated
  and merge impossible; acceptance paths never invoke them.

### File-lock recovery limits

Lock age alone never authorizes takeover. A stale lock is eligible for automatic
reclamation only with a valid positive-integer PID and runtime-format nonce,
and an owner probe that specifically reports `ESRCH` (no such process).
Live PIDs, permission/unknown probe errors and malformed owner records fail
closed. PID reuse can conservatively prevent recovery. Persistent filesystem
errors surface without entering the protected callback; contention retries use
a monotonic deadline and bounded backoff. This does not put a hard deadline on
individual blocking OS calls or on the protected callback itself.

The record and file identity are reread before reclaiming a dead owner's lock.
**This is not atomic compare-and-unlink:** concurrent reclaimers or external
file replacement can still race that check. These filesystem locks are not
claimed to provide race-free reclamation; CAS/lease guarantees depend on lock
exclusion. Stronger reclamation requires a separately reviewed protocol or OS
locking primitive. The file descriptor is closed before entering the callback;
Windows open-handle deletion behavior is not the exclusion mechanism.

A crash while creating an owner record can leave an incomplete lock that needs
operator investigation, not age-based eviction. Before manually recovering an
unknown lock, stop competing writers and inspect the exact lock and mission
state. This patch adds no automatic force-unlock or new operator command.

## What is detected (not prevented)

- **Agent writing outside its worktree.** The agent process is a real OS
  process with the user's ambient permissions — the runtime does not sandbox
  it (no job object / seccomp). `protectedPaths` violations and out-of-scope
  edits are detected at validation/checkpoint time and surface in the report,
  but a hostile agent CLI could touch the wider filesystem while running.
  Treat agent CLIs as *untrusted code with user-level rights*: the worktree is
  an isolation and audit boundary, not a security container.
- **Side-effecting commands inside the agent.** The runtime gates *validation
  gates* and *runtime-invoked* git ops; it cannot see commands the agent CLI
  runs internally. Agents that shell out are outside policy enforcement.
- **PID reuse on orphan reaping.** Recorded agent pids are only killed after a
  start-time sanity check (`procStartIso`); a pid that fails the check is
  reported, not killed.

## What is explicitly not claimed

- Exactly-once agent actions. Intent records + event ids make retries
  *detectable and auditable*; an agent invocation interrupted between "did the
  work" and "recorded the outcome" is marked `interrupted` and retried with a
  partial-work warning — never deduped away.
- Sandbox-level isolation (see above).
- Arbitrary batch-file argument fidelity. Current canonical npm Node shims bypass
  `cmd.exe` and preserve arbitrary argv. Unknown batch wrappers may reinterpret
  arguments internally; the runtime rejects quotes, control characters and shell
  metacharacters for that transport. Use a native executable or explicit Node
  entry point for agent prompts. The batch file itself remains trusted executable
  code, not a security boundary.
- Defense against a malicious operator (approvals trust the configured
  `AGENTLOOP_APPROVAL_KEY` holder and local file permissions).
