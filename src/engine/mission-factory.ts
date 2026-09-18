import { resolve, join } from 'path';
import { MissionStore, missionId } from '../mission/mission-store.js';
import { inspectRepo, preflightRepo } from '../git/repo-inspector.js';
import { createMissionWorktree, ensureRuntimeDir } from '../git/worktree-manager.js';
import { loadPolicy } from '../policy/policy.js';
import type {
  Mission, MissionSpec, AgentConfig, MissionBudget, Policy
} from '../types.js';
import { MissionState } from '../types.js';
import { logger } from '../logger.js';

/**
 * Mission factory — builds and persists a Mission in `created` state.
 * `prepare()` then does repo preflight + worktree allocation → `prepared`.
 */

export interface CreateMissionOptions {
  repoPath: string;
  spec: MissionSpec;
  agent: AgentConfig;
  kind?: Mission['kind'];
  policy?: Policy;              // resolved override; defaults to repo policy
  budget?: Partial<MissionBudget>;
  workspaceMode?: 'worktree' | 'in-place';
  /** Explicit operator sign-off for in-place mode (still gated) */
  inPlaceApproved?: boolean;
}

export class MissionPreparationError extends Error {
  constructor(message: string, public readonly issues: string[] = []) {
    super(message);
    this.name = 'MissionPreparationError';
    Object.setPrototypeOf(this, MissionPreparationError.prototype);
  }
}

/** Create a persisted mission record (state=created). */
export function createMission(opts: CreateMissionOptions, store: MissionStore): Mission {
  if (!opts.spec?.objective || opts.spec.objective.trim() === '') {
    throw new Error('Mission requires a non-empty objective');
  }
  if (!opts.spec.acceptanceCriteria || opts.spec.acceptanceCriteria.length === 0) {
    throw new Error('Mission requires at least one acceptance criterion — an agent may never self-declare success');
  }

  const repoPath = resolve(opts.repoPath);
  const policy = opts.policy ?? loadPolicy(repoPath).policy;

  const budget: MissionBudget = {
    maxMissionMinutes: opts.budget?.maxMissionMinutes ?? policy.maxMissionMinutes,
    maxRepairPasses: opts.budget?.maxRepairPasses ?? policy.maxRepairPasses,
    maxAgentInvocations: opts.budget?.maxAgentInvocations ?? policy.maxAgentInvocations,
    maxDiffBytes: opts.budget?.maxDiffBytes ?? policy.maxDiffBytes,
    agentTimeoutMs: opts.budget?.agentTimeoutMs ?? opts.agent.timeout ?? policy.agentTimeoutMs
  };

  // Budget sanity: budgets must always be finite
  if (budget.maxMissionMinutes <= 0) budget.maxMissionMinutes = policy.maxMissionMinutes;
  if (budget.maxAgentInvocations <= 0) budget.maxAgentInvocations = policy.maxAgentInvocations;

  const id = missionId();
  const now = new Date().toISOString();

  const mission: Mission = {
    schemaVersion: 1,
    id,
    kind: opts.kind ?? 'objective',
    spec: {
      ...opts.spec,
      objective: opts.spec.objective.trim()
    },
    repository: { path: repoPath, baseSha: '', baseBranch: '' },
    workspace: {
      mode: opts.workspaceMode ?? 'worktree',
      path: opts.workspaceMode === 'in-place' ? repoPath : join(repoPath, '.agentloop', 'worktrees', id)
    },
    agent: opts.agent,
    policy,
    budget,
    state: MissionState.CREATED,
    stateHistory: [{ state: MissionState.CREATED, at: now }],
    tasks: [],
    passes: [],
    approvals: [],
    checkpoints: [],
    usage: { agentInvocations: 0, repairPasses: 0, wallTimeMs: 0 },
    createdAt: now,
    updatedAt: now
  };

  store.save(mission);
  store.emit(id, 'mission_created', {
    kind: mission.kind,
    objective: mission.spec.objective.slice(0, 200),
    agent: String(opts.agent.type),
    workspaceMode: mission.workspace.mode
  });
  logger.info(`Mission created: ${id}`, { mission: id });
  return mission;
}

/**
 * Prepare a mission: repo preflight, capture base SHA, allocate worktree.
 * Returns issues for the caller to surface; throws on hard errors.
 */
export async function prepareMission(
  mission: Mission,
  store: MissionStore,
  opts: { plannerTasks?: import('../types.js').TaskNode[] } = {}
): Promise<Mission> {
  const repoPath = mission.repository.path;
  const missionBranch = `agentloop/${mission.id}`;
  const worktreePath = mission.workspace.mode === 'worktree'
    ? join(repoPath, '.agentloop', 'worktrees', mission.id)
    : repoPath;

  const { status, issues } = await preflightRepo(repoPath, {
    missionBranch: mission.workspace.mode === 'worktree' ? missionBranch : undefined,
    worktreePath: mission.workspace.mode === 'worktree' ? worktreePath : undefined,
    inPlace: mission.workspace.mode === 'in-place'
  });

  const errors = issues.filter(i => i.severity === 'error');
  if (errors.length > 0) {
    throw new MissionPreparationError(
      `Mission preflight failed: ${errors.map(e => e.message).join('; ')}`,
      errors.map(e => e.message)
    );
  }

  mission.repository.baseSha = status.headSha!;
  mission.repository.baseBranch = status.branch ?? 'HEAD';
  mission.repository.remote = status.remote;

  if (mission.workspace.mode === 'worktree') {
    const wt = await createMissionWorktree(repoPath, mission.id, status.headSha!);
    mission.workspace.path = wt.path;
    mission.workspace.branch = wt.branch;
  } else {
    ensureRuntimeDir(repoPath);
    mission.workspace.path = repoPath;
    mission.workspace.branch = status.branch;
  }

  if (opts.plannerTasks) {
    mission.tasks = opts.plannerTasks;
  }

  store.transition(mission, MissionState.PREPARED, 'preflight ok, workspace ready');
  store.emit(mission.id, 'mission_prepared', {
    baseSha: mission.repository.baseSha,
    branch: mission.workspace.branch,
    worktree: mission.workspace.path,
    warnings: issues.filter(i => i.severity === 'warning').map(i => i.message)
  });

  return mission;
}
