import { join } from 'path';
import { MissionStore } from '../mission/mission-store.js';
import { MissionRunner, RunnerOptions } from './mission-runner.js';
import { ConfigManager } from '../config/config-manager.js';
import { prepareMission } from './mission-factory.js';
import { detectStaleMissions, recoverMission } from './recovery.js';
import { maintenancePlan } from './planner.js';
import { getAdapter } from '../agents/registry.js';
import { MissionState } from '../types.js';
import { isTerminal } from '../mission/state-machine.js';
import type { Mission, Policy } from '../types.js';
import {
  evaluateAdmission, hostPressureProbe, resolveAdmissionLimits
} from './admission-control.js';
import type {
  AdmissionConfig, AdmissionDecision, AdmissionLimits, HostPressure, PressureProbe
} from './admission-control.js';
import { EventEmitter } from 'events';
import { logger } from '../logger.js';

/**
 * Mission scheduler.
 *
 * Runs missions across projects with bounded concurrency. Understands:
 * - global mission concurrency (min of registered policies' maxConcurrentMissions)
 * - per-repo concurrency (policy.maxConcurrentMissionsPerRepo)
 * - agent availability (missions whose agent CLI is missing queue, not fail)
 * - resource-aware admission (host load/memory pressure defers new starts)
 *
 * Admission ordering — deterministic, documented in docs/deployment-guide.md:
 * 1. Lower `priority` number first (default 100). Priority only reorders
 *    QUEUED work — running missions are never preempted or killed.
 * 2. Equal priority → the repo least recently admitted wins (round-robin
 *    across repos within a priority band, so no repo starves the others).
 * 3. Equal priority AND same last-admission credit → earliest `queuedAt`
 *    (FIFO). Ties beyond that keep enqueue order.
 */

export interface ScheduledMission {
  missionId: string;
  repoRoot: string;
  priority: number; // lower = earlier
  queuedAt: string;
}

/** Test/deployment seams for the scheduler — probes and limits, not behavior. */
export interface SchedulerDeps {
  /** Host pressure sampler; defaults to os.loadavg/freemem. */
  probe?: PressureProbe;
  /** `daemon.admission` config; defaults resolveAdmissionLimits(undefined). */
  admission?: AdmissionConfig;
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
  /**
   * repoRoot → admission sequence of its most recent admission. The fair
   * tiebreak between equal-priority candidates: smallest seq wins (never
   * admitted = 0), i.e. round-robin across repos within a priority band.
   */
  private lastServed = new Map<string, number>();
  private admissionSeq = 0;
  private readonly probe: PressureProbe;
  private readonly admissionLimits: AdmissionLimits;
  /** Active deferral episode (null when admission is open). */
  private deferral: { reason: string; since: string; sample: HostPressure } | null = null;
  /** Missions already told about THIS deferral episode — one event each. */
  private deferralNotified = new Set<string>();

  constructor(
    private readonly runnerOpts: RunnerOptions = {},
    deps: SchedulerDeps = {}
  ) {
    super();
    this.probe = deps.probe ?? hostPressureProbe;
    this.admissionLimits = resolveAdmissionLimits(deps.admission);
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

  /**
   * Graceful stop: stop dequeuing, request pause on running missions.
   * The pause is recorded with reason 'shutdown' — recover() auto-resumes
   * shutdown-paused missions but NEVER operator-paused ones.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pumpTimer) { clearTimeout(this.pumpTimer); this.pumpTimer = null; }
    const stops: Promise<unknown>[] = [];
    for (const entry of this.running.values()) {
      entry.runner.requestPause('shutdown');
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

  /** Request pause; true acknowledges an owned runner, not a completed pause. */
  pause(missionId: string): boolean {
    const entry = this.running.get(missionId);
    if (!entry) return false;
    entry.runner.requestPause();
    return true;
  }

  /** Cancel a running mission. */
  cancel(missionId: string): boolean {
    const entry = this.running.get(missionId);
    if (!entry) return false;
    entry.runner.requestCancel();
    return true;
  }

  status(): {
    queued: number;
    running: string[];
    admission: { deferred: boolean; reason?: string; since?: string; sample?: HostPressure };
  } {
    return {
      queued: this.queue.length,
      running: [...this.running.keys()],
      admission: this.deferral
        ? { deferred: true, reason: this.deferral.reason, since: this.deferral.since, sample: this.deferral.sample }
        : { deferred: false }
    };
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
      // Requeue missions left in resumable states. An OPERATOR pause is
      // never auto-resumed — only a pause recorded as 'shutdown ...' (daemon
      // stopping mid-flight) is picked up again. PREPARED and
      // WAITING_FOR_APPROVAL are safe to re-drive (the runner re-reads the
      // persisted approval ledger before acting on it).
      for (const m of store.listActive()) {
        if (m.state === MissionState.PREPARED || m.state === MissionState.WAITING_FOR_APPROVAL) {
          this.enqueue(repoRoot, m.id);
          continue;
        }
        if (m.state === MissionState.PAUSED) {
          const lastPause = [...m.stateHistory].reverse().find(h => h.state === MissionState.PAUSED);
          if (lastPause?.reason?.startsWith('shutdown')) {
            this.enqueue(repoRoot, m.id);
          }
        }
      }
    }
    return recovered;
  }

