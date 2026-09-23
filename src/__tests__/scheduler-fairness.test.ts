import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionScheduler } from '../engine/scheduler.js';
import { MissionStore } from '../mission/mission-store.js';
import { resolvePolicy } from '../policy/policy.js';
import type { Mission, Policy } from '../types.js';

/**
 * Scheduler admission-order tests. These exercise the REAL queue, capacity,
 * and fair-ordering code paths; only `startMission` (which would spawn real
 * git worktrees and agent processes) is replaced by a controllable stub that
 * registers a running entry and finishes on demand — the same seam style as
 * scheduler-pause.test.ts poking `running` directly.
 *
 * Determinism: `pump` is stubbed to a no-op so no real timers fire — every
 * admission decision is driven by an explicit `await harness.tick()`. A
 * finished stub run removes itself from `running`; the following `tick()`
 * then performs the next admission, with no wall-clock dependency.
 */

interface StubbedScheduler {
  scheduler: MissionScheduler;
  admitted: string[];
  /** Run one real scheduler tick (admission gate + selection + starts). */
  tick(): Promise<void>;
  /** Resolve a stubbed run: the entry drops out of `running`. */
  finish(missionId: string): Promise<void>;
  repoRoot(name: string): string;
  cleanup(): Promise<void>;
}

type RunningEntryLike = { missionId: string; repoRoot: string; runner: unknown; promise: Promise<Mission> };
type SchedulerInternals = {
  startMission(store: MissionStore, missionId: string): Promise<void>;
  running: Map<string, RunningEntryLike>;
  pump(delayMs?: number): void;
  tick(): Promise<void>;
};

function stubbedScheduler(policies: Record<string, Partial<Policy>>): StubbedScheduler {
  const scheduler = new MissionScheduler();
  const internals = scheduler as unknown as SchedulerInternals;
  const admitted: string[] = [];
  const releases = new Map<string, () => void>();
  const dirs: string[] = [];
  const roots = new Map<string, string>();

  internals.startMission = async (store, missionId) => {
    admitted.push(missionId);
    let release!: () => void;
    const promise = new Promise<Mission>(resolve => {
      release = () => resolve({ id: missionId } as Mission);
    });
    releases.set(missionId, release);
    internals.running.set(missionId, {
      missionId,
      repoRoot: store.repoRoot,
      runner: { requestPause() {}, requestCancel() {} },
      promise
    });
    // Mirror the real startMission bookkeeping: a finished run frees its
    // slot. pump() is stubbed below — tests drive the next tick explicitly.
    void promise.finally(() => {
      internals.running.delete(missionId);
      scheduler.emit('finished', missionId);
    });
  };

  for (const [name, partial] of Object.entries(policies)) {
    const dir = mkdtempSync(join(tmpdir(), `alr-fair-${name}-`));
    dirs.push(dir);
    roots.set(name, dir);
    scheduler.registerRepo(dir, new MissionStore(dir), resolvePolicy(partial));
  }

  // No timer-driven ticks: enqueue() calls pump(), which we neutralize so
  // admissions happen only when the test calls tick().
  internals.pump = () => {};
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    scheduler,
    admitted,
    async tick() {
      await internals.tick();
    },
    async finish(missionId) {
      const release = releases.get(missionId);
      assert.ok(release, `mission ${missionId} is not stubbed as running`);
      releases.delete(missionId);
      release();
      await flush(); // let promise.finally remove the running entry
    },
    repoRoot: name => {
      const root = roots.get(name);
      assert.ok(root, `unknown fixture repo ${name}`);
      return root;
    },
    async cleanup() {
      // pump is a no-op, so queued items can never be admitted during
      // teardown — releasing all stubbed runs empties `running`, and
      // shutdown()'s await of their (resolved) promises returns promptly.
      for (const release of releases.values()) release();
      releases.clear();
      await flush();
      await scheduler.shutdown();
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  };
}

test('equal-priority missions round-robin across repos — a queued repo is not starved by a busier one', async () => {
  // global cap 2, per-repo cap 1: the pre-fairness repo-order loop would
  // admit A's second mission before ever reaching C. Fair ordering serves C.
  const h = stubbedScheduler({
    a: { maxConcurrentMissions: 2, maxConcurrentMissionsPerRepo: 1 },
    b: { maxConcurrentMissions: 2, maxConcurrentMissionsPerRepo: 1 },
    c: { maxConcurrentMissions: 2, maxConcurrentMissionsPerRepo: 1 }
  });
  try {
    h.scheduler.enqueue(h.repoRoot('a'), 'm1');
    h.scheduler.enqueue(h.repoRoot('a'), 'm2');
    h.scheduler.enqueue(h.repoRoot('b'), 'm3');
    h.scheduler.enqueue(h.repoRoot('c'), 'm4');
    await h.tick();
    assert.deepEqual(h.admitted, ['m1', 'm3'], 'two free slots go to two different repos');

    await h.finish('m1');
    await h.tick();
    assert.deepEqual(h.admitted, ['m1', 'm3', 'm4'], 'repo c is served before repo a twice');

    await h.finish('m3');
    await h.finish('m4');
    await h.tick();
    assert.deepEqual(h.admitted, ['m1', 'm3', 'm4', 'm2']);
  } finally {
    await h.cleanup();
  }
});

