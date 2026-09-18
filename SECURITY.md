# Security Policy

## Threat model

Agent Loop Runtime treats the following as **untrusted**:

- Repository content (may contain malicious scripts, hooks, or text)
- Agent output (never parsed into commands or success claims)
- Planner output (schema-validated before use)
- Agent processes (supervised, bounded, tree-killable)

Specific threats designed against: prompt injection, malicious package scripts, path traversal, symlink escape, git hooks, unsafe shell, secret exfiltration into logs, agents attempting to modify policy or the mission ledger, malicious terminal escape sequences in output.

## Built-in controls

- **argv-only execution** — no `shell: true` anywhere; agent text cannot become a command
- **Git worktree isolation** — missions run in `.agentloop/worktrees/<id>`, never silently in your dirty tree
- **Deterministic policy** — `agentloop.policy.json` classifies commands (allowed / needs-approval / refused); agents cannot modify it or the mission ledger
- **Human approval gates** — dangerous commands, push, PR, scope expansion require persisted operator approval; no MCP tool can grant approval
- **Protected paths** — `.agentloop/**`, `*.env`, secrets dirs are flagged by the reviewer
- **Bounded execution** — budgets, timeouts, output caps, tree-kill on all supervised processes
- **No implicit remote mutation** — push/PR/merge are off or approval-gated; never force-push
- **Secret redaction** — known token patterns are scrubbed from logs and events

## Residual risks (operator responsibilities)

1. An approved dangerous command runs with your user privileges — review `agentloop status <id>` approval details before `agentloop approve`.
2. Agents can still write arbitrary code inside the worktree — the diff is on branch `agentloop/<id>`; review before merging.
3. `--in-place` mode runs the agent in your working tree — only use with `--approve-in-place` on a clean, committed tree.
4. Secrets in files the agent legitimately reads may appear in its context — keep them out of the repo or under protected paths.
5. Agent CLIs are external tools with their own permission models — the runtime bounds the process, not the model's judgment.

## Reporting a Vulnerability

If you discover a security vulnerability:

1. **Do not** open a public issue
2. Report privately to the repository maintainer
3. Include reproduction steps and affected version
