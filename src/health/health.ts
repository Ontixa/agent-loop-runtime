import { existsSync } from 'fs';
import { MissionStore } from '../mission/mission-store.js';
import { getAdapter } from '../agents/registry.js';
import { inspectRepo } from '../git/repo-inspector.js';
import { isTerminal } from '../mission/state-machine.js';
import { MissionState } from '../types.js';
import type { AgentConfig } from '../types.js';

/**
 * Mission-aware health report for `agentloop health --json`.
 * Covers: runtime, scheduler, agents, worktrees, git, resources, throughput,
 * blocked approvals, state counts, stale missions, warnings/errors.
 */

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  timestamp: string;
  runtime: { node: string; platform: string; uptimeMs: number; pid: number; memoryRss: number };
  repos: RepoHealth[];
  agents: AgentHealth[];
  scheduler?: { queued: number; running: string[] };
  warnings: string[];
  errors: string[];
}

export interface RepoHealth {
  path: string;
  git: { ok: boolean; branch?: string; dirty?: boolean | null; detached?: boolean | null; error?: string; inspectionComplete?: boolean };
  missions: {
    total: number;
    byState: Record<string, number>;
    stale: number;
    blockedApprovals: number;
    /** mission.json files that failed to parse — preserved, need inspection */
    corrupt: number;
  };
  worktrees: { active: number; paths: string[] };
  throughput: { completedLast24h: number; failedLast24h: number };
}

export interface AgentHealth {
  name: string;
  type: string;
  available: boolean;
  version?: string;
  error?: string;
}

export interface HealthOptions {
  repos: string[];
  agents: AgentConfig[];
  version: string;
  schedulerStatus?: { queued: number; running: string[] };
}

export async function collectHealth(opts: HealthOptions): Promise<HealthReport> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const repos: RepoHealth[] = [];
  const agents: AgentHealth[] = [];

  // Git + missions per repo
  for (const repo of opts.repos) {
    const git = await inspectRepo(repo);
    const store = new MissionStore(repo);
    const missions = store.list();
    const byState: Record<string, number> = {};
    let stale = 0, blockedApprovals = 0, completed24 = 0, failed24 = 0;
    const dayAgo = Date.now() - 24 * 3600 * 1000;

    for (const m of missions) {
      byState[m.state] = (byState[m.state] ?? 0) + 1;
      if (m.state === MissionState.STALE) stale++;
      blockedApprovals += m.approvals.filter(a => a.status === 'pending').length;
      const finished = m.outcome?.at ? Date.parse(m.outcome.at) : 0;
      if (finished > dayAgo) {
        if (m.state === MissionState.COMPLETED) completed24++;
        if (m.state === MissionState.FAILED) failed24++;
      }
    }

    const worktreePaths = missions
      .filter(m => !isTerminal(m.state) && m.workspace.mode === 'worktree' && m.workspace.path)
      .map(m => m.workspace.path)
      .filter(p => existsSync(p));

    const corrupt = store.listCorrupt();
    if (stale > 0) warnings.push(`${repo}: ${stale} stale mission(s) need recovery`);
    if (blockedApprovals > 0) warnings.push(`${repo}: ${blockedApprovals} pending approval(s)`);
    if (corrupt.length > 0) errors.push(`${repo}: ${corrupt.length} corrupt mission record(s) — inspect .agentloop/missions/`);

    repos.push({
      path: repo,
      git: !git.inspectionComplete
        ? { ok: false, inspectionComplete: false, error: `inspection incomplete (${git.inspectionError?.stage}): ${git.inspectionError?.message}` }
        : git.isRepo
        ? { ok: true, branch: git.branch, dirty: git.dirty, detached: git.detached }
        : { ok: false, error: 'not a git repository' },
      missions: { total: missions.length, byState, stale, blockedApprovals, corrupt: corrupt.length },
      worktrees: { active: worktreePaths.length, paths: worktreePaths },
      throughput: { completedLast24h: completed24, failedLast24h: failed24 }
    });

    if (!git.inspectionComplete) errors.push(`${repo}: repository inspection incomplete (${git.inspectionError?.stage})`);
    else if (!git.isRepo) errors.push(`${repo}: not a git repository`);
  }

  // Agent availability
  for (const agent of opts.agents) {
    try {
      const adapter = getAdapter(String(agent.type), agent);
      const probe = await adapter.detect(agent);
      agents.push({
        name: agent.name, type: String(agent.type),
        available: probe.available, version: probe.version, error: probe.error
      });
      if (!probe.available) warnings.push(`agent ${agent.name} (${agent.type}) not available: ${probe.error}`);
    } catch (err) {
      agents.push({ name: agent.name, type: String(agent.type), available: false, error: String(err) });
      warnings.push(`agent ${agent.name}: adapter error: ${String(err)}`);
    }
  }

  // Resources (approximate — never claim exactness)
  const mem = process.memoryUsage();
  if (mem.rss > 1024 * 1024 * 1024) warnings.push('runtime RSS > 1GB');

  const status = errors.length > 0 ? 'error' : warnings.length > 0 ? 'degraded' : 'ok';
  return {
    status,
    version: opts.version,
    timestamp: new Date().toISOString(),
    runtime: {
      node: process.version, platform: process.platform,
      uptimeMs: Math.round(process.uptime() * 1000), pid: process.pid,
      memoryRss: mem.rss
    },
    repos, agents,
    scheduler: opts.schedulerStatus,
    warnings, errors
  };
}
