#!/usr/bin/env node

// Agent Loop Runtime — public API surface.
// The runtime is mission-centric: create a Mission in a repository, run it in
// an isolated worktree under policy, recover it after interruption, and read
// a portable execution receipt afterward.

export { MissionStore } from './mission/mission-store.js';
export { createMission, prepareMission, MissionPreparationError } from './engine/mission-factory.js';
export { MissionRunner } from './engine/mission-runner.js';
export { MissionScheduler } from './engine/scheduler.js';
export { recoverMission, detectStaleMissions } from './engine/recovery.js';
export { Daemon } from './daemon/daemon.js';
export { ControlApi } from './daemon/control-api.js';
export { McpServer } from './mcp/mcp-server.js';
export { collectHealth } from './health/health.js';

export { getAdapter, validateAgentConfig, listAdapterTypes } from './agents/registry.js';
export { loadPolicy, writeDefaultPolicy, resolvePolicy, validatePolicy, POLICY_FILE, DEFAULT_POLICY } from './policy/policy.js';
export { decideApproval, loadApprovals } from './policy/approvals.js';
export { classifyCommand } from './policy/command-safety.js';

export { inspectRepo, preflightRepo } from './git/repo-inspector.js';
export { ConfigManager, CONFIG_FILE } from './config/config-manager.js';
export { isTerminal, canTransition } from './mission/state-machine.js';
export { buildReceipt } from './mission/receipt.js';
export { logger, setLogLevel } from './logger.js';

// All mission/policy/agent/legacy types
export * from './types.js';

// If run directly, point at the CLI
if (process.argv[1] && (process.argv[1].includes('index.ts') || process.argv[1].includes('index.js'))) {
  console.log('Agent Loop Runtime — use the CLI: npx tsx src/cli.ts --help');
}
