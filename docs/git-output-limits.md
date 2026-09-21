# Git output limits and incomplete inspection

## Compatibility notice

`inspectRepo()` is a public API. Its result now includes `inspectionComplete`
and an optional `inspectionError` with a stage and bounded message. On output
overflow, facts that could not be established are `null`, including later
uninspected booleans. Previously observed facts remain intact. Normal completed
inspection values are unchanged; TypeScript/JSON consumers must handle the
exceptional nullable values and check completeness before treating a repository
as clean, detached, unborn, or missing. This is not a release/version bump.

`inspectionComplete: true` means no output-overflow interruption was recorded;
it does **not** prove every ordinary Git command succeeded. Existing ordinary
Git error fallbacks remain. The field is an overflow-completeness signal, not
a general guarantee that every reported repository fact was verified.

Preflight blocks incomplete inspection in both worktree and in-place modes.
Doctor reports an incomplete repository check; health reports an error without
presenting unknown dirty state as clean. Initialization refuses incomplete
inspection before writing its configuration. Existing handling of ordinary Git
errors is otherwise unchanged.

## Transport and policy are different limits

Git subprocess capture has an 8 MiB **aggregate stdout plus stderr** byte ceiling.
This bounds retained output, not total process memory: decoding and buffer
concatenation require additional bounded allocations. It is independent of the
mission policy's `maxDiffBytes` (4 MiB by default), which evaluates a complete
diff after collection. A policy budget does not raise the transport ceiling.

The Git helpers retain their third positional timeout argument. An optional
fourth `{ maxOutputBytes }` argument can lower the ceiling; values must be
positive safe integers no greater than 8 MiB. There is no unlimited setting.
`inspectRepo` and `preflightRepo` also accept optional lower output limits for
bounded callers and tests.

Overflow throws `GitOutputLimitError`, a `GitError` subclass with `limitBytes`
and `observedBytes`. The error message and stderr do not contain captured diff
content. Successful results are never silently truncated. Both streams stop
retaining data after settlement, including timeout. The direct Git child is
signalled on overflow; this is not a process-tree termination guarantee.

Overflow propagates through optional Git helpers instead of becoming an empty
file list or worktree list. Deterministic review requests changes when inspection
is incomplete. Checkpoint overflow blocks the runner rather than allowing review
of an outdated HEAD to complete a mission. A Git mutation, including a commit,
may already have occurred before overflow: no rollback is claimed. Inspect the
worktree and event/state evidence before recovery. A checkpoint SHA/summary may
not have been recorded if its collection failed after the commit.

These changes address output overflow only; they do not claim every pre-existing
Git error fallback or list-size limit is a complete repository security audit.

## Complete path lists for hard review

Deterministic review uses `changedFilesStrict`, a complete path list bounded by
the transport ceiling, not the display helper's default 500-entry limit. It uses
raw `git diff --name-only -z --no-renames <base> <ref> --` output: no trimming,
newline splitting, or count truncation. Disabling rename detection includes both
the deleted source and added destination so protected-source changes remain
visible. Ordinary Git failures, overflow, and malformed NUL framing fail review
with `request-changes`; they are not empty successful inspections.

The existing `changedFiles(..., max)` display helper retains its bounded behavior
and must not be used for hard review or authorization. Textual Unicode names,
spaces, tabs, quotes and newlines are preserved by the strict helper. The current
transport decodes UTF-8; this is not byte-exact support for arbitrary non-UTF-8
POSIX filename bytes. Scope and protected-path matching rules are unchanged.
