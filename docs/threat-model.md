# Threat Model — Agent Loop Runtime

Scope: what the runtime **enforces**, what it **detects**, and what it **does not**
claim to prevent. Nothing below is aspirational — each line maps to code or a test.

## Trust boundaries

| Boundary | What crosses it | Enforcement |
|---|---|---|
| Operator → runtime | CLI/API/MCP commands, approval decisions | daemon API: bearer token (auto-generated per-daemon when not configured), `Host` allowlist, CORS off by default (`daemon.corsOrigins` opt-in), loopback-only default bind |
| Runtime → agent CLI | argv + scrubbed env + cwd=worktree | native/Node argv with `shell:false`; restricted literal batch transport on Windows; `AGENTLOOP_*` env stripped; bounded output, timeout, cancellation |
| Agent → workspace | file edits inside the worktree | git worktree isolation; `protectedPaths` (`.agentloop/**`, policy/config files, `.git/**`) audited at validation time |
| Agent → repo (git) | commits on the mission branch | `allowLocalCommit` default true; `allowPush`/`allowPullRequest` = `approval`; `allowMerge` = `never` |
| Runner → mission state | persisted transitions | exclusive `mission.json.lock`, CAS `revision`, runner lease (pid + nonce + heartbeat); a non-owner cannot write |

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
  `save`/`mutate`/`transition`.
- **Interruption is honest.** Invocation intent and agent pid are persisted
  *before* spawn. A runner lost mid-task leaves `task.interrupted: true` +
  open pass marked `interrupted` — outcomes are recorded as *unknown*, never
  silently completed. Missing worktree + uncheckpointed work →
  `lostWorkSuspected`, reported, not hidden.
- **Approvals are bound, not prefix-shaped.** A decision covers the exact argv
  it was shown, the mission id, the policy fingerprint, and the worktree.
  Approving `["node","-e"]` does not cover `["node","-e","rm()"]`.
  With `AGENTLOOP_APPROVAL_KEY` set, unsigned or bad-signature decisions are
  rejected (`approval_unverified` → blocked).
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
