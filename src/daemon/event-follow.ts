import { statSync, openSync, readSync, closeSync } from 'fs';
import type { ServerResponse } from 'http';
import { isTerminal } from '../mission/state-machine.js';
import type { MissionState, RuntimeEvent } from '../types.js';
import { logger } from '../logger.js';

/**
 * Live tail of a mission's append-only events.jsonl as NDJSON
 * (`application/x-ndjson`) for `GET /v1/missions/:id/events?follow`.
 *
 * NDJSON rather than SSE: the persisted log is already one bounded JSON
 * object per line, every other API surface here is plain JSON, and the
 * bearer token means cockpit consumers use fetch() — not EventSource,
 * which cannot set Authorization headers. Replayed bytes are the exact
 * persisted lines; nothing is re-serialized.
 *
 * Line contract: lines that parse to an object with a numeric `seq` are
 * RuntimeEvents. Control lines carry a `meta` key instead and never carry
 * `seq`/`type` of a real event:
 *   {"meta":"begin","missionId","state","after","at"}      — first line
 *   {"meta":"heartbeat","at"}                              — keepalive
 *   {"meta":"end","reason","state"?,"skippedLines","at"}   — final line
 * `reason` is 'terminal' | 'limit' | 'shutdown' | 'gone' | 'error'.
 *
 * Bounds (no unbounded memory or sockets):
 * - The file is re-read incrementally by byte offset each poll — never
 *   buffered whole. A poll consumes at most maxReadBytes; a single line
 *   larger than maxLineBytes is dropped as skipped (writers produce
 *   bounded payloads, so an oversized line means corruption).
 * - A torn final line (partial append) is held until its newline lands.
 * - Backpressure pauses file consumption — data stays on disk.
 * - The stream ALWAYS ends: terminal state (after a short drain window so
 *   trailing events emitted just after the state flip are captured),
 *   maxDurationMs, server shutdown, or client disconnect.
 */
export interface FollowLimits {
  /** Event-log poll cadence, ms. */
  pollMs?: number;
  /** Keepalive meta-line cadence, ms. */
  heartbeatMs?: number;
  /** Hard lifetime cap per connection, ms. */
  maxDurationMs?: number;
  /** Extra drain window after a terminal state is first observed, ms. */
  drainMs?: number;
  /** Max bytes consumed from the log per poll. */
  maxReadBytes?: number;
  /** Max accepted length of one event line. */
  maxLineBytes?: number;
}

export interface ResolvedFollowLimits {
  pollMs: number;
  heartbeatMs: number;
  maxDurationMs: number;
  drainMs: number;
  maxReadBytes: number;
  maxLineBytes: number;
}

export const FOLLOW_DEFAULTS: ResolvedFollowLimits = {
  pollMs: 500,
  heartbeatMs: 15_000,
  maxDurationMs: 30 * 60_000,
  drainMs: 750,
  maxReadBytes: 512 * 1024,
  maxLineBytes: 256 * 1024
};

