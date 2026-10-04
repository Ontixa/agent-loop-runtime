import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionEventFollower, resolveFollowLimits, type FollowLimits } from '../daemon/event-follow.js';
import { MissionState } from '../types.js';

class Response extends EventEmitter {
  readonly lines: Array<Record<string, unknown>> = [];
  writableEnded = false;
  destroyed = false;
  constructor(private readonly pressure = false) { super(); }
  write(line: string): boolean {
    const value = JSON.parse(line) as Record<string, unknown>;
    this.lines.push(value);
    return !(this.pressure && typeof value.seq === 'number');
  }
  end(): void { this.writableEnded = true; }
  destroy(): void { this.destroyed = true; }
  seqs(): number[] { return this.lines.filter(l => typeof l.seq === 'number').map(l => l.seq as number); }
}

function event(seq: number, type = 'checkpoint_created'): string {
  const value = { seq, type, missionId: 'fixture', at: '2026-10-03T00:00:00.000Z', data: { payload: '' } };
  value.data.payload = 'x'.repeat(1024 - Buffer.byteLength(JSON.stringify(value)) - 1);
  return JSON.stringify(value) + '\n';
}

function fixture(t: TestContext, opts: {
  count?: number; after?: number; state?: MissionState; pressure?: boolean; limits?: FollowLimits;
} = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  // Early Node 20 MockTimers.tick fails if a callback clears the entire queue.
  // This inert timer outlives every test advance and is removed by reset().
  setTimeout(() => {}, 60 * 60_000);
  const dir = mkdtempSync(join(tmpdir(), 'alr-terminal-follow-'));
  const eventsPath = join(dir, 'events.jsonl');
  const count = opts.count ?? 2048;
  writeFileSync(eventsPath, Array.from({ length: count }, (_, i) =>
    event(i + 1, i === count - 1 ? 'mission_completed' : 'checkpoint_created')).join(''));
  const res = new Response(opts.pressure);
  let state = opts.state ?? MissionState.COMPLETED;
  let done = 0;
  const follower = new MissionEventFollower({
    res: res as unknown as ServerResponse, missionId: 'fixture', eventsPath,
    afterSeq: opts.after ?? 0, loadState: () => state,
    limits: resolveFollowLimits(opts.limits), onDone: () => { done++; }
  });
  t.after(() => {
    follower.end('shutdown', undefined, true);
    t.mock.timers.reset();
    rmSync(dir, { recursive: true, force: true });
  });
  return { res, follower, eventsPath, done: () => done, setState: (next: MissionState) => { state = next; } };
}

function endReason(res: Response): unknown { return res.lines.at(-1)?.reason; }
function advance(t: TestContext, ms: number): void { t.mock.timers.tick(ms); }

for (const after of [0, 1536]) {
  test(`terminal replay drains a 2 MiB log with production defaults after=${after}`, t => {
    const f = fixture(t, { after });
    f.follower.start(MissionState.COMPLETED);
    advance(t, 500);
    advance(t, 250);
    assert.equal(f.res.writableEnded, false, 'grace expiry must not discard unread backlog');
    assert.equal(f.res.seqs().length, after === 0 ? 1536 : 0, 'reads remain capped at 512 KiB');
    advance(t, 250);
    assert.deepEqual(f.res.seqs(), Array.from({ length: 2048 - after }, (_, i) => after + i + 1));
    assert.equal(f.res.lines.at(-2)?.type, 'mission_completed');
    assert.equal(endReason(f.res), 'terminal');
    assert.equal(f.res.lines.at(-1)?.skippedLines, 0);
    assert.equal(f.done(), 1);
  });
}

test('a live follower drains its backlog and within-grace appends after a terminal transition', t => {
  const f = fixture(t, { state: MissionState.RUNNING });
  f.follower.start(MissionState.RUNNING);
  f.setState(MissionState.COMPLETED);
  advance(t, 500); // terminal first observed; grace ends at 1250
  advance(t, 500);
  appendFileSync(f.eventsPath, event(2049, 'mission_completed'));
  advance(t, 250);
  assert.equal(f.res.writableEnded, false);
  advance(t, 250);
  assert.deepEqual(f.res.seqs(), Array.from({ length: 2049 }, (_, i) => i + 1));
  assert.equal(endReason(f.res), 'terminal');
});

test('an already caught-up follower still waits for terminal grace and captures trailing events', t => {
  const f = fixture(t, { count: 1 });
  f.follower.start(MissionState.COMPLETED);
  advance(t, 500);
  advance(t, 249);
  assert.equal(f.res.writableEnded, false);
  appendFileSync(f.eventsPath, event(2, 'mission_completed'));
  advance(t, 1);
  assert.deepEqual(f.res.seqs(), [1, 2]);
  assert.equal(endReason(f.res), 'terminal');
});

