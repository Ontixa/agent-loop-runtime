# Agent working notes

## Workflow

- After each completed update on a work branch, open a PR to `main` and merge
  it (user instruction, tang-vu, 2026-09). Do not leave branches unmerged
  unless the user asks for review first.

## Verification

- `npm run build` — TypeScript compile
- `npm test` — unit/contract suite (`tsx --test src/__tests__/*.test.ts`)
- `npm run test:e2e` — packed-artifact acceptance: pack → unpack → fixture
  repo → run → SIGKILL mid-agent → resume → validate → report

## Conventions

- Conventional Commits; stage specific paths; never push to `main` directly.
- No push/merge/publish from inside a mission or the acceptance path.
- Windows-native Git/GitHub only — no WSL for repo operations.
