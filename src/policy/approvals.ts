import { join } from 'path';
import { readJsonFile, writeJsonAtomic } from '../util/atomic-file.js';
import { createHash, createHmac } from 'crypto';
import type { ApprovalRequest, Policy } from '../types.js';
import { randomBytes } from 'crypto';

/**
 * Approval gates.
 *
 * Pending approvals live in the mission record itself (mission.json) AND a
 * per-mission approvals.json — the file is the operator-facing surface:
 * `agentloop approve <mission>` writes a decision here and the runner picks
 * it up. Works headless (file-driven) and via the control API.
 *
 * Binding: an approval is bound to the mission, the exact gated argv(s), the
 * mission's policy fingerprint, and the workspace it targets. A changed
 * command or scope does NOT inherit the old approval.
 *
 * Integrity: if the operator sets AGENTLOOP_APPROVAL_KEY, decisions are
 * signed with HMAC-SHA256 and the runner refuses to honor unsigned or
 * mis-signed decisions. The key is stripped from agent child env, so an
 * agent can forge a decision only if it can read the operator's environment
 * — an explicitly documented, advisory boundary (no OS sandbox claims).
 */

export interface ApprovalsFile {
  missionId: string;
  approvals: ApprovalRequest[];
}

export function approvalsPath(missionDir: string): string {
  return join(missionDir, 'approvals.json');
}

export function loadApprovals(missionDir: string): ApprovalRequest[] {
  const f = readJsonFile<ApprovalsFile>(approvalsPath(missionDir));
  return f?.approvals ?? [];
}

export function saveApprovals(missionDir: string, missionId: string, approvals: ApprovalRequest[]): void {
  writeJsonAtomic(approvalsPath(missionDir), { missionId, approvals } satisfies ApprovalsFile);
}

/** Deterministic JSON with object keys sorted at every depth. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Canonical fingerprint of a resolved policy (key-sorted JSON, sha256). */
export function policyHash(policy: Policy): string {
  return createHash('sha256').update(stableStringify(policy)).digest('hex').slice(0, 16);
}

/** Fingerprint of an approval request for dedupe: gate + exact argv set + policy. */
export function approvalFingerprint(a: Pick<ApprovalRequest, 'gate' | 'commands' | 'policyHash' | 'worktree'>): string {
  const cmds = (a.commands ?? []).map(c => c.join('')).sort().join('|');
  return createHash('sha256')
    .update(`${a.gate}\n${cmds}\n${a.policyHash ?? ''}\n${a.worktree ?? ''}`)
    .digest('hex').slice(0, 16);
}

function approvalKey(): string | undefined {
  const k = process.env.AGENTLOOP_APPROVAL_KEY;
  return k && k.length >= 8 ? k : undefined;
}

function signDecision(req: ApprovalRequest): string | undefined {
  const key = approvalKey();
  if (!key) return undefined;
  return createHmac('sha256', key)
    .update(`${req.id}|${req.status}|${req.decidedBy ?? ''}|${req.decidedAt ?? ''}`)
    .digest('hex');
}

/**
 * Verify a decided approval's signature. Returns:
 *  - 'ok'        — signed correctly, or no key configured (advisory mode)
 *  - 'unsigned'  — key configured but decision lacks a signature
 *  - 'invalid'   — key configured and signature does not match
 */
export function verifyDecision(req: ApprovalRequest): 'ok' | 'unsigned' | 'invalid' {
  const key = approvalKey();
  if (!key) return 'ok';
  if (req.status === 'pending') return 'ok';
  if (!req.sig) return 'unsigned';
  const expect = createHmac('sha256', key)
    .update(`${req.id}|${req.status}|${req.decidedBy ?? ''}|${req.decidedAt ?? ''}`)
    .digest('hex');
  return req.sig === expect ? 'ok' : 'invalid';
}

/** True if `req` (approved) covers exactly argv — exact match, no prefix. */
export function approvalCoversArgv(req: ApprovalRequest, argv: string[]): boolean {
  if (req.status !== 'approved' || !req.commands) return false;
  return req.commands.some(c => c.length === argv.length && c.every((a, i) => a === argv[i]));
}

/**
 * Raise a new pending approval gate. If an identical pending gate already
 * exists (same fingerprint), the existing request is returned instead of
 * duplicating — a mission re-driving after recovery must not pile up
 * equivalent requests.
 */
export function requestApproval(
  missionDir: string,
  missionId: string,
  gate: ApprovalRequest['gate'],
  detail: string,
  commands?: string[][],
  context?: { policyHash?: string; worktree?: string }
): ApprovalRequest {
  const approvals = loadApprovals(missionDir);
  const candidate: Pick<ApprovalRequest, 'gate' | 'commands' | 'policyHash' | 'worktree'> = {
    gate, commands, policyHash: context?.policyHash, worktree: context?.worktree
  };
  const fp = approvalFingerprint(candidate);
  const existing = approvals.find(a =>
    a.status === 'pending' &&
    approvalFingerprint(a) === fp
  );
  if (existing) return existing;

  const req: ApprovalRequest = {
    id: `ap_${randomBytes(6).toString('hex')}`,
    gate,
    detail,
    ...(commands ? { commands } : {}),
    ...(context?.policyHash ? { policyHash: context.policyHash } : {}),
    ...(context?.worktree ? { worktree: context.worktree } : {}),
    status: 'pending',
    requestedAt: new Date().toISOString()
  };
  approvals.push(req);
  saveApprovals(missionDir, missionId, approvals);
  return req;
}

/** Record a decision for a pending approval. Signed when the operator key is set. */
export function decideApproval(
  missionDir: string,
  missionId: string,
  approvalId: string,
  decision: 'approved' | 'denied',
  decidedBy: string
): ApprovalRequest | null {
  const approvals = loadApprovals(missionDir);
  const req = approvals.find(a => a.id === approvalId);
  if (!req || req.status !== 'pending') return null;
  req.status = decision;
  req.decidedAt = new Date().toISOString();
  req.decidedBy = decidedBy;
  const sig = signDecision(req);
  if (sig) req.sig = sig;
  saveApprovals(missionDir, missionId, approvals);
  return req;
}

/** Read the current status of an approval. */
export function approvalStatus(missionDir: string, approvalId: string): ApprovalRequest | null {
  return loadApprovals(missionDir).find(a => a.id === approvalId) ?? null;
}
