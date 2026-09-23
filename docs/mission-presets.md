# Mission presets

Named, strict-scope templates for recurring maintenance work. A preset resolves
into an ordinary `MissionSpec` plus a **tightened** `Policy` snapshot at
mission-creation time — everything after that (validation-gate classification,
deterministic review, scope-expansion approvals, budgets, recovery) is the
existing machinery. Presets are not a parallel permission system.

```bash
agentloop presets                      # list available presets
agentloop presets dep-update           # inspect the resolved scope/budgets/posture
agentloop presets dep-update --json    # machine-readable resolution

agentloop run --preset dep-update
agentloop run "bump only patch releases" --preset dep-update   # objective override
agentloop run --preset dep-update --criteria "lockfile diff stays small"  # extra criteria
```

## Built-in presets

| Preset | Scope | Gates | Budgets | Posture |
|---|---|---|---|---|
| `dep-update` | dependency manifests + lockfiles (npm, pnpm, yarn, pip/poetry, cargo, go, bundler, composer, maven/gradle) | requires `test` | 60 min, 6 invocations, 2 repair passes, 15 min/agent call | push=never, PR=approval |
| `test-coverage` | test dirs (`test/`, `tests/`, `spec/`, `e2e/`, `__tests__/`, …) + test-runner configs + manifests carrying test scripts | requires `test` | same | push=never, PR=approval |

Both ship a deterministic task list — no planner invocation is spent unless a
preset sets `planning: true` (and `--no-plan` still wins over that).

## Merge semantics — presets can only tighten

A preset merges **restrictively** over the repo's resolved policy:

- **Budgets** (`maxMissionMinutes`, `maxRepairPasses`, `maxAgentInvocations`,
  `maxDiffBytes`, `agentTimeoutMs`) and `approvalTimeoutMs`: `min()` — the
  tighter bound wins. `--max-minutes` clamps further, never past the preset.
- **`allowPush` / `allowPullRequest`**: stricter mode wins
  (`never` < `approval` < `always`). A preset can forbid push; it can never
  enable push where repo policy forbids it.
- **`allowLocalCommit` / `allowNetwork`**: AND — either side may deny.
- **`protectedPaths`, `approvalRequiredCommands`, `dangerousCommandPatterns`**:
  union — a preset may add prohibitions, never remove repo ones.
- **`allowedCommands`**: the mission's command envelope is *exactly* the
  preset's `allowedCommands` plus the argv of its required validation gates.
  The repo allowlist is **not** inherited — that is what makes the scope
  strict. Commands outside the envelope classify `needs-approval` and raise
  the existing approval gates.
- **`scope`**: becomes `spec.scope` verbatim. The deterministic reviewer flags
  any diff path outside it, and the scope-expansion approval gate is the only
  way to widen the envelope mid-mission (per exact path, audited).

## Required validation gates

`requiredGates` names entries in `validationCommands`
(`agentloop.config.json`). Resolution **fails before the mission exists** if a
required gate is unconfigured — a preset that cannot run its own verification
never runs at all:

```json
{
  "validationCommands": { "test": ["npm", "test"], "build": ["npm", "run", "build"] }
}
```

The resolved gate argv is added to the mission's command envelope so required
gates can always execute. When `requiredGates` is omitted entirely, the normal
default applies (all configured validation commands run; those outside the
envelope gate on approval). An explicit `requiredGates: []` runs no gates.

## Config-defined presets

Add custom presets under `presets` in `agentloop.config.json`. The map key is
the name (lowercase kebab-case); a key matching a built-in **shadows** it.

```json
{
  "presets": {
    "lint-fix": {
      "description": "Resolve lint findings only",
      "objective": "Fix all lint findings in src/",
      "scope": ["src/"],
      "acceptanceCriteria": ["lint gate passes"],
      "requiredGates": ["lint"],
      "allowedCommands": [["npm", "run", "lint"]],
      "tasks": ["Run lint", "Fix findings"],
      "budget": { "maxMissionMinutes": 20, "maxAgentInvocations": 4 },
      "approvals": { "allowPush": "never" }
    }
  }
}
```

Fields: `objective`, `description`, `scope`, `nonGoals`,
`acceptanceCriteria`, `requiredGates`, `tasks`, `allowedCommands`,
`protectedPaths`, `riskConstraints`, `budget`, `approvals`, `planning`.
`agentloop doctor` reports malformed entries; `agentloop presets <name>`
shows the resolution error in context.

Scope entries must be clean repo-relative paths (no absolute paths, drive
letters, `.`/`..` segments); entries are directory prefixes — `src/` covers
`src/a.ts` but never `srcfoo/a.ts`.

## Failure behavior

- Unknown preset → exit 2, available names listed, no mission created.
- Missing required gate → exit 2 naming the gates and where to configure them.
- Preset with no objective → exit 2 unless a positional objective is passed.
- Preset with no acceptance criteria → exit 2 unless `--criteria` is given.
- Out-of-scope diff paths or out-of-envelope commands → `scope-expansion` /
  `dangerous-command` approval gates; denial or timeout blocks the mission.
