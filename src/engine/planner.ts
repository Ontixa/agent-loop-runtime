import type { Mission, TaskNode, AgentInvocationResult } from '../types.js';
import { TaskStatus } from '../types.js';
import { validateTaskGraph, taskId, readyTasks } from './task-graph.js';

/**
 * Planner — converts a mission spec into an executable task DAG.
 *
 * Planner output is UNTRUSTED agent output: strict schema validation is
 * applied, and the planner can never modify permissions, git policy, budget,
 * protected paths, or approval requirements — it only emits task titles and
 * dependencies, which is the full extent of its authority.
 */

const MAX_PLAN_TASKS = 12;
const MAX_PLAN_PATHS_PER_TASK = 40;
const MAX_PLAN_PATHS_TOTAL = 100;
const MAX_PLAN_COMMANDS_PER_TASK = 20;
const MAX_PLAN_COMMANDS_TOTAL = 50;
const MAX_PLAN_PATH_LEN = 512;
const MAX_PLAN_ARGV_LEN = 2000;
export const PLANNER_TIMEOUT_MS = 120_000;

/**
 * Structured planner-output rejection. `issues` lists EVERY violation found,
 * in deterministic entry order — one throw reports the whole malformed plan,
 * never a nondeterministic first-found failure.
 */
export class PlanValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid plan: ${issues.join('; ')}`);
    this.name = 'PlanValidationError';
    Object.setPrototypeOf(this, PlanValidationError.prototype);
  }
}

/**
 * Scope a plan entry may REQUEST. Requests are declarations, never grants —
 * the runner compares them against the mission's approved envelope and gates
 * any excess on a human scope-expansion decision.
 */
export interface PlanScopeRequest {
  paths: string[];
  commands: string[][];
}

/** Zero means no launch is permitted; evaluate immediately before spawn. */
export function planningTimeoutMs(mission: Mission, now = Date.now()): number {
  const remaining = mission.budget.maxMissionMinutes * 60_000 -
    (now - Date.parse(mission.usage.startedAt!));
  return Math.max(0, Math.min(PLANNER_TIMEOUT_MS, mission.budget.agentTimeoutMs, remaining));
}

/** The shape the planner agent must return. Everything else is rejected. */
interface RawPlanTask {
  title?: unknown;
  dependsOn?: unknown;
  paths?: unknown;
  commands?: unknown;
}

/**
 * A declared path must be a clean repo-relative path: no absolute paths, no
 * drive qualifiers, no traversal — the runtime never lets untrusted planner
 * text point outside the worktree.
 */
function validPlanPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.trim() === '' || p.length > MAX_PLAN_PATH_LEN) return false;
  const n = p.replace(/\\/g, '/');
  if (n.includes('\0') || n.startsWith('/') || /^[A-Za-z]:/.test(n)) return false;
  // '.' segments are rejected too — pure aliasing ('./src' vs 'src') that only
  // makes declared paths diverge from diff paths. No legitimate use.
  return !n.split('/').some(seg => seg === '..' || seg === '.');
}

/** Validate one entry's optional `paths` declaration; pushes issues. */
function planPaths(entry: RawPlanTask, i: number, issues: string[]): string[] {
  if (entry.paths === undefined) return [];
  if (!Array.isArray(entry.paths)) {
    issues.push(`plan entry ${i}: "paths" must be an array of repo-relative paths`);
    return [];
  }
  if (entry.paths.length > MAX_PLAN_PATHS_PER_TASK) {
    issues.push(`plan entry ${i}: "paths" has ${entry.paths.length} entries (max ${MAX_PLAN_PATHS_PER_TASK})`);
    return [];
  }
  const paths: string[] = [];
  for (const p of entry.paths) {
    if (!validPlanPath(p)) {
      issues.push(`plan entry ${i}: invalid path ${JSON.stringify(p)} — must be a clean repo-relative path`);
      continue;
    }
    // Kept verbatim apart from separator normalization — scope matching is
    // slash-based, and a trailing '/' is meaningful (directory intent).
    paths.push(p.replace(/\\/g, '/'));
  }
  return paths;
}

/** Validate one entry's optional `commands` declaration; pushes issues. */
function planCommands(entry: RawPlanTask, i: number, issues: string[]): string[][] {
  if (entry.commands === undefined) return [];
  if (!Array.isArray(entry.commands)) {
    issues.push(`plan entry ${i}: "commands" must be an array of argv arrays`);
    return [];
  }
  if (entry.commands.length > MAX_PLAN_COMMANDS_PER_TASK) {
    issues.push(`plan entry ${i}: "commands" has ${entry.commands.length} entries (max ${MAX_PLAN_COMMANDS_PER_TASK})`);
    return [];
  }
  const commands: string[][] = [];
  for (const c of entry.commands) {
    if (!Array.isArray(c) || c.length === 0 ||
        !c.every(a => typeof a === 'string' && a.length > 0 && a.length <= MAX_PLAN_ARGV_LEN)) {
      issues.push(`plan entry ${i}: command entries must be non-empty argv string arrays`);
      continue;
    }
    commands.push(c as string[]);
  }
  return commands;
}

/**
 * Validate raw planner JSON → tasks + declared scope requests. Throws
 * PlanValidationError listing every violation found. Unknown entry fields are
 * ignored — the codebase convention for untrusted input (policy files,
 * config, mission records all tolerate extra keys); only `title`,
 * `dependsOn`, `paths` and `commands` are interpreted, and the request fields
 * can never grant authority — they only feed the scope-expansion gate.
 */
export function validatePlan(raw: unknown, pass = 1): { tasks: TaskNode[]; requests: PlanScopeRequest } {
  if (!Array.isArray(raw)) {
    throw new PlanValidationError(['planner output must be a JSON array']);
  }
  if (raw.length === 0) throw new PlanValidationError(['planner produced an empty plan']);
  if (raw.length > MAX_PLAN_TASKS) {
    throw new PlanValidationError([`planner produced ${raw.length} tasks (max ${MAX_PLAN_TASKS})`]);
  }

  // First pass: per-entry shape + declared requests; collect every issue.
  const issues: string[] = [];
  const pathSet = new Set<string>();
  const commandSet = new Map<string, string[]>();
  const tasks: TaskNode[] = [];
  for (const [i, entry] of raw.entries()) {
    const t = entry as RawPlanTask;
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      issues.push(`plan entry ${i} is not an object`);
      continue;
    }
    if (typeof t.title !== 'string' || t.title.trim() === '') {
      issues.push(`plan entry ${i}: missing/invalid "title"`);
      continue;
    }
    if (t.title.length > 2000) {
      issues.push(`plan entry ${i}: title too long`);
      continue;
    }
    if (t.dependsOn !== undefined && !Array.isArray(t.dependsOn)) {
      issues.push(`plan entry ${i}: "dependsOn" must be an array`);
      continue;
    }
    for (const p of planPaths(t, i, issues)) pathSet.add(p);
    for (const c of planCommands(t, i, issues)) commandSet.set(JSON.stringify(c), c);
    tasks.push({
      id: taskId(),
      title: t.title.trim(),
      dependsOn: [] as string[],
      status: TaskStatus.PENDING,
      pass
    });
  }
  if (pathSet.size > MAX_PLAN_PATHS_TOTAL) {
    issues.push(`plan declares ${pathSet.size} distinct paths (max ${MAX_PLAN_PATHS_TOTAL})`);
  }
  if (commandSet.size > MAX_PLAN_COMMANDS_TOTAL) {
    issues.push(`plan declares ${commandSet.size} distinct commands (max ${MAX_PLAN_COMMANDS_TOTAL})`);
  }
  const seenTitles = new Set<string>();
  for (const t of tasks) {
    if (seenTitles.has(t.title)) issues.push(`task title '${t.title.slice(0, 80)}' is duplicated — title-based dependencies would be ambiguous`);
    seenTitles.add(t.title);
  }
  if (issues.length > 0) throw new PlanValidationError(issues);

  // Second pass: resolve dependsOn entries — they may reference titles or
  // 1-based indices (agents can't know our internal ids)
  raw.forEach((entry, i) => {
    const deps = (entry as RawPlanTask).dependsOn as unknown[] | undefined;
    if (!deps) return;
    for (const dep of deps) {
      if (typeof dep === 'number' && Number.isInteger(dep)) {
        const idx = dep - 1;
        if (idx < 0 || idx >= tasks.length) throw new PlanValidationError([`plan entry ${i}: bad dep index ${dep}`]);
        tasks[i].dependsOn.push(tasks[idx].id);
      } else if (typeof dep === 'string') {
        const target = tasks.find(t => t.title === dep.trim());
        if (!target) throw new PlanValidationError([`plan entry ${i}: unknown dep '${dep}'`]);
        tasks[i].dependsOn.push(target.id);
      } else {
        throw new PlanValidationError([`plan entry ${i}: dep entries must be index or title`]);
      }
    }
  });

  const errors = validateTaskGraph(tasks);
  if (errors.length > 0) throw new PlanValidationError(errors);

  // Sanity: the first runnable tasks must exist
  if (readyTasks(tasks).length === 0) {
    throw new PlanValidationError(['plan has no runnable root task']);
  }
  return { tasks, requests: { paths: [...pathSet], commands: [...commandSet.values()] } };
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

/** Resolve an abandoned planner without spending again or claiming its result. */
export function interruptPlanning(mission: Mission, reason: string): void {
  if (mission.planning?.status !== 'running') return;
  mission.planning = { status: 'resolved', source: 'fallback', error: reason };
  mission.tasks = defaultPlan();
  const pass = [...mission.passes].reverse().find(p => p.kind === 'plan');
  if (pass) {
    pass.interrupted = true;
    pass.finishedAt ??= new Date().toISOString();
    pass.note = reason;
    // No agentExit is invented when the runner lost the actual outcome.
  }
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
    'Schema: [{"title": "short imperative task", "dependsOn": [<1-based indices of earlier tasks>],',
    '  "paths": ["repo/relative paths this task will modify"],',
    '  "commands": [["argv", "arrays", "it must run"]]}]   // paths/commands optional',
    'Rules: tasks must be ordered; dependencies refer to earlier entries only;',
    'do not include deployment, publishing, or policy changes as tasks.',
    'Declared paths/commands outside the approved mission scope pause for a human',
    'scope-expansion decision; undeclared expansion is rejected at review.'
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
 * Interpret a recorded planner result. Spawning belongs exclusively to the
 * mission runner so planning cannot bypass ownership, budget, or recovery.
 * `requests` carries the plan's declared scope needs ONLY when the plan came
 * from the agent and validated cleanly — fallback output never carries
 * requests, so a malformed plan cannot smuggle a scope grant through one.
 */
export function planFromResult(
  result: AgentInvocationResult
): { tasks: TaskNode[]; source: 'agent' | 'fallback'; error?: string; requests?: PlanScopeRequest } {
  try {
    if (result.exitKind !== 'success') {
      return { tasks: defaultPlan(), source: 'fallback', error: result.exitKind };
    }

    const raw = extractJsonArray(result.outputTail);
    if (!raw) {
      return { tasks: defaultPlan(), source: 'fallback', error: 'no JSON in planner output' };
    }

    const { tasks, requests } = validatePlan(raw);
    return { tasks, source: 'agent', requests };
  } catch (err) {
    const msg = err instanceof PlanValidationError
      ? err.issues.join('; ')
      : err instanceof Error ? err.message : String(err);
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
