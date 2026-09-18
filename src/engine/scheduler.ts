import { join } from 'path';
import { MissionStore } from '../mission/mission-store.js';
import { MissionRunner, RunnerOptions } from './mission-runner.js';
import { ConfigManager } from '../config/config-manager.js';
import { prepareMission } from './mission-factory.js';
import { detectStaleMissions, recoverMission } from './recovery.js';
import { planWithAgent, defaultPlan, maintenancePlan } from './planner.js';
import { getAdapter } from '../agents/registry.js';
import { MissionState } from '../types.js';
import { isTerminal } from '../mission/state-machine.js';
import type { Mission, Policy } from '../types.js';
import { EventEmitter } from 'events';
import { logger } from '../logger.js';

/**
 * Mission scheduler.
 *
 * Runs missions across projects with bounded concurrency. Understands:
 * - global mission concurrency (policy.maxConcurrentMissions)
 * - per-repo concurrency (policy.maxConcurrentMissionsPerRepo)
 * - agent availability (missions whose agent CLI is missing queue, not fail)
 * - priorities (queued order; missions are FIFO within a repo by default)
 *
 * "More agents" is not always better — defaults are deliberately conservative.
 */

export interface ScheduledMission {
  missionId: string;
  repoRoot: string;
  priority: number; // lower = earlier
  queuedAt: string;
}

interface RunningEntry {
  missionId: string;
  repoRoot: string;
  runner: MissionRunner;
  promise: Promise<Mission>;
}

export class MissionScheduler extends EventEmitter {
  private queue: ScheduledMission[] = [];
  private running = new Map<string, RunningEntry>();
  private stores = new Map<string, MissionStore>();
  private policies = new Map<string, Policy>();
  private repoConfigs = new Map<string, Record<string, string[]>>();
  private stopped = false;
  private pumpTimer: NodeJS.Timeout | null = null;

  constructor(private readonly runnerOpts: RunnerOptions = {}) {
    super();
  }

  /** Register a repo store + policy the scheduler should serve. */
  registerRepo(repoRoot: string, store: MissionStore, policy: Policy): void {
    this.stores.set(repoRoot, store);
    this.policies.set(repoRoot, policy);
    // Per-repo validation gates come from that repo's agentloop.config.json
    try {
      const cfg = new ConfigManager(join(repoRoot, 'agentloop.config.json'));
      if (cfg.loadedFromFile) {
        this.repoConfigs.set(repoRoot, cfg.getConfig().validationCommands ?? {});
      }
    } catch { /* malformed config → no named gates for this repo */ }
  }

  /** Enqueue a mission id for scheduling. */
  enqueue(repoRoot: string, missionId: string, priority = 100): void {
    if (this.queue.some(q => q.missionId === missionId) || this.running.has(missionId)) return;
    this.queue.push({ missionId, repoRoot, priority, queuedAt: new Date().toISOString() });
    this.queue.sort((a, b) => a.priority - b.priority || a.queuedAt.localeCompare(b.queuedAt));
    this.emit('queued', missionId);
    this.pump();
  }

  /** Start the scheduler pump (called automatically by enqueue). */
  start(): void {
    this.stopped = false;
    this.pump();
  }

  /** Graceful stop: stop dequeuing, request pause on running missions. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
    const stops: Promise<unknown>[] = [];
    for (const entry of this.running.values()) {
      entry.runner.requestPause();
      stops.push(entry.promise.catch(() => undefined));
    }
    await Promise.allSettled(stops);
  }

  /** Hard shutdown: cancel all running missions. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
    const stops: Promise<unknown>[] = [];
    for (const entry of this.running.values()) {
      entry.runner.requestCancel();
      stops.push(entry.promise.catch(() => undefined));
    }
    await Promise.allSettled(stops);
  }

  /** Pause a running mission. */
  pause(missionId: string): boolean {
    return this.running.get(missionId)?.runner.requestPause() !== undefined;
  }

