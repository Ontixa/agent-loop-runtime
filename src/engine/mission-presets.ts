import {
  TaskStatus,
  type MissionPreset, type MissionSpec, type Policy, type RuntimeConfig, type TaskNode
} from '../types.js';
import { taskId } from './task-graph.js';
import { defaultPlan } from './planner.js';
import { BUILTIN_PRESETS } from './builtin-presets.js';

/**
 * Mission presets — named, strict-scope templates for recurring maintenance
 * work (`dep-update`, `test-coverage`, plus config-defined entries under
 * `presets` in agentloop.config.json).
 *
 * A preset resolves into an ordinary MissionSpec + a tightened Policy
 * snapshot at mission-creation time; after that the normal machinery —
 * validation-gate classification, the deterministic reviewer's scope check,
 * scope-expansion approvals, budget enforcement — governs the mission.
 * Nothing here grants authority the repo policy didn't already have; every
 * merge direction is restrictive-only:
 *
 *  - numeric budgets and approval modes take the TIGHTER of repo vs preset;
 *  - booleans (allowLocalCommit/allowNetwork) are ANDed;
 *  - the command envelope is exactly the preset's allowedCommands plus the
 *    argv of its required validation gates — repo allowedCommands are NOT
 *    inherited by a preset mission (that is what makes the scope strict);
 *  - protectedPaths / approvalRequiredCommands / dangerousCommandPatterns
 *    union onto repo policy — a preset may add prohibitions, never remove;
 *  - spec.scope is the preset's bounded path allowlist; widening happens
 *    only through the existing human scope-expansion gate.
 */

export class PresetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresetError';
    Object.setPrototypeOf(this, PresetError.prototype);
  }
}

export const PRESET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const MAX_PRESET_TASKS = 12;
const MAX_PRESET_TITLE = 200;
const MAX_PRESET_SCOPE = 60;
const MAX_PRESET_COMMANDS = 80;
const MAX_PRESET_PATH_LEN = 512;
const PUSH_MODES = new Set(['never', 'approval', 'always']);

/**
 * A scope/glob entry must be a clean repo-relative path: no absolute paths,
 * drive qualifiers, traversal, or '.' aliasing — same rule the planner
 * applies to declared paths, so presets can't smuggle scope outside the tree.
 */
function validScopePath(p: unknown): p is string {
  if (typeof p !== 'string' || p.trim() === '' || p.length > MAX_PRESET_PATH_LEN) return false;
  const n = p.replace(/\\/g, '/');
  if (n.includes('\0') || n.startsWith('/') || /^[A-Za-z]:/.test(n)) return false;
  return !n.split('/').some(seg => seg === '..' || seg === '.');
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(s => typeof s === 'string');
}

function isArgvArray(v: unknown): v is string[][] {
  return Array.isArray(v) &&
    v.every(e => Array.isArray(e) && e.length > 0 && e.every(a => typeof a === 'string' && a.length > 0));
}

/**
 * Structural validation for a preset definition (built-in or config JSON).
 * Returns a list of issues — empty means well-formed. Resolution failures
 * (unknown gate names etc.) are reported separately by resolvePresetMission.
 */