test('terminal grace respects sustained backpressure and resumes bounded replay exactly once', t => {
  const f = fixture(t, { count: 17, pressure: true,
    limits: { maxReadBytes: 4096, pollMs: 10, drainMs: 15, maxDurationMs: 1000 } });
  f.follower.start(MissionState.COMPLETED);
  advance(t, 10);
  advance(t, 5);
  assert.deepEqual(f.res.seqs(), [1], 'grace timer must not write or read through backpressure');
  assert.equal(f.res.writableEnded, false);
  for (let i = 0; i < 16; i++) {
    f.res.emit('drain');
    advance(t, 10);
  }
  assert.deepEqual(f.res.seqs(), Array.from({ length: 17 }, (_, i) => i + 1));
  assert.equal(f.res.writableEnded, false, 'the final accepted write(false) still needs drain');
  f.res.emit('drain');
  advance(t, 10);
  assert.equal(endReason(f.res), 'terminal');
  assert.equal(f.done(), 1);
});

test('a peer that never drains still ends at the hard deadline with reason limit', t => {
  const f = fixture(t, { pressure: true, limits: { maxDurationMs: 1200 } });
  f.follower.start(MissionState.COMPLETED);
  advance(t, 500);
  advance(t, 250);
  assert.deepEqual(f.res.seqs(), [1]);
  assert.equal(f.res.writableEnded, false);
  advance(t, 450);
  assert.equal(endReason(f.res), 'limit');
  assert.equal(f.res.lines.at(-1)?.state, undefined);
  assert.equal(f.res.seqs().length, 512, 'only the already-read bounded outbox is flushed at limit');
  assert.equal(f.done(), 1);
});

test('the hard deadline also bounds a writable terminal replay with unread backlog', t => {
  const f = fixture(t, { limits: { maxDurationMs: 800 } });
  f.follower.start(MissionState.COMPLETED);
  advance(t, 500);
  advance(t, 250);
  advance(t, 50);
  assert.equal(endReason(f.res), 'limit');
  assert.equal(f.res.seqs().length, 1536);
  assert.equal(f.done(), 1);
});

test('disconnect during terminal replay cancels all later work and cleans up once', t => {
  const f = fixture(t);
  f.follower.start(MissionState.COMPLETED);
  f.res.emit('close');
  const count = f.res.lines.length;
  advance(t, 30 * 60_000);
  assert.equal(f.res.lines.length, count);
  assert.equal(f.res.destroyed, true);
  assert.equal(f.done(), 1);
});

test('bounded terminal replay retains malformed-line and torn-tail handling', t => {
  const f = fixture(t, { count: 0, limits: { maxReadBytes: 128, maxLineBytes: 96, pollMs: 10, drainMs: 15 } });
  writeFileSync(f.eventsPath, '{broken}\n' + 'x'.repeat(100) + '\n' +
    '{"seq":1,"type":"checkpoint_created"}\n' + '{"seq":2');
  f.follower.start(MissionState.COMPLETED);
  advance(t, 10);
  advance(t, 5);
  assert.deepEqual(f.res.seqs(), [1]);
  assert.equal(endReason(f.res), 'terminal');
  assert.equal(f.res.lines.at(-1)?.skippedLines, 2);
});

test('a torn final event is completed if its newline arrives within terminal grace', t => {
  const f = fixture(t, { count: 0 });
  writeFileSync(f.eventsPath, '{"seq":1,"type":"mission_completed"');
  f.follower.start(MissionState.COMPLETED);
  advance(t, 500);
  appendFileSync(f.eventsPath, '}\n');
  advance(t, 250);
  assert.deepEqual(f.res.seqs(), [1]);
  assert.equal(endReason(f.res), 'terminal');
});

test('an absent event log still closes a terminal follower after grace', t => {
  const f = fixture(t, { count: 0 });
  rmSync(f.eventsPath);
  f.follower.start(MissionState.COMPLETED);
  advance(t, 500);
  advance(t, 250);
  assert.equal(endReason(f.res), 'terminal');
  assert.equal(f.done(), 1);
});

test('failure during the terminal drain reports error rather than terminal success', t => {
  const f = fixture(t, { count: 1 });
  f.follower.start(MissionState.COMPLETED);
  advance(t, 500);
  // Inject a final read failure without relying on platform-specific fs errors.
  t.mock.method(f.follower as unknown as { drainFile: () => boolean }, 'drainFile', () => {
    throw new Error('fixture read failure');
  });
  advance(t, 250);
  assert.equal(endReason(f.res), 'error');
  assert.equal(f.done(), 1);
});
