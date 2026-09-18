# Design Guidelines

## Safety invariants (do not break)

1. **`shell: true` is forbidden** anywhere in the codebase. All spawning is argv arrays through `process-supervisor`.
2. **Git runs through `git-runner` only** — subcommand allowlist, no flag injection, no free-form args from agent output.
3. **Agent output is never executed.** Commands come from config (`validationCommands`), explicit CLI argv, or validated inline JSON argv — never parsed from agent/repository text.
4. **Success is earned, not declared.** A mission completes only when configured gates pass and review approves, or (with zero gates) every task succeeded and review approves. Empty task graphs fail.
5. **Policy is immutable by agents.** The mission snapshots policy at creation; planner/agent input cannot change it.
6. **Approvals are persistent and sticky.** Records live in `approvals.json`, survive crashes, carry structured `commands`, and once approved the same argv never re-asks for that mission.
7. **No implicit remote mutation.** `push`, `pull-request`, `merge` require policy mode + approval. Never force-push or rewrite protected branches.
8. **Bounded by default.** Every loop has a budget exit; every buffer has a cap; every process has a timeout + tree-kill.
9. **Atomic persistence.** Mission state writes are tmp+rename; events are append-only JSONL.
10. **Secrets never logged intentionally.** Route output through `redact`/`boundTail`.

## State machine rules

- Add states/transitions only via the table in `mission/state-machine.ts`; illegal transitions must throw.
- Terminal states (`completed`, `failed`, `cancelled`, `blocked`) stay immutable.
- Recovery (`stale`, `waiting_for_approval`) re-drives through `prepared`/the gate — never jumps to a success path.

## Adapter rules

- Adapters implement: `detect`, `version`, `buildInvocation`, `classifyExit`, cancellation support.
- No vendor concept may appear in `engine/`, `mission/`, `policy/`, or `types.ts` core records — vendor specifics live in `agents/` only.
- Unavailable CLIs get contract-tested with fixtures/fake agents, not skipped silently.

## Error handling

- Fail closed: unknown commands classify `needs-approval`; unknown config fields warn; corrupt persisted state fails the load, not the write path.
- Process failures produce honest `exitKind` — never coerce nonzero to success.

## Style

- Compact idiomatic TypeScript, no gratuitous try/catch at every line.
- Comments only where the *why* is non-obvious (e.g. sticky approvals, honest task status).
- Files >200 lines → split into kebab-case modules by concern.
