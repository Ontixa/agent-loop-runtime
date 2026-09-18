import { join } from 'path';
import { existsSync } from 'fs';
import { readJsonFile, writeJsonAtomic } from '../util/atomic-file.js';
import type { ApprovalRequest } from '../types.js';
import { randomBytes } from 'crypto';

/**
 * Approval gates.
 *
 * Pending approvals live in the mission record itself (mission.json) AND a
 * per-mission approvals.json — the file is the operator-facing surface:
 * `agentloop approve <mission>` writes a decision here and the runner picks
 * it up. Works headless (file-driven) and via the control API.
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

/** Raise a new pending approval gate. */
export function requestApproval(
  missionDir: string,
  missionId: string,
  gate: ApprovalRequest['gate'],
  detail: string,
  commands?: string[][]
): ApprovalRequest {
  const approvals = loadApprovals(missionDir);
  const req: ApprovalRequest = {
    id: `ap_${randomBytes(6).toString('hex')}`,
    gate,
    detail,
    ...(commands ? { commands } : {}),
    status: 'pending',
    requestedAt: new Date().toISOString()
  };
  approvals.push(req);
  saveApprovals(missionDir, missionId, approvals);
  return req;
}

/** Record a decision for a pending approval. */
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
  saveApprovals(missionDir, missionId, approvals);
  return req;
}

/** Read the current status of an approval. */
export function approvalStatus(missionDir: string, approvalId: string): ApprovalRequest | null {
  return loadApprovals(missionDir).find(a => a.id === approvalId) ?? null;
}