export function resolveFollowLimits(limits?: FollowLimits): ResolvedFollowLimits {
  const pick = (v: number | undefined, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt;
  return {
    pollMs: pick(limits?.pollMs, FOLLOW_DEFAULTS.pollMs),
    heartbeatMs: pick(limits?.heartbeatMs, FOLLOW_DEFAULTS.heartbeatMs),
    maxDurationMs: pick(limits?.maxDurationMs, FOLLOW_DEFAULTS.maxDurationMs),
    drainMs: pick(limits?.drainMs, FOLLOW_DEFAULTS.drainMs),
    maxReadBytes: pick(limits?.maxReadBytes, FOLLOW_DEFAULTS.maxReadBytes),
    maxLineBytes: pick(limits?.maxLineBytes, FOLLOW_DEFAULTS.maxLineBytes)
  };
}

export type FollowEndReason = 'terminal' | 'limit' | 'shutdown' | 'gone' | 'error';

export interface MissionEventFollowerArgs {
  res: ServerResponse;
  missionId: string;
  /** Absolute path of the mission's events.jsonl */
  eventsPath: string;
  /** Only events with seq > afterSeq are forwarded (0 = from the start). */
  afterSeq: number;
  /** Current persisted mission state; may throw (corrupt) and return null (gone). */
  loadState: () => MissionState | null;
  limits: ResolvedFollowLimits;
  /** Called exactly once when the stream is fully closed. */
  onDone: (f: MissionEventFollower) => void;
}

export class MissionEventFollower {
  private readonly res: ServerResponse;
  private readonly limits: ResolvedFollowLimits;
  private offset = 0;
  /** Undecoded remainder bytes — multi-byte UTF-8 may split across polls. */
  private tail = Buffer.alloc(0);
  private skippedLines = 0;
  private outbox: string[] = [];
  private backpressured = false;
  private ended = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(private readonly args: MissionEventFollowerArgs) {
    this.res = args.res;
    this.limits = args.limits;
  }

  /** Begin the stream: begin meta line, initial replay, then live tailing. */
  start(initialState: MissionState | null): void {
    this.writeMeta({ meta: 'begin', missionId: this.args.missionId, state: initialState, after: this.args.afterSeq });
    this.res.on('drain', () => {
      this.backpressured = false;
      this.flushOutbox();
    });
    this.res.on('close', () => this.end('shutdown', undefined, /*silent*/ true));
    this.res.on('error', () => this.end('error', undefined, true));

    this.poll();
    if (this.ended) return;

    this.pollTimer = setInterval(() => this.poll(), this.limits.pollMs);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.limits.heartbeatMs);
    this.deadlineTimer = setTimeout(() => this.end('limit'), this.limits.maxDurationMs);
    for (const t of [this.pollTimer, this.heartbeatTimer, this.deadlineTimer]) t.unref();
  }

  /** Idempotent close — reason 'shutdown' is also used for client disconnect. */
  end(reason: FollowEndReason, state?: MissionState, silent = false): void {
    if (this.ended) return;
    this.ended = true;
    for (const t of [this.pollTimer, this.heartbeatTimer, this.deadlineTimer, this.drainTimer]) {
      if (t) clearTimeout(t);
    }
    if (!silent && !this.res.writableEnded && !this.res.destroyed) {
      // Flush queued event lines ahead of the end marker — ordering matters
      // even when the peer stopped reading (the socket buffer absorbs the
      // bounded remainder; outbox is capped by maxReadBytes per poll).
      for (const line of this.outbox) {
        try { this.res.write(line + '\n'); } catch { break; }
      }
      this.outbox = [];
      this.writeMeta({ meta: 'end', reason, state, skippedLines: this.skippedLines });
      this.res.end();
    } else {
      try { this.res.destroy(); } catch { /* already gone */ }
    }
    this.args.onDone(this);
  }

  // ── internals ────────────────────────────────────────────────────────

  private writeMeta(obj: Record<string, unknown>): void {
    try {
      if (!this.res.writableEnded && !this.res.destroyed) {
        this.res.write(JSON.stringify({ ...obj, at: new Date().toISOString() }) + '\n');
      }
    } catch { /* socket already gone — close event will finish cleanup */ }
  }

  private heartbeat(): void {
    if (this.ended || this.backpressured) return;
    this.writeMeta({ meta: 'heartbeat' });
  }

  private poll(): void {
    if (this.ended || this.backpressured) return;
    try {
      this.drainFile();
      this.flushOutbox();
    } catch (err) {
      logger.warn('event follow poll failed', {
        mission: this.args.missionId,
        error: err instanceof Error ? err.message : String(err)
      });
      this.end('error');
      return;
    }

    let state: MissionState | null;
    try {
      state = this.args.loadState();
    } catch {
      this.end('error');
      return;
    }
    if (this.ended) return;
    if (state === null) { this.end('gone'); return; }
    // Terminal states are immutable, so once observed the drain timer stays
    // armed: it gives writes that landed just after the state flip (e.g.
    // mission_completed emitted after the terminal transition) one final
    // window to reach the log before the stream closes.
    if (isTerminal(state) && !this.drainTimer) {
      this.drainTimer = setTimeout(() => {
        this.pollDrainOnly();
        this.end('terminal', state);
      }, this.limits.drainMs);
      this.drainTimer.unref();
    }
  }

  /** Final file drain used when the terminal drain timer fires. */
  private pollDrainOnly(): void {
    try {
      this.drainFile();
      this.flushOutbox();
    } catch { /* closing anyway — the end line still reports skippedLines */ }
  }

  /** Consume up to maxReadBytes of newly appended data since the last poll. */
  private drainFile(): void {
    let size: number;
    try {
      size = statSync(this.args.eventsPath).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // not created yet
      throw err;
    }
    if (size < this.offset) { this.offset = 0; this.tail = Buffer.alloc(0); } // recreated/truncated
    const wanted = Math.min(size - this.offset, this.limits.maxReadBytes);
    if (wanted <= 0) return;

    const buf = Buffer.alloc(wanted);
    const fd = openSync(this.args.eventsPath, 'r');
    let read = 0;
    try {
      read = readSync(fd, buf, 0, wanted, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset += read;

    // Split on the 0x0A byte BEFORE decoding — a partial line or a UTF-8
    // sequence straddling the read boundary stays intact in `tail`.
    const chunk = this.tail.length > 0
      ? Buffer.concat([this.tail, buf.subarray(0, read)])
      : buf.subarray(0, read);
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue;
      const raw = chunk.subarray(start, i);
      start = i + 1;
      if (raw.length === 0) continue;
      if (raw.length > this.limits.maxLineBytes) { this.skippedLines++; continue; }
      const line = raw.toString('utf-8');
      let evt: RuntimeEvent;
      try { evt = JSON.parse(line) as RuntimeEvent; }
      catch { this.skippedLines++; continue; }
      if ((evt.seq ?? 0) > this.args.afterSeq) this.outbox.push(line);
    }
    this.tail = chunk.subarray(start);
    if (this.tail.length > this.limits.maxLineBytes) {
      this.skippedLines++;
      this.tail = Buffer.alloc(0);
    }
  }

  private flushOutbox(): void {
    while (this.outbox.length > 0 && !this.res.writableEnded && !this.res.destroyed) {
      if (!this.res.write(this.outbox[0] + '\n')) {
        this.backpressured = true;
        return; // remainder stays queued; 'drain' resumes
      }
      this.outbox.shift();
    }
  }
}