  private pump(delayMs = 0): void {
    if (this.stopped) return;
    if (this.pumpTimer) return; // already scheduled

    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      void this.tick();
    }, delayMs);
    this.pumpTimer.unref();
  }

  /**
   * The global cap is the MINIMUM of registered policies'
   * maxConcurrentMissions — the most restrictive registered repo wins, so
   * tightening any one repo's policy tightens the whole daemon. (The
   * previous per-repo loop had the same effective bound: every registered
   * repo was checked each tick and the first exceeded cap broke it.)
   */
  private globalCapacity(): number {
    let cap = Infinity;
    for (const p of this.policies.values()) cap = Math.min(cap, p.maxConcurrentMissions);
    return cap;
  }

  private runningIn(repoRoot: string): number {
    let n = 0;
    for (const r of this.running.values()) if (r.repoRoot === repoRoot) n++;
    return n;
  }

  /**
   * Pick the next queued mission under the documented admission order:
   * (priority asc, repo last-served seq asc, queuedAt asc). Candidates whose
   * repo is at maxConcurrentMissionsPerRepo or unregistered are skipped.
   */
  private nextCandidate(): { item: ScheduledMission; index: number } | null {
    let best: { item: ScheduledMission; index: number; served: number } | null = null;
    for (let i = 0; i < this.queue.length; i++) {
      const item = this.queue[i];
      const policy = this.policies.get(item.repoRoot);
      if (!policy) continue;
      if (this.runningIn(item.repoRoot) >= policy.maxConcurrentMissionsPerRepo) continue;
      const served = this.lastServed.get(item.repoRoot) ?? 0;
      if (!best
          || item.priority < best.item.priority
          || (item.priority === best.item.priority
              && (served < best.served
                  || (served === best.served && item.queuedAt < best.item.queuedAt)))) {
        best = { item, index: i, served };
      }
    }
    return best;
  }

  /**
   * Deferral bookkeeping: emit `mission_deferred` once per queued mission
   * per pressure episode (bounded by queue size — never a per-tick flood),
   * then re-check on the configured cadence.
   */
  private noteDeferral(decision: AdmissionDecision): void {
    const first = !this.deferral;
    this.deferral = {
      reason: decision.reason ?? 'host pressure',
      since: this.deferral?.since ?? new Date().toISOString(),
      sample: decision.sample ?? this.probe()
    };
    for (const q of this.queue) {
      if (this.deferralNotified.has(q.missionId)) continue;
      this.deferralNotified.add(q.missionId);
      this.stores.get(q.repoRoot)?.emit(q.missionId, 'mission_deferred', {
        reason: this.deferral.reason,
        loadPerCpu: Number(this.deferral.sample.loadPerCpu.toFixed(3)),
        freeMemRatio: Number(this.deferral.sample.freeMemRatio.toFixed(4)),
        recheckMs: this.admissionLimits.recheckMs
      });
    }
    if (first) {
      logger.warn('Mission admission deferred', { reason: this.deferral.reason });
      this.emit('deferred', this.deferral.reason);
    }
    // Re-check on cadence only while work waits — an idle scheduler does not
    // keep a pressure-polling timer alive. A new enqueue() pumps immediately.
    if (this.queue.length > 0) this.pump(this.admissionLimits.recheckMs);
  }

  private clearDeferral(): void {
    this.deferral = null;
    this.deferralNotified.clear();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    // Resource-aware admission: under host pressure ALL new admissions are
    // deferred (queued missions keep their place; running ones untouched).
    const decision = evaluateAdmission(this.admissionLimits, this.probe());
    if (!decision.admit) {
      this.noteDeferral(decision);
      return;
    }
    this.clearDeferral();

    // Admit until capacity or candidates run out. Each iteration removes one
    // queue entry, so the loop always terminates.
    for (;;) {
      if (this.stopped) return;
      if (this.running.size >= this.globalCapacity()) return;
      const pick = this.nextCandidate();
      if (!pick) return;
      this.queue.splice(pick.index, 1);
      this.deferralNotified.delete(pick.item.missionId);
      this.lastServed.set(pick.item.repoRoot, ++this.admissionSeq);
      const store = this.stores.get(pick.item.repoRoot);
      if (!store) continue;
      try {
        await this.startMission(store, pick.item.missionId);
      } catch (err) {
        logger.error('Failed to start mission', {
          mission: pick.item.missionId,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
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
        const tasks = mission.tasks.length > 0 ? mission.tasks
          : mission.kind === 'maintenance'
            ? maintenancePlan(mission, { hasTests: true, hasDocs: true, largeFiles: [] })
            : undefined;
        if (!tasks && !mission.planning) {
          Object.assign(mission, store.mutate(missionId, m => { m.planning = { status: 'pending' }; }));
        }
        // Preparation is non-agent work. Planning runs later under the runner's
        // lease and cumulative budget, against the allocated mission workspace.
        await prepareMission(mission, store, { plannerTasks: tasks });
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