test('priority preempts queued work across repos but never a running mission', async () => {
  const h = stubbedScheduler({
    a: { maxConcurrentMissions: 1, maxConcurrentMissionsPerRepo: 1 },
    b: { maxConcurrentMissions: 1, maxConcurrentMissionsPerRepo: 1 }
  });
  try {
    h.scheduler.enqueue(h.repoRoot('a'), 'running-low', 100);
    await h.tick();
    assert.deepEqual(h.admitted, ['running-low']);

    // A's second mission is high priority; B's is low. Pure round-robin
    // would pick B (never served) — priority must win.
    h.scheduler.enqueue(h.repoRoot('a'), 'a-urgent', 10);
    h.scheduler.enqueue(h.repoRoot('b'), 'b-idle', 500);
    await h.tick();
    assert.deepEqual(h.admitted, ['running-low'], 'queued work does not preempt a running mission');

    await h.finish('running-low');
    await h.tick();
    assert.deepEqual(h.admitted, ['running-low', 'a-urgent'], 'lower priority number admitted first');

    await h.finish('a-urgent');
    await h.tick();
    assert.deepEqual(h.admitted, ['running-low', 'a-urgent', 'b-idle']);
  } finally {
    await h.cleanup();
  }
});

test('per-repo cap serializes one repo while others still admit; same repo+priority is FIFO', async () => {
  const h = stubbedScheduler({
    a: { maxConcurrentMissions: 4, maxConcurrentMissionsPerRepo: 1 },
    b: { maxConcurrentMissions: 4, maxConcurrentMissionsPerRepo: 1 }
  });
  try {
    h.scheduler.enqueue(h.repoRoot('a'), 'a1');
    h.scheduler.enqueue(h.repoRoot('a'), 'a2');
    h.scheduler.enqueue(h.repoRoot('a'), 'a3');
    h.scheduler.enqueue(h.repoRoot('b'), 'b1');
    await h.tick();
    assert.deepEqual(h.admitted, ['a1', 'b1'], 'per-repo cap holds a2/a3, repo b is unaffected');

    await h.finish('a1');
    await h.tick();
    assert.deepEqual(h.admitted, ['a1', 'b1', 'a2'], 'FIFO inside the same repo and priority');
    await h.finish('a2');
    await h.tick();
    assert.deepEqual(h.admitted, ['a1', 'b1', 'a2', 'a3']);
  } finally {
    await h.cleanup();
  }
});

test('global concurrency is bounded by the most restrictive registered policy', async () => {
  const h = stubbedScheduler({
    strict: { maxConcurrentMissions: 1, maxConcurrentMissionsPerRepo: 1 },
    loose: { maxConcurrentMissions: 4, maxConcurrentMissionsPerRepo: 4 }
  });
  try {
    h.scheduler.enqueue(h.repoRoot('loose'), 'l1');
    h.scheduler.enqueue(h.repoRoot('loose'), 'l2');
    await h.tick();
    assert.deepEqual(h.admitted, ['l1'], 'loose repo cannot exceed the strict repo global cap');

    await h.finish('l1');
    await h.tick();
    assert.deepEqual(h.admitted, ['l1', 'l2']);
  } finally {
    await h.cleanup();
  }
});

test('a never-served repo wins a same-priority tie over an admitted one (new repo is not penalized)', async () => {
  const h = stubbedScheduler({
    a: { maxConcurrentMissions: 1, maxConcurrentMissionsPerRepo: 1 },
    b: { maxConcurrentMissions: 1, maxConcurrentMissionsPerRepo: 1 }
  });
  try {
    h.scheduler.enqueue(h.repoRoot('a'), 'a-first');
    await h.tick();
    assert.deepEqual(h.admitted, ['a-first']);

    // b was registered from the start but never served — its queuedAt is
    // later, yet the round-robin credit (served=0) must beat a's served=1.
    h.scheduler.enqueue(h.repoRoot('a'), 'a-second');
    h.scheduler.enqueue(h.repoRoot('b'), 'b-first');
    await h.finish('a-first');
    await h.tick();
    assert.deepEqual(h.admitted, ['a-first', 'b-first']);
  } finally {
    await h.cleanup();
  }
});
