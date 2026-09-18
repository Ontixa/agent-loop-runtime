import { join } from 'path';
import { writeJsonAtomic } from '../util/atomic-file.js';
import type { Mission, GateResult, ReviewResult } from '../types.js';
import { missionDir } from './mission-store.js';

/**
 * Execution receipt — a portable record of what a mission did.
 *
 * Self-contained JSON: objective, base SHA, agent, tasks, commits,
 * validation results, approvals, outcome. Structured so an external
 * signing layer (e.g. ReasoningReceipt) can wrap/sign it later without
 * the runtime depending on that layer.
 */

export interface MissionReceipt {
  schemaVersion: 1;
  receiptFormat: 'agentloop/mission-receipt';
  generatedAt: string;
  mission: {
    id: string;
    kind: Mission['kind'];
    objective: string;
    spec: Mission['spec'];
    state: Mission['state'];
    createdAt: string;
    completedAt?: string;
  };
  repository: {
    path: string;
    baseSha: string;
    baseBranch: string;
    finalSha?: string;
    branch?: string;
    remote?: string;
  };
  agent: {
    type: string;
    name: string;
    model?: string;
  };
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    dependsOn: string[];
    pass?: number;
  }>;
  passes: Array<{
    n: number;
    kind: string;
    agentExit?: string;
    gates?: GateResult[];
    review?: ReviewResult;
    checkpointSha?: string;
  }>;
  checkpoints: Mission['checkpoints'];
  approvals: Array<{
    gate: string;
    detail: string;
    status: string;
    decidedBy?: string;
    decidedAt?: string;
  }>;
  usage: Mission['usage'];
  outcome?: Mission['outcome'];
  eventsHash?: string;
}

/** Build a receipt object from a mission. */
export function buildReceipt(mission: Mission): MissionReceipt {
  return {
    schemaVersion: 1,
    receiptFormat: 'agentloop/mission-receipt',
    generatedAt: new Date().toISOString(),
    mission: {
      id: mission.id,
      kind: mission.kind,
      objective: mission.spec.objective,
      spec: mission.spec,
      state: mission.state,
      createdAt: mission.createdAt,
      completedAt: mission.outcome?.at
    },
    repository: {
      path: mission.repository.path,
      baseSha: mission.repository.baseSha,
      baseBranch: mission.repository.baseBranch,
      finalSha: mission.outcome?.finalSha ?? mission.checkpoints.at(-1)?.sha,
      branch: mission.workspace.branch,
      remote: mission.repository.remote
    },
    agent: {
      type: String(mission.agent.type),
      name: mission.agent.name,
      model: mission.agent.model
    },
    tasks: mission.tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dependsOn: t.dependsOn,
      pass: t.pass
    })),
    passes: mission.passes.map(p => ({
      n: p.n,
      kind: p.kind,
      agentExit: p.agentExit,
      gates: p.gates,
      review: p.review,
      checkpointSha: p.checkpointSha
    })),
    checkpoints: mission.checkpoints,
    approvals: mission.approvals.map(a => ({
      gate: a.gate,
      detail: a.detail,
      status: a.status,
      decidedBy: a.decidedBy,
      decidedAt: a.decidedAt
    })),
    usage: mission.usage,
    outcome: mission.outcome
  };
}

/** Write receipt.json into the mission directory; returns the path. */
export function writeReceipt(repoRoot: string, mission: Mission): string {
  const path = join(missionDir(repoRoot, mission.id), 'receipt.json');
  writeJsonAtomic(path, buildReceipt(mission));
  return path;
}