export function validatePresetShape(name: string, raw: unknown): string[] {
  const issues: string[] = [];
  if (!PRESET_NAME_RE.test(name)) {
    issues.push(`invalid preset name '${name}' — use lowercase kebab-case (${PRESET_NAME_RE})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push('preset must be an object');
    return issues;
  }
  const p = raw as MissionPreset & Record<string, unknown>;

  for (const key of ['description', 'objective'] as const) {
    if (p[key] !== undefined && typeof p[key] !== 'string') issues.push(`${key} must be a string`);
  }
  if (typeof p.objective === 'string' && p.objective.trim() === '') {
    issues.push('objective must be non-empty when present');
  }
  for (const key of ['scope', 'nonGoals', 'acceptanceCriteria', 'requiredGates', 'tasks', 'protectedPaths', 'riskConstraints'] as const) {
    const v = p[key];
    if (v === undefined) continue;
    if (!isStringArray(v)) { issues.push(`${key} must be an array of strings`); continue; }
    if (key === 'scope') {
      if (v.length > MAX_PRESET_SCOPE) issues.push(`scope has ${v.length} entries (max ${MAX_PRESET_SCOPE})`);
      for (const s of v) {
        if (!validScopePath(s)) issues.push(`invalid scope path ${JSON.stringify(s)} — must be a clean repo-relative path`);
      }
    }
    if (key === 'protectedPaths') {
      for (const s of v) if (!validScopePath(s) && !String(s).includes('*')) {
        issues.push(`invalid protectedPaths entry ${JSON.stringify(s)}`);
      }
    }
    if (key === 'tasks' && v.length > MAX_PRESET_TASKS) {
      issues.push(`tasks has ${v.length} entries (max ${MAX_PRESET_TASKS})`);
    }
    if (key === 'tasks') {
      for (const t of v) if (t.length > MAX_PRESET_TITLE) issues.push(`task title too long (max ${MAX_PRESET_TITLE})`);
    }
  }
  if (p.allowedCommands !== undefined) {
    if (!isArgvArray(p.allowedCommands)) {
      issues.push('allowedCommands must be an array of non-empty argv arrays');
    } else if (p.allowedCommands.length > MAX_PRESET_COMMANDS) {
      issues.push(`allowedCommands has ${p.allowedCommands.length} entries (max ${MAX_PRESET_COMMANDS})`);
    }
  }
  if (p.budget !== undefined) {
    if (typeof p.budget !== 'object' || p.budget === null || Array.isArray(p.budget)) {
      issues.push('budget must be an object');
    } else {
      for (const [k, v] of Object.entries(p.budget)) {
        if (!['maxMissionMinutes', 'maxRepairPasses', 'maxAgentInvocations', 'maxDiffBytes', 'agentTimeoutMs'].includes(k)) {
          issues.push(`budget.${k} is not a supported budget field`);
        } else if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          issues.push(`budget.${k} must be a positive number`);
        }
      }
    }
  }
  if (p.approvals !== undefined) {
    if (typeof p.approvals !== 'object' || p.approvals === null || Array.isArray(p.approvals)) {
      issues.push('approvals must be an object');
    } else {
      const a = p.approvals;
      for (const key of ['allowPush', 'allowPullRequest'] as const) {
        if (a[key] !== undefined && !PUSH_MODES.has(a[key]!)) {
          issues.push(`approvals.${key} must be one of: never, approval, always`);
        }
      }
      for (const key of ['allowLocalCommit', 'allowNetwork'] as const) {
        if (a[key] !== undefined && typeof a[key] !== 'boolean') issues.push(`approvals.${key} must be a boolean`);
      }
      if (a.approvalTimeoutMs !== undefined &&
          (typeof a.approvalTimeoutMs !== 'number' || !Number.isFinite(a.approvalTimeoutMs) || a.approvalTimeoutMs <= 0)) {
        issues.push('approvals.approvalTimeoutMs must be a positive number');
      }
      if (a.approvalRequiredCommands !== undefined && !isArgvArray(a.approvalRequiredCommands)) {
        issues.push('approvals.approvalRequiredCommands must be an array of argv arrays');
      }
      if (a.dangerousCommandPatterns !== undefined && !isStringArray(a.dangerousCommandPatterns)) {
        issues.push('approvals.dangerousCommandPatterns must be an array of strings');
      }
    }
  }
  if (p.planning !== undefined && typeof p.planning !== 'boolean') {
    issues.push('planning must be a boolean');
  }
  return issues;
}

export interface PresetEntry {
  name: string;
  source: 'builtin' | 'config';
  preset: MissionPreset;
}

/**
 * All presets visible to a repo: built-ins plus config-defined entries.
 * A config entry whose key matches a built-in name SHADOWS the built-in —
 * the operator's file wins, deterministically.
 */
export function listPresets(config: RuntimeConfig): PresetEntry[] {
  const out = new Map<string, PresetEntry>();
  for (const [name, preset] of Object.entries(BUILTIN_PRESETS)) {
    out.set(name, { name, source: 'builtin', preset });
  }
  for (const [name, preset] of Object.entries(config.presets ?? {})) {
    out.set(name, { name, source: 'config', preset: { ...preset, name } });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getPreset(name: string, config: RuntimeConfig): PresetEntry | undefined {
  return listPresets(config).find(e => e.name === name);
}

/** min where undefined means "no bound from that side" */
function tighter(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Stricter of two remote-action modes: never < approval < always. */
function stricterMode<T extends 'never' | 'approval' | 'always'>(repo: T, preset: T | undefined): T {
  if (preset === undefined) return repo;
  const rank = { never: 0, approval: 1, always: 2 };
  return rank[preset] < rank[repo] ? preset : repo;
}

function dedupeArgv(list: string[][]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const argv of list) {
    const k = JSON.stringify(argv);
    if (!seen.has(k)) { seen.add(k); out.push(argv); }
  }
  return out;
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

export interface ResolvedPresetMission {
  /** The winning preset entry (config shadows builtin) */
  preset: PresetEntry;
  /** MissionSpec to hand to createMission */
  spec: MissionSpec;
  /** Tightened policy snapshot — pass as createMission's `policy` */
  policy: Policy;
  /** Preset intent: run the agent planner inside the runner */
  planning: boolean;
  /**
   * Deterministic task graph for the non-planning path (preset.tasks, or the
   * default single execute task when the preset ships none). Ignored when
   * `planning` is in effect.
   */
  tasks: TaskNode[];
  /** Non-fatal caveats worth surfacing to the operator */
  warnings: string[];
}

/**
 * Resolve a preset name into mission-factory inputs.
 *
 * Throws PresetError when the preset is unknown, malformed, or declares
 * required validation gates that are not configured — a preset that cannot
 * run its own gates fails BEFORE the mission exists, never after.
 */
export function resolvePresetMission(opts: {
  name: string;
  config: RuntimeConfig;
  /** Repo-resolved policy (loadPolicy result) — the ceiling presets tighten against */
  policy: Policy;
  /** Positional CLI objective — overrides the preset default */
  objective?: string;
  /** Extra acceptance criteria appended to the preset's */
  criteria?: string[];
  /** Extra non-goals appended to the preset's */
  nonGoals?: string[];
}): ResolvedPresetMission {
  const entry = getPreset(opts.name, opts.config);
  if (!entry) {
    const available = listPresets(opts.config).map(e => e.name).join(', ') || '(none)';
    throw new PresetError(`Unknown preset '${opts.name}'. Available: ${available}`);
  }
  const preset = entry.preset;

  const shapeIssues = validatePresetShape(entry.name, preset);
  if (shapeIssues.length > 0) {
    throw new PresetError(
      `Invalid preset '${entry.name}'${entry.source === 'config' ? ' (agentloop.config.json)' : ''}:\n` +
      `  - ${shapeIssues.join('\n  - ')}`
    );
  }

  const warnings: string[] = [];
  const configured = opts.config.validationCommands ?? {};

  // Required gates must resolve NOW — they are part of the preset's contract.
  const requiredGates = preset.requiredGates ?? [];
  const missing = requiredGates.filter(g => configured[g] === undefined);
  if (missing.length > 0) {
    throw new PresetError(
      `Preset '${entry.name}' requires validation gate(s) not configured: ${missing.join(', ')}. ` +
      `Add them under "validationCommands" in agentloop.config.json, e.g. "test": ["npm","test"].`
    );
  }
  const gateArgv = requiredGates.map(g => configured[g]);

  const objective = (opts.objective ?? preset.objective ?? '').trim();
  if (!objective) {
    throw new PresetError(
      `Preset '${entry.name}' has no default objective — pass one: agentloop run "<objective>" --preset ${entry.name}`
    );
  }

  const acceptanceCriteria = [...(preset.acceptanceCriteria ?? []), ...(opts.criteria ?? [])];
  if (acceptanceCriteria.length === 0) {
    throw new PresetError(
      `Preset '${entry.name}' ships no acceptance criteria — pass --criteria "..." ` +
      `(an agent may never self-declare success)`
    );
  }

  if (!preset.scope || preset.scope.length === 0) {
    warnings.push(`preset '${entry.name}' declares no path scope — the diff is not scope-bounded`);
  }

  const spec: MissionSpec = {
    objective,
    ...(preset.scope && preset.scope.length > 0 ? { scope: [...preset.scope] } : {}),
    nonGoals: dedupe([...(preset.nonGoals ?? []), ...(opts.nonGoals ?? [])]),
    acceptanceCriteria,
    // undefined → all configured gates run; explicit [] → preset opts out of gates
    ...(preset.requiredGates !== undefined ? { verificationCommands: [...requiredGates] } : {}),
    ...(preset.riskConstraints?.length ? { riskConstraints: [...preset.riskConstraints] } : {})
  };

  const b: NonNullable<MissionPreset['budget']> = preset.budget ?? {};
  const a: NonNullable<MissionPreset['approvals']> = preset.approvals ?? {};
  const repo = opts.policy;

  const policy: Policy = {
    ...repo,
    allowLocalCommit: repo.allowLocalCommit && (a.allowLocalCommit ?? true),
    allowPush: stricterMode(repo.allowPush, a.allowPush),
    allowPullRequest: stricterMode(repo.allowPullRequest, a.allowPullRequest),
    allowMerge: 'never',
    allowNetwork: repo.allowNetwork && (a.allowNetwork ?? true),
    maxMissionMinutes: tighter(repo.maxMissionMinutes, b.maxMissionMinutes)!,
    maxRepairPasses: tighter(repo.maxRepairPasses, b.maxRepairPasses)!,
    maxAgentInvocations: tighter(repo.maxAgentInvocations, b.maxAgentInvocations)!,
    maxDiffBytes: tighter(repo.maxDiffBytes, b.maxDiffBytes),
    agentTimeoutMs: tighter(repo.agentTimeoutMs, b.agentTimeoutMs)!,
    approvalTimeoutMs: tighter(repo.approvalTimeoutMs, a.approvalTimeoutMs)!,
    // Strict command envelope: the preset's allowlist plus its required gate
    // argv — repo allowedCommands do NOT widen a preset mission.
    allowedCommands: dedupeArgv([...(preset.allowedCommands ?? []), ...gateArgv]),
    approvalRequiredCommands: dedupeArgv([...repo.approvalRequiredCommands, ...(a.approvalRequiredCommands ?? [])]),
    dangerousCommandPatterns: dedupe([...repo.dangerousCommandPatterns, ...(a.dangerousCommandPatterns ?? [])]),
    protectedPaths: dedupe([...repo.protectedPaths, ...(preset.protectedPaths ?? [])])
  };

  const tasks: TaskNode[] = preset.tasks && preset.tasks.length > 0
    ? preset.tasks.map(title => ({
        id: taskId(),
        title,
        dependsOn: [],
        status: TaskStatus.PENDING,
        pass: 1
      }))
    : defaultPlan();

  return {
    preset: entry,
    spec,
    policy,
    planning: preset.planning === true,
    tasks,
    warnings
  };
}
