# Code Standards

## Language & module system

- TypeScript, `"type": "module"` — relative imports carry `.js` extensions.
- Strict typing; domain types live in `src/types.ts` only.
- Node 18+ APIs; no platform-specific code outside guarded branches (Windows is first-class — always handle `.cmd`/`.exe` resolution via `toSpawnInvocation`).

## Process & command execution

- All child processes: `supervise()` in `src/supervisor/process-supervisor.ts`. Never `child_process.exec`, never `shell: true`.
- All git: `git-runner.ts` allowlisted argv. New git needs → extend the allowlist deliberately.
- Commands as `string[]` argv, never shell strings. JSON argv arrays are the only accepted text format for commands.

## Persistence

- JSON writes: `writeJsonAtomic` (tmp file + rename). Never bare `writeFileSync` for state.
- Event streams: append-only `.jsonl`, bounded payloads, redacted.

## Errors

- Domain errors: `IllegalTransitionError`, `GitError` — extend the pattern, don't invent ad-hoc strings for control flow.
- Fail closed on ambiguity (classify unknown → needs-approval; missing config → defaults, not guesses).

## Testing

- `node:test` via `npx tsx --test src/__tests__/*.test.ts`.
- Fake agents only (`node -e` scripts, custom adapter) — CI never requires vendor CLIs.
- Cover safety invariants: false-completion guards, approval stickiness, argv literalness, output bounds, illegal transitions.

## Commits

- Imperative, concise subjects focused on *why*. Never `chore:`/`docs:` prefixes for `.claude/` changes.
- No secrets in commits — `.agentloop/` is gitignored; keep it that way.

## Verification before done

1. `npx tsc --noEmit` clean
2. `npm run build` clean
3. `npx tsx --test src/__tests__/*.test.ts` green
4. Behavior change → end-to-end smoke mission in a temp repo (fake agent + real git)
