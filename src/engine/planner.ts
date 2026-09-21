import type { Mission, TaskNode, AgentAdapter, AgentInvocationContext } from '../types.js';
import { TaskStatus } from '../types.js';
import { validateTaskGraph, taskId, readyTasks } from './task-graph.js';
import { supervise } from '../supervisor/process-supervisor.js';
import { toSpawnInvocation } from '../agents/cli-adapter-base.js';
import { logger } from '../logger.js';

/**
 * Planner — converts a mission spec into an executable task DAG.
 *
 * Planner output is UNTRUSTED agent output: strict schema validation is
 * applied, and the planner can never modify permissions, git policy, budget,
 * protected paths, or approval requirements — it only emits task titles and
 * dependencies, which is the full extent of its authority.
 */

const MAX_PLAN_TASKS = 12;
const PLANNER_TIMEOUT_MS = 120_000;

/** The shape the planner agent must return. Everything else is rejected. */
interface RawPlanTask {
  title?: unknown;
  dependsOn?: unknown;
}

/** Validate raw planner JSON → TaskNode[]; throws on any violation. */
export function validatePlan(raw: unknown, pass = 1): TaskNode[] {
  if (!Array.isArray(raw)) {
    throw new Error('planner output must be a JSON array');
  }
  if (raw.length === 0) throw new Error('planner produced an empty plan');
  if (raw.length > MAX_PLAN_TASKS) {
    throw new Error(`planner produced ${raw.length} tasks (max ${MAX_PLAN_TASKS})`);
  }

  // First pass: build ids
  const tasks: TaskNode[] = raw.map((entry, i) => {
    const t = entry as RawPlanTask;
    if (!t || typeof t !== 'object') throw new Error(`plan entry ${i} is not an object`);
    if (typeof t.title !== 'string' || t.title.trim() === '') {
      throw new Error(`plan entry ${i}: missing/invalid "title"`);
    }
    if (t.title.length > 2000) throw new Error(`plan entry ${i}: title too long`);
    if (t.dependsOn !== undefined && !Array.isArray(t.dependsOn)) {
      throw new Error(`plan entry ${i}: "dependsOn" must be an array`);
    }
    return {
      id: taskId(),
      title: t.title.trim(),
      dependsOn: [] as string[],
      status: TaskStatus.PENDING,
      pass
    };
  });

  // Second pass: resolve dependsOn entries — they may reference titles or
  // 1-based indices (agents can't know our internal ids)
  raw.forEach((entry, i) => {
    const deps = (entry as RawPlanTask).dependsOn as unknown[] | undefined;
    if (!deps) return;
    for (const dep of deps) {
      if (typeof dep === 'number' && Number.isInteger(dep)) {
        const idx = dep - 1;
        if (idx < 0 || idx >= tasks.length) throw new Error(`plan entry ${i}: bad dep index ${dep}`);
        tasks[i].dependsOn.push(tasks[idx].id);
      } else if (typeof dep === 'string') {
        const target = tasks.find(t => t.title === dep.trim());
        if (!target) throw new Error(`plan entry ${i}: unknown dep '${dep}'`);
        tasks[i].dependsOn.push(target.id);
      } else {
        throw new Error(`plan entry ${i}: dep entries must be index or title`);
      }
    }
  });

  const errors = validateTaskGraph(tasks);
  if (errors.length > 0) throw new Error(`invalid plan: ${errors.join('; ')}`);

  // Sanity: the first runnable tasks must exist
  if (readyTasks(tasks).length === 0) {
    throw new Error('plan has no runnable root task');
  }
  return tasks;
}

/** Default deterministic plan: a single implementation task. */
export function defaultPlan(pass = 1): TaskNode[] {
  return [{
    id: taskId(),
    title: 'Execute mission objective',
    dependsOn: [],
    status: TaskStatus.PENDING,
    pass
  }];
}

