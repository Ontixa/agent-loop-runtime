import { join } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { readJsonFile, writeJsonAtomic, writeFileAtomic, ensureDir, appendLine } from '../util/atomic-file.js';
import { assertTransition, isTerminal } from './state-machine.js';
import type { Mission, RuntimeEvent, MissionState } from '../types.js';
import { redactValue } from '../util/redact.js';
import { logger } from '../logger.js';

/**
 * Mission store — durable, atomic, per-mission directory:
 *
 *   <repo>/.agentloop/missions/<id>/
 *     mission.json      — canonical mission record (atomic writes)
 *     events.jsonl      — append-only structured event log
 *     approvals.json    — pending/decided approval gates
 *     receipt.json      — final execution receipt (terminal states)
 *     agent-*.log       — bounded agent output logs
 */

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

export class MissionStore {
  constructor(public readonly repoRoot: string) {
    ensureDir(missionsRoot(repoRoot));
    // Keep runtime state invisible to git status even before any worktree exists
    const gitignorePath = join(repoRoot, '.agentloop', '.gitignore');
    if (!existsSync(gitignorePath)) {
      writeFileAtomic(gitignorePath, '# Agent Loop Runtime state — never commit\n*\n');
    }
  }

  /** Persist a mission record atomically. */
  save(mission: Mission): void {
    mission.updatedAt = new Date().toISOString();
    writeJsonAtomic(join(missionDir(this.repoRoot, mission.id), 'mission.json'), mission);
  }

  /** Load a mission by id. */
  load(id: string): Mission | null {
    const m = readJsonFile<Mission>(join(missionDir(this.repoRoot, id), 'mission.json'));
    return m ?? null;
  }

  /** Load a mission or throw. */
  mustLoad(id: string): Mission {
    const m = this.load(id);
    if (!m) throw new Error(`Mission not found: ${id}`);
    return m;
  }

  /** List all missions (sorted newest first). */
  list(): Mission[] {
    const root = missionsRoot(this.repoRoot);
    if (!existsSync(root)) return [];
    const out: Mission[] = [];
    for (const entry of readdirSync(root)) {
      const m = this.load(entry);
      if (m) out.push(m);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Find missions in non-terminal states (for resume/scheduler). */
  listActive(): Mission[] {
    return this.list().filter(m => !isTerminal(m.state));
  }

  /**
   * Transition a mission to a new state, persisting atomically and appending
   * a state_changed event. Throws IllegalTransitionError for illegal moves.
   */
  transition(mission: Mission, to: MissionState, reason?: string): Mission {
    assertTransition(mission.state, to);
    const at = new Date().toISOString();
    mission.state = to;
    mission.stateHistory.push({ state: to, at, reason });
    this.save(mission);
    this.emit(mission.id, 'state_changed', { from: mission.stateHistory.at(-2)?.state, to, reason });
    return mission;
  }

  /** Append a structured event to events.jsonl (redacted, bounded). */
  emit(missionIdValue: string, type: RuntimeEvent['type'], data?: Record<string, unknown>): RuntimeEvent {
    const evt: RuntimeEvent = {
      type,
      at: new Date().toISOString(),
      missionId: missionIdValue,
      data: data ? redactValue(data) : undefined
    };
    try {
      appendLine(join(missionDir(this.repoRoot, missionIdValue), 'events.jsonl'), JSON.stringify(evt));
    } catch (err) {
      logger.warn('Failed to append mission event', {
        mission: missionIdValue,
        error: err instanceof Error ? err.message : String(err)
      });
    }
    return evt;
  }

  /** Read all events for a mission. */
  events(id: string): RuntimeEvent[] {
    const path = join(missionDir(this.repoRoot, id), 'events.jsonl');
    try {
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(l => { try { return JSON.parse(l) as RuntimeEvent; } catch { return null; } })
        .filter((e): e is RuntimeEvent => e !== null);
    } catch {
      return [];
    }
  }

  dir(id: string): string {
    return missionDir(this.repoRoot, id);
  }
}