  /** Cancel a running mission. */
  cancel(missionId: string): boolean {
    const entry = this.running.get(missionId);
    if (!entry) return false;
    entry.runner.requestCancel();
    return true;
  }

  status(): { queued: number; running: string[] } {
    return { queued: this.queue.length, running: [...this.running.keys()] };
  }

  /** Recover stale missions across registered repos; requeue resumable ones. */
  async recover(): Promise<string[]> {
    const recovered: string[] = [];
    for (const [repoRoot, store] of this.stores) {
      const stale = await detectStaleMissions(store);
      for (const m of stale) {
        try {
          await recoverMission(store, m.id);
          this.enqueue(repoRoot, m.id);
          recovered.push(m.id);
        } catch (err) {
          logger.warn('Mission recovery failed', {
            mission: m.id,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
      // Also requeue missions left in resumable states (e.g. paused on shutdown)
      for (const m of store.listActive()) {
        if (m.state === MissionState.PAUSED || m.state === MissionState.PREPARED) {
          this.enqueue(repoRoot, m.id);
        }
      }
    }
    return recovered;
  }

  private pump(): void {
    if (this.stopped) return;
    if (this.pumpTimer) return; // already scheduled

    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      void this.tick();
    }, 0);
    this.pumpTimer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    for (const [repoRoot, store] of this.stores) {
      const policy = this.policies.get(repoRoot);
      if (!policy) continue;

      const runningHere = [...this.running.values()].filter(r => r.repoRoot === repoRoot).length;
      if (this.running.size >= policy.maxConcurrentMissions) break;
      if (runningHere >= policy.maxConcurrentMissionsPerRepo) continue;

      const idx = this.queue.findIndex(q => q.repoRoot === repoRoot);
      if (idx === -1) continue;
      const [item] = this.queue.splice(idx, 1);

      try {
        await this.startMission(store, item.missionId);
      } catch (err) {
        logger.error('Failed to start mission', {
          mission: item.missionId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    if (this.queue.length > 0) this.pump();
  }

  private async startMission(store: MissionStore, missionId: string): Promise<void> {
    const mission = store.mustLoad(missionId);
    if (isTerminal(mission.state)) return;

    // Check agent availability before preparing — queue it back if missing
    try {
      const adapter = getAdapter(String(mission.agent.type), mission.agent);
      const avail = await adapter.detect(mission.agent);
      if (!avail.available) {
        store.emit(missionId, 'mission_blocked', { reason: `agent unavailable: ${avail.error}` });
        store.transition(mission, MissionState.BLOCKED, `agent unavailable: ${avail.error}`);
        return;
      }
    } catch (err) {
      store.transition(mission, MissionState.FAILED,
        `agent check failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Prepare if needed
    if (mission.state === MissionState.CREATED) {
      try {
        // Plan before worktree exists — planner uses repo root as cwd fallback
        mission.workspace.path = mission.repository.path;
        const adapter = getAdapter(String(mission.agent.type), mission.agent);
        const plan = mission.kind === 'maintenance'
          ? { tasks: maintenancePlan(mission, { hasTests: true, hasDocs: true, largeFiles: [] }), source: 'maintenance' as const }
          : await planWithAgent(mission, adapter).catch(() => ({ tasks: defaultPlan(), source: 'fallback' as const }));
        await prepareMission(mission, store, { plannerTasks: plan.tasks });
      } catch (err) {
        store.transition(mission, MissionState.FAILED,
          `prepare failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    const runner = new MissionRunner(store, {
      ...this.runnerOpts,
      validationCommands: this.runnerOpts.validationCommands ?? this.repoConfigs.get(store.repoRoot)
    });
    const promise = runner.run(missionId);
    this.running.set(missionId, { missionId, repoRoot: store.repoRoot, runner, promise });
    this.emit('started', missionId);

    promise
      .catch(err => {
        logger.error('Mission runner crashed', {
          mission: missionId,
          error: err instanceof Error ? err.message : String(err)
        });
      })
      .finally(() => {
        this.running.delete(missionId);
        this.emit('finished', missionId);
        this.pump();
      });
  }
}