/** Build the prompt sent to a planner agent. */
export function plannerPrompt(mission: Mission): string {
  const spec = mission.spec;
  return [
    'You are a planning component inside a bounded agent runtime.',
    'Decompose the mission below into 1-6 ordered implementation tasks.',
    'Return ONLY a JSON array — no markdown, no commentary.',
    '',
    `Objective: ${spec.objective}`,
    spec.scope?.length ? `Scope (files/dirs): ${spec.scope.join(', ')}` : '',
    spec.nonGoals?.length ? `Non-goals: ${spec.nonGoals.join(', ')}` : '',
    `Acceptance criteria: ${spec.acceptanceCriteria.join('; ')}`,
    spec.riskConstraints?.length ? `Risk constraints: ${spec.riskConstraints.join(', ')}` : '',
    '',
    'Schema: [{"title": "short imperative task", "dependsOn": [<1-based indices of earlier tasks>]}]',
    'Rules: tasks must be ordered; dependencies refer to earlier entries only;',
    'do not include deployment, publishing, or policy changes as tasks.'
  ].filter(Boolean).join('\n');
}

/** Extract the JSON array from agent text output. */
export function extractJsonArray(text: string): unknown | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const match = candidate.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Run a planner agent to produce a task DAG. Falls back to the default
 * single-task plan if the agent is unavailable or produces invalid output —
 * the mission always remains runnable.
 */
export async function planWithAgent(
  mission: Mission,
  adapter: AgentAdapter
): Promise<{ tasks: TaskNode[]; source: 'agent' | 'fallback'; error?: string }> {
  const ctx: AgentInvocationContext = {
    prompt: plannerPrompt(mission),
    cwd: mission.workspace.path,
    missionId: mission.id,
    pass: 0,
    signal: new AbortController().signal,
    timeoutMs: PLANNER_TIMEOUT_MS,
    maxOutputBytes: 64 * 1024
  };

  try {
    const inv = toSpawnInvocation(adapter.buildInvocation(ctx, mission.agent), ctx.cwd);
    const result = await supervise({
      ...inv,
      cwd: ctx.cwd,
      timeoutMs: PLANNER_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
      signal: ctx.signal
    });

    if (result.exitKind !== 'success') {
      logger.warn('Planner agent failed, using default plan', {
        mission: mission.id, exitKind: result.exitKind
      });
      return { tasks: defaultPlan(), source: 'fallback', error: result.exitKind };
    }

    const raw = extractJsonArray(result.outputTail);
    if (!raw) {
      return { tasks: defaultPlan(), source: 'fallback', error: 'no JSON in planner output' };
    }

    const tasks = validatePlan(raw);
    return { tasks, source: 'agent' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Planner output rejected, using default plan', { mission: mission.id, error: msg });
    return { tasks: defaultPlan(), source: 'fallback', error: msg };
  }
}

/**
 * Maintenance-mode planner: bounded task suggestions from repo analysis.
 * Respects the mission objective, scope, and non-goals; never generates
 * open-ended work — each mission gets at most `max` tasks, then stops.
 */
export function maintenancePlan(mission: Mission, analysis: {
  hasTests: boolean;
  hasDocs: boolean;
  largeFiles: string[];
}): TaskNode[] {
  const candidates: string[] = [];
  if (!analysis.hasTests) candidates.push('Add unit tests for core modules');
  if (!analysis.hasDocs) candidates.push('Add or refresh project documentation');
  for (const f of analysis.largeFiles.slice(0, 2)) {
    candidates.push(`Review ${f} for modularization opportunities`);
  }
  candidates.push('Review error handling and input validation in public APIs');
  candidates.push('Review security-sensitive paths for injection and traversal issues');

  const objective = mission.spec.objective.toLowerCase();
  const nonGoals = (mission.spec.nonGoals ?? []).map(g => g.toLowerCase());
  const filtered = candidates.filter(c =>
    !nonGoals.some(g => c.toLowerCase().includes(g.replace(/[^a-z ]/g, '').trim()))
  );

  return filtered.slice(0, 5).map(title => ({
    id: taskId(),
    title: `${title} (mission: ${objective.slice(0, 60)})`,
    dependsOn: [],
    status: TaskStatus.PENDING,
    pass: 1
  }));
}
