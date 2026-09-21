import chalk from 'chalk';
import { join } from 'path';
import { MissionStore } from '../mission/mission-store.js';
import { createMission, prepareMission } from '../engine/mission-factory.js';
import { MissionRunner } from '../engine/mission-runner.js';
import { recoverMission } from '../engine/recovery.js';
import { defaultPlan, maintenancePlan } from '../engine/planner.js';
import { decideApproval, loadApprovals } from '../policy/approvals.js';
import { loadPolicy } from '../policy/policy.js';
import { ConfigManager } from '../config/config-manager.js';
import { isTerminal } from '../mission/state-machine.js';
import { MissionState, AgentType } from '../types.js';
import type { MissionSpec, AgentConfig } from '../types.js';
import { logger } from '../logger.js';

/**
 * Mission lifecycle commands: run, pause, resume, cancel, approve.
 */

function resolveAgent(nameOrType: string | undefined, repoPath: string): AgentConfig {
  const cfg = new ConfigManager(join(repoPath, 'agentloop.config.json'));
  const agents = cfg.getConfig().agents;
  if (nameOrType) {
    const found = agents.find(a => a.name === nameOrType || String(a.type) === nameOrType);
    if (found) return found;
    // Treat as a bare adapter type (e.g. --agent qwen)
    if (Object.values(AgentType).includes(nameOrType as AgentType)) {
      return { name: nameOrType, type: nameOrType as AgentType };
    }
    throw new Error(`Unknown agent '${nameOrType}' — configure it in agentloop.config.json`);
  }
  if (agents.length > 0) {
    const def = cfg.getConfig().defaultAgent;
    return agents.find(a => a.name === def) ?? agents[0];
  }
  return { name: 'qwen', type: AgentType.QWEN };
}

function repoConfig(repoPath: string) {
  try {
    return new ConfigManager(join(repoPath, 'agentloop.config.json')).getConfig();
  } catch {
    return new ConfigManager().getConfig();
  }
}

export async function cmdRun(objective: string, opts: {
  criteria?: string[];
  agent?: string;
  repo?: string;
  inPlace?: boolean;
  approveInPlace?: boolean;
  maintenance?: boolean;
  plan?: boolean;
  nonGoal?: string[];
  maxMinutes?: number;
}): Promise<void> {
  const repoPath = opts.repo ?? process.cwd();
  const store = new MissionStore(repoPath);
  const { policy } = loadPolicy(repoPath);
  const agent = resolveAgent(opts.agent, repoPath);

  const spec: MissionSpec = {
    objective,
    acceptanceCriteria: opts.criteria && opts.criteria.length > 0 ? opts.criteria : [],
    nonGoals: opts.nonGoal
  };

  // Acceptance criteria are required — if the user gave none, derive a minimal
  // set from configured validation commands so the gate still can't be gamed.
  if (spec.acceptanceCriteria.length === 0) {
    const vc = repoConfig(repoPath).validationCommands ?? {};
    const derived = Object.keys(vc).map(k => `validation '${k}' passes`);
    if (derived.length === 0) {
      console.error(chalk.red('Mission needs acceptance criteria.'));
      console.error('Pass --criteria "..." or configure validationCommands in agentloop.config.json.');
      process.exitCode = 2;
      return;
    }
    spec.acceptanceCriteria = derived;
  }

  const mission = createMission({
    repoPath, spec, agent,
    kind: opts.maintenance ? 'maintenance' : 'objective',
    planning: opts.plan !== false && !opts.maintenance,
    workspaceMode: opts.inPlace ? 'in-place' : 'worktree',
    inPlaceApproved: opts.approveInPlace === true,
    budget: opts.maxMinutes ? { maxMissionMinutes: opts.maxMinutes } : undefined
  }, store);

  console.log(`Mission ${chalk.cyan(mission.id)} created`);
  if (opts.inPlace) console.log(chalk.yellow('In-place mode: running against the working tree (no worktree isolation).'));

  // Preflight and allocate the workspace before any agent process is launched.
  // Agent planning is persisted and budgeted by the runner, under its lease.
  let plannerTasks;
  if (opts.plan === false) {
    plannerTasks = defaultPlan();
  } else if (opts.maintenance) {
    plannerTasks = maintenancePlan(mission, { hasTests: true, hasDocs: true, largeFiles: [] });
  }

  try {
    await prepareMission(mission, store, { plannerTasks });
  } catch (err) {
    console.error(chalk.red(`Prepare failed: ${err instanceof Error ? err.message : err}`));
    process.exitCode = 1;
    return;
  }
  console.log(`Workspace: ${mission.workspace.path}`);

  const runner = new MissionRunner(store, {
    validationCommands: repoConfig(repoPath).validationCommands
  });
  const result = await runner.run(mission.id);

  if (result.state === MissionState.COMPLETED) {
    console.log(chalk.green(`Mission ${mission.id} completed`));
  } else {
    console.log(chalk.yellow(`Mission ${mission.id} ended in state: ${result.state}`));
    if (result.outcome?.summary) console.log(`  summary: ${result.outcome.summary}`);
    process.exitCode = result.state === MissionState.PAUSED ? 0 : 1;
  }
}

