import { existsSync } from 'fs';
import { join } from 'path';
import { readJsonFile, writeJsonAtomic } from '../util/atomic-file.js';
import type { Policy } from '../types.js';
import { logger } from '../logger.js';

/**
 * Policy model.
 *
 * agentloop.policy.json is user-managed configuration that constrains what the
 * runtime may do. It is snapshotted into each mission at creation time so an
 * agent can never alter the rules governing its own mission.
 */

export const POLICY_FILE = 'agentloop.policy.json';

/** Safe defaults — nothing remote, bounded budgets, explicit allowlist. */
export const DEFAULT_POLICY: Policy = {
  allowLocalCommit: true,
  allowPush: 'approval',
  allowPullRequest: 'approval',
  allowMerge: 'never',
  allowNetwork: true,
  maxMissionMinutes: 120,
  maxRepairPasses: 3,
  maxAgentInvocations: 12,
  maxDiffBytes: 4 * 1024 * 1024,
  agentTimeoutMs: 20 * 60 * 1000,
  allowedCommands: [],
  approvalRequiredCommands: [],
  dangerousCommandPatterns: [],
  protectedPaths: [
    '.agentloop/**',
    'agentloop.policy.json',
    'agentloop.config.json',
    '.git/**'
  ],
  maxConcurrentMissions: 2,
  maxConcurrentMissionsPerRepo: 1,
  approvalTimeoutMs: 60 * 60 * 1000 // 1h to answer a gate before blocked
};

const VALID_PUSH_MODES = new Set(['never', 'approval', 'always']);

/** Validate a parsed policy object; returns list of problems (empty = ok). */
export function validatePolicy(raw: unknown): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['Policy must be a JSON object'];
  }
  const p = raw as Record<string, unknown>;

  for (const key of ['allowPush', 'allowPullRequest'] as const) {
    if (p[key] !== undefined && !VALID_PUSH_MODES.has(p[key] as string)) {
      errors.push(`${key} must be one of: never, approval, always`);
    }
  }
  if (p.allowMerge !== undefined && p.allowMerge !== 'never') {
    errors.push('allowMerge only supports "never" — automatic merge is not permitted');
  }
  for (const key of ['maxMissionMinutes', 'maxRepairPasses', 'maxAgentInvocations', 'agentTimeoutMs', 'maxConcurrentMissions', 'maxConcurrentMissionsPerRepo', 'approvalTimeoutMs'] as const) {
    if (p[key] !== undefined && (typeof p[key] !== 'number' || (p[key] as number) < 0)) {
      errors.push(`${key} must be a non-negative number`);
    }
  }
  for (const key of ['allowedCommands', 'approvalRequiredCommands'] as const) {
    if (p[key] !== undefined) {
      const v = p[key];
      if (!Array.isArray(v) || !v.every(e => Array.isArray(e) && e.every(s => typeof s === 'string'))) {
        errors.push(`${key} must be an array of argv arrays, e.g. [["npm","test"]]`);
      }
    }
  }
  for (const key of ['dangerousCommandPatterns', 'protectedPaths'] as const) {
    if (p[key] !== undefined && (!Array.isArray(p[key]) || !(p[key] as unknown[]).every(s => typeof s === 'string'))) {
      errors.push(`${key} must be an array of strings`);
    }
  }
  for (const key of ['allowLocalCommit', 'allowNetwork'] as const) {
    if (p[key] !== undefined && typeof p[key] !== 'boolean') {
      errors.push(`${key} must be a boolean`);
    }
  }
  return errors;
}

/** Merge a partial parsed policy over defaults. */
export function resolvePolicy(partial?: Partial<Policy>): Policy {
  return { ...DEFAULT_POLICY, ...(partial ?? {}) };
}

/**
 * Load policy for a repository. Missing file → defaults (not an error).
 * Invalid file → throws with messages (policy must be deterministic).
 */
export function loadPolicy(repoRoot: string): { policy: Policy; path: string; loadedFromFile: boolean } {
  const path = join(repoRoot, POLICY_FILE);
  if (!existsSync(path)) {
    return { policy: resolvePolicy(), path, loadedFromFile: false };
  }
  const raw = readJsonFile<Record<string, unknown>>(path);
  if (raw === undefined) {
    throw new Error(`Policy file exists but is not valid JSON: ${path}`);
  }
  const errors = validatePolicy(raw);
  if (errors.length > 0) {
    throw new Error(`Invalid policy in ${path}:\n  - ${errors.join('\n  - ')}`);
  }
  logger.debug('Policy loaded', { path });
  return { policy: resolvePolicy(raw as Partial<Policy>), path, loadedFromFile: true };
}

/** Write the default policy file (init/migrate). */
export function writeDefaultPolicy(repoRoot: string): string {
  const path = join(repoRoot, POLICY_FILE);
  writeJsonAtomic(path, DEFAULT_POLICY);
  return path;
}
