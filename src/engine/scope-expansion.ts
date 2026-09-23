import { classifyCommand, pathInScope } from '../policy/command-safety.js';
import { approvalCoversArgv, grantedScopePaths, verifyDecision } from '../policy/approvals.js';
import type { ApprovalRequest, Mission } from '../types.js';
import type { PlanScopeRequest } from './planner.js';

/**
 * Scope expansion — the approved-envelope arithmetic behind the
 * `scope-expansion` approval gate.
 *
 * The envelope a mission may touch is fixed at creation: `spec.scope` for
 * paths and `policy.allowedCommands` for runtime commands, both snapshotted
 * into the mission record. A plan entry or an actual diff can REQUEST more —
 * new paths, new commands. Those requests are compared here against the
 * envelope plus every previously granted scope-expansion approval, and only
 * the still-uncovered remainder is gated on a fresh human decision. Nothing
 * in this module grants anything; it computes what a human must approve.
 */

export interface ScopeExpansion {
  /** Exact repo-relative paths beyond the current envelope. */
  paths: string[];
  /** Exact argv arrays not allowlisted and not already approved. */
  commands: string[][];
}

export const EMPTY_EXPANSION: ScopeExpansion = { paths: [], commands: [] };

/** The binding an approval must carry to cover a mission's scope. */
function bindingOf(mission: Mission): { policyHash?: string; worktree?: string } {
  return { policyHash: mission.policyHash, worktree: mission.workspace.path };
}

/**
 * Effective path envelope: the declared `spec.scope` widened by every
 * verified, bound, approved scope-expansion grant. `undefined` means the
 * mission declared no path envelope at all — nothing to expand beyond.
 */
export function effectiveScopePaths(
  mission: Mission,
  approvals: ApprovalRequest[]
): string[] | undefined {
  const declared = mission.spec.scope ?? [];
  if (declared.length === 0) return undefined;
  return [...declared, ...grantedScopePaths(approvals, bindingOf(mission))];
}

/** Approvals whose exact-argv coverage applies to this mission. */
function approvedCovering(mission: Mission, approvals: ApprovalRequest[]): ApprovalRequest[] {
  const binding = bindingOf(mission);
  return approvals.filter(a =>
    a.status === 'approved' &&
    (a.policyHash === undefined || a.policyHash === binding.policyHash) &&
    (a.worktree === undefined || a.worktree === binding.worktree) &&
    verifyDecision(a) === 'ok');
}

/**
 * The part of `requests` that exceeds the approved envelope and no prior
 * decision already covers. Empty result → nothing to gate.
 *
 * Fail-closed rules:
 * - a path request only expands scope when the mission declared `spec.scope`
 *   (no declared envelope = nothing was withheld);
 * - a command request expands whenever policy classifies it non-`allowed` —
 *   refused-class commands are still listed so the human sees the exact ask;
 *   approval can cover them but execution-side classification stays in force
 *   for anything not covered exactly;
 * - already-granted requests never re-gate (sticky per-mission approvals).
 */
export function outstandingExpansion(
  mission: Mission,
  requests: PlanScopeRequest | undefined,
  approvals: ApprovalRequest[]
): ScopeExpansion {
  if (!requests) return EMPTY_EXPANSION;
  const scope = effectiveScopePaths(mission, approvals);
  const covering = approvedCovering(mission, approvals);

  const paths = scope === undefined
    ? []
    : requests.paths.filter(p => !pathInScope(p, scope));
  const commands = requests.commands.filter(argv =>
    classifyCommand(argv, mission.policy).risk !== 'allowed' &&
    !covering.some(a => approvalCoversArgv(a, argv)));

  return {
    paths: [...new Set(paths)],
    commands
  };
}

/** Human-readable summary of an outstanding expansion for the gate detail. */
export function expansionDetail(prefix: string, expansion: ScopeExpansion): string {
  const parts: string[] = [];
  if (expansion.paths.length > 0) {
    parts.push(`paths: ${expansion.paths.slice(0, 20).join(', ')}${expansion.paths.length > 20 ? ` (+${expansion.paths.length - 20} more)` : ''}`);
  }
  if (expansion.commands.length > 0) {
    parts.push(`commands: ${expansion.commands.slice(0, 10).map(c => c.join(' ')).join(' | ')}${expansion.commands.length > 10 ? ` (+${expansion.commands.length - 10} more)` : ''}`);
  }
  return `${prefix}: ${parts.join('; ')} — approving widens the mission envelope by exactly these items`;
}
