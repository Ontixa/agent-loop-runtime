import { join } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import {
  readJsonFile, readJsonFileChecked, writeJsonAtomic, writeFileAtomic,
  ensureDir, appendLine, withFileLock
} from '../util/atomic-file.js';
import { assertTransition, isTerminal } from './state-machine.js';
import { MissionState } from '../types.js';
import type { Mission, RuntimeEvent, MissionRunnerInfo } from '../types.js';
import { redactValue } from '../util/redact.js';
import { logger } from '../logger.js';

/**
 * Mission store — durable, atomic, per-mission directory:
 *
 *   <repo>/.agentloop/missions/<id>/
 *     mission.json      — canonical mission record (atomic CAS writes)
 *     mission.json.lock — cross-process mutation lock
 *     events.jsonl      — append-only structured event log
 *     events.seq        — monotonic event sequence counter
 *     approvals.json    — pending/decided approval gates
 *     receipt.json      — final execution receipt (terminal states)
 *     agent-*.log       — bounded agent output logs
 *
 * Consistency model (single host):
 * - Every mission.json mutation happens under mission.json.lock, which is
 *   created exclusively ('wx'). A lock left by a dead process is broken.
 * - mission.revision is a compare-and-swap counter: a writer holding a stale
 *   in-memory copy fails loudly instead of clobbering newer state.
 * - A corrupt mission.json is NEVER silently treated as absent — the file is
 *   preserved, loads throw CorruptStateError, and list() reports it via
 *   listCorrupt() so operators see the damage instead of a blank mission.
 * - events.jsonl carries seq + unique event ids so re-reads can detect
 *   duplicates. Ops are recorded, not exactly-once.
 */

export class RevisionConflictError extends Error {
  constructor(public readonly missionId: string, expected: number, found: number) {
    super(`Mission ${missionId} revision conflict: expected ${expected}, found ${found} — another writer changed it`);
    this.name = 'RevisionConflictError';
    Object.setPrototypeOf(this, RevisionConflictError.prototype);
  }
}

export class CorruptStateError extends Error {
  constructor(public readonly missionId: string, detail: string) {
    super(`Mission ${missionId} state is corrupt (file preserved for diagnosis): ${detail}`);
    this.name = 'CorruptStateError';
    Object.setPrototypeOf(this, CorruptStateError.prototype);
  }
}

export class RunnerConflictError extends Error {
  constructor(missionId: string, owner: MissionRunnerInfo) {
    super(`Mission ${missionId} is already owned by live runner pid=${owner.pid} nonce=${owner.nonce.slice(0, 8)}`);
    this.name = 'RunnerConflictError';
    Object.setPrototypeOf(this, RunnerConflictError.prototype);
  }
}

export function missionId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return `msn-${ts}-${randomBytes(3).toString('hex')}`;
}

export function missionsRoot(repoRoot: string): string {
  return join(repoRoot, '.agentloop', 'missions');
}

export function missionDir(repoRoot: string, id: string): string {
  return join(missionsRoot(repoRoot), id);
}

const LOCK_NAME = 'mission.json.lock';
const EVENTS_LOCK_NAME = 'events.lock';

/** Normalize a mission loaded from disk (schema-1 files may lack new fields). */
function normalizeLoaded(m: Mission): Mission {
  m.revision = typeof m.revision === 'number' ? m.revision : 0;
  if (!Array.isArray(m.stateHistory)) m.stateHistory = [{ state: m.state, at: m.updatedAt ?? m.createdAt }];
  if (!Array.isArray(m.tasks)) m.tasks = [];
  if (!Array.isArray(m.passes)) m.passes = [];
  if (!Array.isArray(m.approvals)) m.approvals = [];
  if (!Array.isArray(m.checkpoints)) m.checkpoints = [];
  if (!m.usage) m.usage = { agentInvocations: 0, repairPasses: 0, wallTimeMs: 0 };
  return m;
}

export class MissionStore {
  constructor(public readonly repoRoot: string) {
    ensureDir(missionsRoot(repoRoot));
    // Keep runtime state invisible to git status even before any worktree exists
    const gitignorePath = join(repoRoot, '.agentloop', '.gitignore');
    if (!existsSync(gitignorePath)) {
      writeFileAtomic(gitignorePath, '# Agent Loop Runtime state — never commit\n*\n');
    }
  }

  private lockPath(id: string): string {
    return join(missionDir(this.repoRoot, id), LOCK_NAME);
  }

  private missionPath(id: string): string {
    return join(missionDir(this.repoRoot, id), 'mission.json');
  }

  /**
   * Persist a mission record atomically with compare-and-swap on revision.
   * The caller's `mission.revision` must match the revision on disk — saving
   * a stale copy throws RevisionConflictError instead of clobbering.
   */
  save(mission: Mission): void {
    withFileLock(this.lockPath(mission.id), () => this.saveLocked(mission));
  }

