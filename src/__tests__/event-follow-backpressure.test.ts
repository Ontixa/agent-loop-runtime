import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionEventFollower, resolveFollowLimits } from '../daemon/event-follow.js';
import { MissionState } from '../types.js';

/** ServerResponse.write(false) still accepts the chunk into its output buffer. */
class BackpressuredResponse extends EventEmitter {
  readonly lines: Array<Record<string, unknown>> = [];
  writableEnded = false;
  destroyed = false;
  private pressured = false;

  write(line: string): boolean {
    const value = JSON.parse(line) as Record<string, unknown>;
    this.lines.push(value);
    if (value.seq === 1 && !this.pressured) {
      this.pressured = true;
      return false;
    }
    return true;
  }

  end(): void { this.writableEnded = true; }
  destroy(): void { this.destroyed = true; }
}

for (const finish of ['drain', 'shutdown'] as const) {
  test(`follow never repeats an accepted backpressured event on ${finish}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'alr-follow-backpressure-'));
    const eventsPath = join(dir, 'events.jsonl');
    writeFileSync(eventsPath,
      '{"seq":1,"type":"mission_created"}\n{"seq":2,"type":"checkpoint_created"}\n');
    const res = new BackpressuredResponse();
    let done = 0;
    const follower = new MissionEventFollower({
      res: res as unknown as ServerResponse,
      missionId: 'fixture',
      eventsPath,
      afterSeq: 0,
      loadState: () => MissionState.RUNNING,
      limits: resolveFollowLimits({ pollMs: 60_000, heartbeatMs: 60_000, maxDurationMs: 60_000 }),
      onDone: () => { done++; }
    });
    try {
      follower.start(MissionState.RUNNING);
      assert.deepEqual(res.lines.filter(l => typeof l.seq === 'number').map(l => l.seq), [1]);
      if (finish === 'drain') res.emit('drain');
      else follower.end('shutdown');
      assert.deepEqual(res.lines.filter(l => typeof l.seq === 'number').map(l => l.seq), [1, 2]);
      if (finish === 'shutdown') {
        assert.equal(res.lines.at(-1)?.meta, 'end');
        assert.equal(done, 1);
      }
    } finally {
      follower.end('shutdown', undefined, true);
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(done, 1, 'cleanup is idempotent');
  });
}

