import { resolve, join } from 'path';
import { MissionStore, missionId } from '../mission/mission-store.js';
import { inspectRepo, preflightRepo } from '../git/repo-inspector.js';
import { createMissionWorktree, ensureRuntimeDir } from '../git/worktree-manager.js';
import { loadPolicy } from '../policy/policy.js';
import { policyHash as computePolicyHash } from '../policy/approvals.js';
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

  // In-place execution touches the operator's real checkout — the two-flag
  // contract is enforced HERE, not just at the CLI surface, so API/MCP
  // callers can't bypass it either.
  if (opts.workspaceMode === 'in-place' && opts.inPlaceApproved !== true) {
    throw new Error(
      'In-place mission requires explicit operator sign-off: pass both --in-place and --in-place-approved'
    );
  }

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
    // Snapshot the resolved policy fingerprint — approvals bind to it, so a
    // policy edit mid-mission invalidates earlier approvals rather than
    // silently covering new scope.
    policyHash: computePolicyHash(policy),
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

  const baseSha = status.headSha!;
  const baseBranch = status.branch ?? 'HEAD';
  const remote = status.remote;

  let worktreePath2 = repoPath;
  let worktreeBranch = baseBranch;
  if (mission.workspace.mode === 'worktree') {
    const wt = await createMissionWorktree(repoPath, mission.id, baseSha);
    worktreePath2 = wt.path;
    worktreeBranch = wt.branch;
  } else {
    ensureRuntimeDir(repoPath);
  }

  // All persisted writes go through mutate() — the store owns disk truth and
  // this mutation lands atomically under the mission lock.
  const updated = store.mutate(mission.id, fresh => {
    fresh.repository.baseSha = baseSha;
    fresh.repository.baseBranch = baseBranch;
    fresh.repository.remote = remote;
    fresh.workspace.path = worktreePath2;
    fresh.workspace.branch = worktreeBranch;
    if (opts.plannerTasks) fresh.tasks = opts.plannerTasks;
  });
  Object.assign(mission, updated);

  store.transition(mission, MissionState.PREPARED, 'preflight ok, workspace ready');
  store.emit(mission.id, 'mission_prepared', {
    baseSha: mission.repository.baseSha,
    branch: mission.workspace.branch,
    worktree: mission.workspace.path,
    warnings: issues.filter(i => i.severity === 'warning').map(i => i.message)
  });

  return mission;
}