  /** Locked-section save. Caller must hold the mission lock. */
  private saveLocked(mission: Mission): void {
    const path = this.missionPath(mission.id);
    const disk = readJsonFileChecked<Mission>(path);
    if (disk.status === 'corrupt') {
      throw new CorruptStateError(mission.id, `refusing to overwrite corrupt mission.json (${disk.error})`);
    }
    const expected = mission.revision ?? 0;
    const found = disk.status === 'ok' ? (disk.value.revision ?? 0) : 0;
    if (disk.status === 'ok' && found !== expected) {
      throw new RevisionConflictError(mission.id, expected, found);
    }
    if (disk.status === 'missing' && expected !== 0) {
      throw new RevisionConflictError(mission.id, expected, 0);
    }
    mission.revision = expected + 1;
    mission.updatedAt = new Date().toISOString();
    writeJsonAtomic(path, mission);
  }

  /**
   * Read-modify-write under the mission lock: load fresh, apply `fn`, save.
   * This is the canonical way to mutate a mission — `fn` always sees the
   * persisted truth, never a stale in-memory copy.
   */
  mutate<T = Mission>(id: string, fn: (mission: Mission) => T | void): Mission {
    return withFileLock(this.lockPath(id), () => {
      const fresh = this.loadFreshLocked(id);
      const result = fn(fresh);
      this.saveLocked(fresh);
      return (result as Mission) ?? fresh;
    });
  }

  private loadFreshLocked(id: string): Mission {
    const disk = readJsonFileChecked<Mission>(this.missionPath(id));
    if (disk.status === 'corrupt') throw new CorruptStateError(id, disk.error ?? 'unparseable');
    if (disk.status === 'missing') throw new Error(`Mission not found: ${id}`);
    return normalizeLoaded(disk.value);
  }

  /** Load a mission by id; null when absent. Throws CorruptStateError when corrupt. */
  load(id: string): Mission | null {
    const disk = readJsonFileChecked<Mission>(this.missionPath(id));
    if (disk.status === 'missing') return null;
    if (disk.status === 'corrupt') throw new CorruptStateError(id, disk.error ?? 'unparseable');
    return normalizeLoaded(disk.value);
  }

  /** Load a mission or throw (not found OR corrupt). */
  mustLoad(id: string): Mission {
    const m = this.load(id);
    if (!m) throw new Error(`Mission not found: ${id}`);
    return m;
  }

