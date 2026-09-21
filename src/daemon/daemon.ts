import { mkdirSync } from 'fs';
import { join } from 'path';
import { MissionStore } from '../mission/mission-store.js';
import { MissionScheduler } from '../engine/scheduler.js';
import { detectStaleMissions } from '../engine/recovery.js';
import type { Policy, RuntimeConfig } from '../types.js';
import { loadPolicy } from '../policy/policy.js';
import { writeJsonAtomic } from '../util/atomic-file.js';
import { ControlApi } from './control-api.js';
import { logger } from '../logger.js';

/**
 * agentloop daemon — long-running mission scheduler + loopback control API.
 *
 * On start: recovers interrupted missions (running → stale → resumed),
 * re-enqueues anything recoverable, serves the API. On SIGINT/SIGTERM:
 * requests graceful shutdown of active missions (paused, not killed) and
 * stops accepting new work.
 */

export interface DaemonOptions {
  repos: string[];
  config?: RuntimeConfig['daemon'];
  scheduler: MissionScheduler;
  version: string;
}

const STALE_SWEEP_MS = 60_000;

export class Daemon {
  private api: ControlApi;
  private stores = new Map<string, { store: MissionStore; policy: Policy }>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  readonly startedAt = Date.now();

  constructor(private readonly opts: DaemonOptions) {
    const cfg = opts.config ?? {};
    this.api = new ControlApi({
      host: cfg.host ?? '127.0.0.1',
      port: cfg.port ?? 3210,
      token: cfg.token ?? process.env.AGENTLOOP_API_TOKEN,
      corsOrigins: cfg.corsOrigins,
      repos: this.stores,
      scheduler: opts.scheduler,
      version: opts.version,
      startedAt: this.startedAt
    });
  }

  async start(): Promise<void> {
    // Prepare stores and register repos with the scheduler
    for (const repo of this.opts.repos) {
      const store = new MissionStore(repo);
      const { policy } = loadPolicy(repo);
      this.stores.set(repo, { store, policy });
      this.opts.scheduler.registerRepo(repo, store, policy);
    }

    // Recover interrupted missions and requeue resumable ones
    const recovered = await this.opts.scheduler.recover();
    if (recovered.length > 0) {
      logger.info(`Recovered ${recovered.length} interrupted mission(s)`, { missions: recovered });
    }

    // PID/status file so `agentloop status` can find a running daemon.
    // The bearer token is stored here so operator tooling (same UID) can
    // authenticate. This is NOT a boundary against agent processes running
    // as the same OS user — see docs/threat-model.md.
    await this.api.start();
    try {
      const dir = join(process.env.AGENTLOOP_HOME ?? join(process.cwd(), '.agentloop'));
      mkdirSync(dir, { recursive: true });
      // Restrict the temporary file from creation, before writing the bearer.
      // Windows operators must also restrict the directory's inherited ACL.
      writeJsonAtomic(join(dir, 'daemon.json'), {
        pid: process.pid,
        startedAt: new Date(this.startedAt).toISOString(),
        url: this.api.url,
        token: this.api.bearerToken,
        repos: this.opts.repos
      }, 0o600);
    } catch (error) {
      // Do not leave an undiscoverable listener or install timers/signals.
      await this.api.stop();
      throw error;
    }

    this.sweepTimer = setInterval(() => void this.sweepStale(), STALE_SWEEP_MS);
    this.sweepTimer.unref();

    const shutdown = () => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      void this.stop();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    logger.info(`Daemon started, serving ${this.opts.repos.length} repo(s)`);
  }

  /**
   * Mark heartbeats that have gone silent as stale; do not kill missions.
   * Covers every active state (running/validating/repairing/waiting), not
   * just 'running' — a runner can die mid-validation too. Missions this
   * daemon's scheduler owns are skipped (same pid).
   */
  private async sweepStale(): Promise<void> {
    if (this.stopping) return;
    for (const { store } of this.stores.values()) {
      const stale = await detectStaleMissions(store);
      for (const m of stale) {
        // Mark only — recovery (and requeue) is a deliberate operator action
        // via resume; an unattended daemon must not auto-re-drive missions.
        logger.warn('Mission marked stale — needs explicit resume', { mission: m.id });
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    logger.info('Daemon shutting down — pausing active missions');
    if (this.sweepTimer) clearInterval(this.sweepTimer);

    // Pause rather than kill active missions — they resume on next daemon start.
    // scheduler.stop() requests pause on each runner and awaits their promises.
    await this.opts.scheduler.stop();

    await this.api.stop();
    logger.info('Daemon stopped');
    // No process.exit() here: stop() is a clean async teardown so the Daemon
    // can be embedded in tests/other processes. With the API closed and the
    // sweep timer cleared, the event loop drains and the process exits.
  }
}
