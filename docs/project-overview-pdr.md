# Agent Loop Runtime — Product Overview

## Problem

Coding agents (Codex, Claude Code, Devin, Qwen Code, Gemini CLI, OpenCode, Aider, …) are useful but dangerous to run unattended: they mutate repositories, invoke shell commands, and declare their own success. Running one for hours historically meant either babysitting it or accepting repository chaos.

## Product

**Agent Loop Runtime** is a headless execution engine for coding agents. The unit of work is a persisted, bounded **Mission** — never an infinite loop.

A Mission has: objective, acceptance criteria, non-goals, repository + base SHA, agent configuration, policy snapshot, isolated workspace (Git worktree), budgets, task DAG, pass history, human approvals, checkpoints, usage accounting, and a final outcome + receipt.

## Positioning

| Layer | Tool |
|---|---|
| Execution engine (this product) | Agent Loop Runtime — missions, worktrees, policy, recovery, daemon |
| Separate terminal UI | AI CLI Editor — runtime mission status/event integration is not implemented yet |

The runtime is vendor-neutral: agent adapters are plugins behind a contract; no vendor concept leaks into the scheduler or mission model.

## Core guarantees

1. **No false completion** — empty task graphs fail; failed agent invocations fail tasks; only configured validation gates + review decide success.
2. **No silent remote mutation** — push/PR/merge require policy mode + explicit approval. Never force-push.
3. **Explicit process arguments** — native/Node processes receive argv; Windows batch wrappers use restricted literal transport. Agent output never becomes a command.
4. **Crash-safe** — atomic mission persistence; interrupted missions become `stale` and are recoverable, never assumed done.
5. **Bounded** — wall-time, agent invocations, repair passes, output, concurrency. Expired budgets → `blocked`/`failed`.
6. **Explicit approval evidence** — decisions persist across crashes and bind exact commands. Set `AGENTLOOP_APPROVAL_KEY` for integrity verification; unsigned local files alone do not prove a human decision. MCP does not expose approval as an agent tool.

## Non-goals

- Not a UI/editor (that's AI CLI Editor's job).
- Not a hosted service — local-first, loopback API only.
- Not an agent itself — it orchestrates external agent CLIs.
- Not automatic PR/merge machinery — merge is never automatic.