export function cmdPause(id: string, repo?: string): void {
  const store = new MissionStore(repo ?? process.cwd());
  const m = store.mustLoad(id);
  if (isTerminal(m.state)) { console.log(`Mission ${id} is ${m.state} — cannot pause.`); return; }
  if (m.state !== MissionState.RUNNING && m.state !== MissionState.VALIDATING && m.state !== MissionState.REPAIRING) {
    store.transition(m, MissionState.PAUSED, 'paused via CLI');
    console.log(`Mission ${id} marked paused (was ${m.state}).`);
    return;
  }
  // Running in another process — a pause marker is honored at the next checkpoint
  store.transition(m, MissionState.PAUSED, 'paused via CLI');
  console.log(`Mission ${id} paused. The runner will checkpoint at the next step boundary.`);
}

export async function cmdResume(id: string, repo?: string): Promise<void> {
  const store = new MissionStore(repo ?? process.cwd());
  const m = await recoverMission(store, id);
  console.log(`Mission ${id} recovered to state: ${m.state}`);
  const runner = new MissionRunner(store, {
    validationCommands: repoConfig(repo ?? process.cwd()).validationCommands
  });
  const result = await runner.run(id);
  console.log(`Mission ${id} finished: ${result.state}`);
}

export function cmdCancel(id: string, repo?: string): void {
  const store = new MissionStore(repo ?? process.cwd());
  const m = store.mustLoad(id);
  if (isTerminal(m.state)) { console.log(`Mission ${id} already ${m.state}.`); return; }
  store.transition(m, MissionState.CANCELLED, 'cancelled via CLI');
  console.log(`Mission ${id} cancelled.`);
}

export function cmdApprove(id: string, approvalId: string, opts: { deny?: boolean; by?: string; repo?: string }): void {
  const store = new MissionStore(opts.repo ?? process.cwd());
  const mission = store.mustLoad(id);
  const decision = opts.deny ? 'denied' : 'approved';
  const updated = decideApproval(store.dir(id), id, approvalId, decision, opts.by ?? 'cli');
  if (!updated) {
    const pending = loadApprovals(store.dir(id)).filter(a => a.status === 'pending');
    console.error(chalk.red(`Approval ${approvalId} not found or already decided.`));
    if (pending.length > 0) {
      console.error('Pending approvals:');
      for (const a of pending) console.error(`  ${a.id}  ${a.gate}  ${a.detail}`);
    }
    process.exitCode = 1;
    return;
  }
  store.emit(id, 'approval_decided', { gate: updated.gate, status: decision, by: opts.by ?? 'cli' });
  console.log(`${decision === 'approved' ? chalk.green('Approved') : chalk.red('Denied')} ${updated.gate} on mission ${mission.id}`);
}
