# Adapter compatibility matrix

Per-adapter audit of how `agentloop` invokes each vendor CLI: exact default
argv, env/stdin conventions, and an honest record of what is verified versus
merely wired. Default argv are pinned by `src/__tests__/adapter-contract.test.ts`
(and `headless-adapters.test.ts` for codex/devin) — a flag change fails the
suite until this doc is updated in the same commit.

## Verification tiers (used below)

| Tier | Meaning |
|---|---|
| **argv-pinned** | The adapter builds this exact argv and the contract test asserts it. No claim that the vendor CLI accepts or behaves accordingly. |
| **help-verified** | Flags checked against a specific vendor release's `--help`/docs (version noted). No live mission run. |
| **e2e-verified** | The full path (spawn → supervise → exit classification → recovery) ran in `npm run test:e2e`. Applies to the *mechanism*, via the custom adapter + fake agent — vendor CLIs themselves were not installed. |
| **live-verified** | A real mission ran against the real CLI on a maintainer machine. **No adapter holds this tier today.** |

## Shared transport contract (all adapters)

Every adapter produces `AgentInvocation { command, args, env? }`, launched by
`process-supervisor` (`src/supervisor/process-supervisor.ts`):

- **argv only** — `shell: false`, always. The prompt is a single argv entry;
  it is never concatenated into a shell line, so multiline prompts, quotes and
  metacharacters survive verbatim.
- **stdin closed** — `stdio: ['ignore', 'pipe', 'pipe']`. Prompts never arrive
  through a pipe; a CLI that requires interactive stdin cannot work headless.
- **cwd** — the mission worktree (`ctx.cwd`), or the repo root for in-place
  missions.
- **env** — `process.env` minus all `AGENTLOOP_*` runtime internals, overlaid
  with `agent.env` from config. Vendor credential env vars
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) pass through — they are the
  operator's choice, not the runtime's.
- **output** — stdout+stderr bounded in memory (64 KiB tail), full stream to a
  rotating log file (16 MiB cap).
- **timeout/kill** — per-invocation `agentTimeoutMs`, then process-tree kill
  (Windows: `SIGKILL` + `taskkill /T`; POSIX: detached process-group
  SIGTERM→SIGKILL).
- **exit classification** — supervisor classifies `success | failed | timeout
  | cancelled | spawn-error`; adapters currently defer to it (no adapter
  overrides `classifyExit`).
- **Windows transport** — an npm-generated Node `.cmd` shim is resolved to its
  JS entry point and run under Node directly (full argv semantics). Other
  `.cmd`/`.bat` wrappers go through `cmd.exe /d /s /v:off /c` with restricted
  literal quoting: single-line args without `"`, `%`, `!`, `^`, `&`, `|`,
  `<`, `>`, or control characters — anything else throws rather than
  misquoting (see `windows-invocation.ts`, `windows-invocation.test.ts`).

## Per-config overrides (all adapters)

`AgentConfig` fields every adapter honors (`src/agents/*`):

| Field | Effect |
|---|---|
| `command` | Executable name/path override (default: the candidate name below). |
| `args` | **Replaces** the default argv wholesale; `{placeholders}` substituted. |
| `additionalArgs` | Appended after the (default or overridden) argv; on vendor adapters the model flag trails it. |
| `model` | Appended as the adapter's model flag (see matrix). Ignored by `custom`. |
| `env` | Merged over the scrubbed environment for the child process. |

Placeholders (case-insensitive): `{prompt}`/`{objective}` → invocation prompt;
`{mission}` → mission id; `{task}` → task id; `{worktree}` → mission workspace
path; `{repository}` → same path (the worktree is the repo boundary the agent
sees; for in-place missions it is the repo root).

## The matrix

| Type | Binary | Default argv (`P` = prompt) | Model flag | Verification | Notes |
|---|---|---|---|---|---|
| `qwen` | `qwen` | `P --yolo -o text` | `-m` | argv-pinned | Flag set inherited from the original qwen-loop adapter; not re-verified against a current Qwen Code release. `--yolo` auto-approves all tool actions. |
| `codex` | `codex` | `exec --sandbox workspace-write --skip-git-repo-check P` | `-m` | help-verified (CLI `0.155.1`) | `exec` is the non-interactive mode; sandbox stays `workspace-write` (the legacy `--full-auto` alias is gone from `0.155.1` help). Live Windows runs still depend on a working Codex sandbox install — not verified by tests. |
| `claude` | `claude` | `-p P --output-format text --dangerously-skip-permissions` | `--model` | argv-pinned | `-p` print mode; `--dangerously-skip-permissions` bypasses all of Claude's tool gating — runtime policy is the only remaining gate. Flags not checked against a specific Claude Code release. |
| `devin` | `devin` | `--print P --permission-mode accept-edits` | `--model` | help-verified (CLI `3000.10.31`) | Print mode = one non-interactive turn. Workspace edits auto-accepted; other tool actions still hit Devin's permission checks and may fail headless. Workspace trust remains on — trust the worktree beforehand or override `args`. No live authenticated mission run. |
| `gemini` | `gemini` | `P --yolo` | `-m` | argv-pinned | Positional prompt + `--yolo` auto-approve. Not checked against a specific Gemini CLI release; no live smoke. |
| `opencode` | `opencode` | `run P` | `-m` | argv-pinned | `opencode run` is the vendor's non-interactive subcommand. No permission flags passed — whatever the CLI defaults to applies. Not checked against a specific release. |
| `aider` | `aider` | `--message P --yes-always --no-auto-commits` | `--model` | argv-pinned | `--yes-always` accepts all prompts; `--no-auto-commits` keeps git commits with the runtime's checkpoint machinery. Not checked against a specific release. |
| `custom` | `config.command` (required) | `config.args` template, else bare `P` | — (none) | argv-pinned + e2e-verified | The e2e path (spawn → crash → resume → validate) runs through this adapter against a Node fake agent. Template placeholders validated at config load and again at invocation. If the template has no `{prompt}`/`{objective}` entry the prompt is appended as the last arg. `command` must be a bare executable — shell metacharacters (`\|&;<>\$``) are rejected. |

Registry behavior (`src/agents/registry.ts`): type names match
case-insensitively; an unknown `type` falls back to the `custom` adapter when
`command` is configured, else it is a hard error.

## Safety honesty notes

- "argv-pinned" adapters ship without any vendor-release verification — the
  flags encode vendor conventions at the time of writing and may drift.
  Run a small disposable mission with a real content gate before trusting one.
- Vendor autonomy flags (`--yolo`, `--dangerously-skip-permissions`,
  `--yes-always`, `accept-edits`) deliberately grant the CLI full in-workspace
  authority for the duration of the invocation — mission scoping, protected
  paths, and command approval are enforced by the runtime's own gates and
  post-hoc diff review, not by the vendor CLI.
- Runtime policy and validation do not sandbox the agent process: a vendor CLI
  runs with the operator's OS-user authority over the worktree and whatever
  credentials its env carries.