  /** List all missions (sorted newest first). Corrupt records are skipped — see listCorrupt(). */
  list(): Mission[] {
    const root = missionsRoot(this.repoRoot);
    if (!existsSync(root)) return [];
    const out: Mission[] = [];
    for (const entry of readdirSync(root)) {
      try {
        const m = this.load(entry);
        if (m) out.push(m);
      } catch (err) {
        if (err instanceof CorruptStateError) continue; // surfaced via listCorrupt()
        throw err;
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Mission directories whose mission.json is present but unparseable.
   * The corrupt bytes are preserved in place — operators must inspect them.
   */
  listCorrupt(): Array<{ id: string; error: string }> {
    const root = missionsRoot(this.repoRoot);
    if (!existsSync(root)) return [];
    const out: Array<{ id: string; error: string }> = [];
    for (const entry of readdirSync(root)) {
      const disk = readJsonFileChecked<Mission>(this.missionPath(entry));
      if (disk.status === 'corrupt') out.push({ id: entry, error: disk.error ?? 'unparseable' });
    }
    return out;
  }

  /** Find missions in non-terminal states (for resume/scheduler). */
  listActive(): Mission[] {
    return this.list().filter(m => !isTerminal(m.state));
  }

  /**
   * Transition a mission to a new state. The legality check runs on the
   * PERSISTED state under lock — a caller's stale in-memory copy can never
   * force an illegal move. On success the passed object is updated to the
   * persisted record.
   */
  transition(mission: Mission, to: MissionState, reason?: string, opId?: string): Mission {
    let fromState: MissionState | undefined;
    const updated = this.mutate(mission.id, (fresh) => {
      assertTransition(fresh.state, to);
      fromState = fresh.state;
      const at = new Date().toISOString();
      fresh.state = to;
      fresh.stateHistory.push({ state: to, at, reason, ...(opId ? { opId } : {}) });
    });
    // Emit after the mission lock is released — event append takes the
    // separate events lock (lock order: mission → events, never reversed).
    this.emit(mission.id, 'state_changed', { from: fromState, to, reason, ...(opId ? { opId } : {}) });
    Object.assign(mission, updated);
    return mission;
  }

  /**
   * Claim a mission for this runner. Under the lock: refuse if another LIVE
   * runner holds it (heartbeat fresh and pid alive); take over from a dead
   * owner by marking the mission stale-side-effects aside — the caller
   * (recovery) is responsible for auditing interrupted work.
   *
   * Returns the claimed mission. Throws RunnerConflictError if a different
   * live runner owns it.
   */
  claimForRun(id: string, runner: MissionRunnerInfo, opts: { staleAfterMs: number; pidAlive: (pid: number) => boolean }): Mission {
    const claimed = this.mutate(id, (fresh) => {
      if (isTerminal(fresh.state)) return; // nothing to claim — run() will no-op
      const existing = fresh.runner;
      if (existing && existing.nonce !== runner.nonce) {
        const hb = Date.parse(existing.heartbeatAt);
        const beatFresh = Number.isFinite(hb) && (Date.now() - hb) < opts.staleAfterMs;
        const alive = existing.pid ? opts.pidAlive(existing.pid) : false;
        if (alive && beatFresh && existing.pid !== process.pid) {
          throw new RunnerConflictError(id, existing);
        }
      }
      fresh.runner = runner;
    });
    this.emit(id, 'runner_claimed', {
      pid: runner.pid, nonce: runner.nonce.slice(0, 8)
    });
    return claimed;
  }

  /** Release the runner claim if — and only if — we still own it. */
  releaseRunner(id: string, nonce: string): void {
    withFileLock(this.lockPath(id), () => {
      let fresh: Mission;
      try { fresh = this.loadFreshLocked(id); } catch { return; }
      if (fresh.runner?.nonce === nonce) {
        fresh.runner = undefined;
        this.saveLocked(fresh);
      }
    });
  }

  /** Update heartbeat if we still own the mission. Returns false on lease loss. */
  heartbeat(id: string, nonce: string, hbSeq: number): boolean {
    try {
      return withFileLock(this.lockPath(id), () => {
        const fresh = this.loadFreshLocked(id);
        if (fresh.runner?.nonce !== nonce) return false;
        fresh.runner.heartbeatAt = new Date().toISOString();
        fresh.runner.hbSeq = hbSeq;
        fresh.usage.wallTimeMs = fresh.usage.startedAt
          ? Date.now() - Date.parse(fresh.usage.startedAt) : 0;
        this.saveLocked(fresh);
        return true;
      });
    } catch {
      return false; // corrupt/missing → we can't claim ownership
    }
  }

  /** Append a structured event to events.jsonl (redacted, bounded, sequenced). */
  emit(missionIdValue: string, type: RuntimeEvent['type'], data?: Record<string, unknown>): RuntimeEvent {
    const dir = missionDir(this.repoRoot, missionIdValue);
    const lockPath = join(dir, EVENTS_LOCK_NAME);
    try {
      return withFileLock(lockPath, () => this.emitLocked(missionIdValue, type, data));
    } catch (err) {
      // Event log failure must never crash a mission — warn and synthesize the
      // event in memory (unsequenced) so callers still have the object.
      logger.warn('Failed to append mission event', {
        mission: missionIdValue,
        error: err instanceof Error ? err.message : String(err)
      });
      return { type, at: new Date().toISOString(), missionId: missionIdValue, data: data ? redactValue(data) : undefined };
    }
  }

  /** Emit inside an already-held mission lock (used by transition/mutate). */
  private emitLocked(missionIdValue: string, type: RuntimeEvent['type'], data?: Record<string, unknown>): RuntimeEvent {
    const dir = missionDir(this.repoRoot, missionIdValue);
    const seq = this.nextEventSeqLocked(dir);
    const evt: RuntimeEvent = {
      id: `evt_${randomBytes(6).toString('hex')}`,
      seq,
      type,
      at: new Date().toISOString(),
      missionId: missionIdValue,
      data: data ? redactValue(data) : undefined
    };
    appendLine(join(dir, 'events.jsonl'), JSON.stringify(evt));
    return evt;
  }

  private nextEventSeqLocked(dir: string): number {
    const seqPath = join(dir, 'events.seq');
    let cur = 0;
    try { cur = Number(readFileSync(seqPath, 'utf-8').trim()) || 0; } catch { /* first event */ }
    const next = cur + 1;
    writeFileAtomic(seqPath, String(next));
    return next;
  }

  /**
   * Read events for a mission with diagnostics: torn/corrupt lines are
   * counted, not silently dropped.
   */
  readEvents(id: string): { events: RuntimeEvent[]; skippedLines: number } {
    const path = join(missionDir(this.repoRoot, id), 'events.jsonl');
    try {
      if (!existsSync(path)) return { events: [], skippedLines: 0 };
      const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
      const events: RuntimeEvent[] = [];
      let skippedLines = 0;
      for (const l of lines) {
        try { events.push(JSON.parse(l) as RuntimeEvent); }
        catch { skippedLines++; }
      }
      return { events, skippedLines };
    } catch {
      return { events: [], skippedLines: 0 };
    }
  }

  /** Read all events for a mission. */
  events(id: string): RuntimeEvent[] {
    return this.readEvents(id).events;
  }

  dir(id: string): string {
    return missionDir(this.repoRoot, id);
  }
}
