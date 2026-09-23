# Project Roadmap

## v0.1 — foundation (current)

- [x] Vendor-neutral Mission model + state machine + atomic persistence
- [x] Worktree isolation, argv-only git, repo safety preflight
- [x] Process supervisor: bounded output, timeouts, tree-kill, exit classification
- [x] Policy engine: command classification, protected paths, budgets
- [x] Persistent human approvals (sticky per-mission)
- [x] Validation gates from config; deterministic reviewer; bounded repair
- [x] Adapters: qwen, codex, claude, devin, opencode, custom argv (+ gemini, aider untested)
- [x] Daemon + loopback control API + MCP surface + health
- [x] `agentloop` CLI + legacy config migration
- [x] False-completion guards + fake-agent test suite

## v0.2 — hardening

- [ ] Live-validation of codex/claude/devin adapters end-to-end; record per-adapter flag compatibility matrix
- [x] Planner schema hardening + scope-expansion approval flow exercised e2e (`planner-schema.test.ts`, `scope-expansion.test.ts`, `scope-expansion-e2e.test.ts`)
- [x] Chaos suite: kill runtime mid-gate (`chaos-mid-gate.test.ts`, found+fixed dead-owner lock reclaim), kill mid-push (`chaos-mid-push.test.ts`), kill mid repair-loop (`chaos-mid-repair.test.ts`), locked worktree/dead+live lock contention (`chaos-lock-contention.test.ts`), disk-full write faults (`chaos-persistence-faults.test.ts`) — all assert no false completion
- [x] Approval timeout + denied-approval e2e coverage (unit-covered, needs smoke)
- [x] Daemon auth token enforcement test
- [ ] API contract freeze for ai-cli-editor
- [x] Worktree/branch GC command (`agentloop clean`) for finished missions

## v0.3 — multi-project operations

- [x] Scheduler fairness across repos; priority preemption rules
- [x] Resource-aware admission (CPU/memory pressure → defer missions)
- [x] Event stream tailing for cockpit (`GET /v1/missions/:id/events?follow`)

## v1.0 candidates

- [ ] Signed execution receipts (ReasoningReceipt-compatible wrapper, no hard dep)
- [x] Maintenance-mission presets (dep updates, test coverage) with strict scopes (`--preset`, `agentloop presets`, `docs/mission-presets.md`)
- [ ] Optional self-task generation mode (off by default, budget-capped)
- [ ] Unix socket / named pipe transport for control API

## Explicit non-goals

- Automatic merges to protected branches
- Remote/multi-tenant control plane
- Internet repo scanning / unsolicited contributions
