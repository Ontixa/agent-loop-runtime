import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionScheduler } from '../engine/scheduler.js';
import {
  evaluateAdmission, hostPressureProbe, resolveAdmissionLimits, DEFAULT_ADMISSION_LIMITS
} from '../engine/admission-control.js';
import type { AdmissionConfig, HostPressure } from '../engine/admission-control.js';
import { MissionStore } from '../mission/mission-store.js';
import { createMission } from '../engine/mission-factory.js';
import { resolvePolicy } from '../policy/policy.js';
import { AgentType } from '../types.js';
import type { Mission } from '../types.js';

// ── pure admission decision ───────────────────────────────────────────────

const LIMITS = { enabled: true, maxLoadPerCpu: 2, minFreeMemRatio: 0.1, recheckMs: 1000 };

test('admission: under thresholds admits', () => {
  assert.deepEqual(evaluateAdmission(LIMITS, { loadPerCpu: 1.5, freeMemRatio: 0.5 }), { admit: true });
});

test('admission: exact threshold boundary still admits (strict comparison)', () => {
  assert.equal(evaluateAdmission(LIMITS, { loadPerCpu: 2, freeMemRatio: 0.1 }).admit, true);
});

test('admission: high load defers with a load reason', () => {
  const d = evaluateAdmission(LIMITS, { loadPerCpu: 4, freeMemRatio: 0.9 });
  assert.equal(d.admit, false);
  assert.match(d.reason!, /load 4\.00\/cpu > 2/);
  assert.equal(d.sample?.loadPerCpu, 4);
});

test('admission: low free memory defers with a memory reason', () => {
  const d = evaluateAdmission(LIMITS, { loadPerCpu: 0, freeMemRatio: 0.02 });
  assert.equal(d.admit, false);
  assert.match(d.reason!, /free memory/);
});

test('admission: both checks tripped report both reasons', () => {
  const d = evaluateAdmission(LIMITS, { loadPerCpu: 9, freeMemRatio: 0 });
  assert.match(d.reason!, /load/);
  assert.match(d.reason!, /memory/);
});

test('admission: enabled=false admits regardless of pressure', () => {
  const d = evaluateAdmission({ ...LIMITS, enabled: false }, { loadPerCpu: 99, freeMemRatio: 0 });
  assert.equal(d.admit, true);
});

test('admission: a threshold of 0 disables that check only', () => {
  assert.equal(evaluateAdmission({ ...LIMITS, maxLoadPerCpu: 0 }, { loadPerCpu: 99, freeMemRatio: 0.9 }).admit, true);
  assert.equal(evaluateAdmission({ ...LIMITS, minFreeMemRatio: 0 }, { loadPerCpu: 0, freeMemRatio: 0 }).admit, true);
});

test('admission: resolveAdmissionLimits merges partial config over defaults', () => {
  assert.deepEqual(resolveAdmissionLimits(), DEFAULT_ADMISSION_LIMITS);
  const merged = resolveAdmissionLimits({ maxLoadPerCpu: 0.75 });
  assert.equal(merged.maxLoadPerCpu, 0.75);
  assert.equal(merged.minFreeMemRatio, DEFAULT_ADMISSION_LIMITS.minFreeMemRatio);
  assert.equal(resolveAdmissionLimits({ enabled: false }).enabled, false);
});

test('admission: real host probe returns a well-formed sample', () => {
  const s = hostPressureProbe();
  assert.ok(Number.isFinite(s.loadPerCpu) && s.loadPerCpu >= 0);
  assert.ok(s.freeMemRatio >= 0 && s.freeMemRatio <= 1);
});

// ── scheduler integration: deferral, event, recovery ─────────────────────

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for: ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

interface AdmissionFixture {
  scheduler: MissionScheduler;
  store: MissionStore;
  mission: Mission;
  admitted: string[];
  dir: string;
  cleanup(): Promise<void>;
}

/**
 * Real MissionStore + real persisted mission (so `mission_deferred` events
 * land in events.jsonl), real queue/deferral code — only `startMission` is
 * stubbed to record admission order without spawning processes.
 */
function admissionFixture(pressure: HostPressure, admission?: AdmissionConfig): AdmissionFixture {
  const dir = mkdtempSync(join(tmpdir(), 'alr-admit-'));
  const store = new MissionStore(dir);
  const policy = resolvePolicy({ maxConcurrentMissions: 4, maxConcurrentMissionsPerRepo: 4 });
  const mission = createMission({
    repoPath: dir, policy,
    spec: { objective: 'admission fixture', acceptanceCriteria: ['not executed — scheduler seam test'] },
    agent: { name: 'fixture', type: AgentType.CUSTOM, command: process.execPath }
  }, store);

  const scheduler = new MissionScheduler({}, { probe: () => pressure, admission });
  const admitted: string[] = [];
  const internals = scheduler as unknown as { startMission(store: MissionStore, id: string): Promise<void> };
  internals.startMission = async (_store, id) => { admitted.push(id); };

  scheduler.registerRepo(dir, store, policy);
  return {
    scheduler, store, mission, admitted, dir,
    async cleanup() {
      await scheduler.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('host pressure defers admission, records mission_deferred once, resumes when pressure clears', async () => {
  const pressure: HostPressure = { loadPerCpu: 50, freeMemRatio: 1 };
  const f = admissionFixture(pressure, { maxLoadPerCpu: 1, minFreeMemRatio: 0, recheckMs: 15 });
  try {
    f.scheduler.enqueue(f.dir, f.mission.id);
    await until(() => f.scheduler.status().admission.deferred, 'deferral to engage');
    assert.equal(f.admitted.length, 0, 'no mission admitted under pressure');

    const status = f.scheduler.status();
    assert.equal(status.admission.deferred, true);
    assert.match(status.admission.reason!, /load/);
    assert.ok(status.admission.since);

    // The deferral reason is persisted on the mission's event log — exactly
    // once per episode even though the recheck timer keeps firing.
    await new Promise(resolve => setTimeout(resolve, 60)); // several rechecks
    const deferred = f.store.readEvents(f.mission.id).events.filter(e => e.type === 'mission_deferred');
    assert.equal(deferred.length, 1);
    assert.match(String(deferred[0].data?.reason), /load/);
    assert.equal(deferred[0].data?.loadPerCpu, 50);

    pressure.loadPerCpu = 0;
    await until(() => f.admitted.length === 1, 'admission after pressure clears');
    assert.equal(f.scheduler.status().admission.deferred, false);
  } finally {
    await f.cleanup();
  }
});

test('each queued mission gets its own mission_deferred event', async () => {
  const pressure: HostPressure = { loadPerCpu: 50, freeMemRatio: 1 };
  const f = admissionFixture(pressure, { maxLoadPerCpu: 1, minFreeMemRatio: 0, recheckMs: 3600_000 });
  const second = createMission({
    repoPath: f.dir, policy: resolvePolicy(),
    spec: { objective: 'second', acceptanceCriteria: ['x'] },
    agent: { name: 'fixture', type: AgentType.CUSTOM, command: process.execPath }
  }, f.store);
  try {
    f.scheduler.enqueue(f.dir, f.mission.id);
    f.scheduler.enqueue(f.dir, second.id);
    await until(() => f.scheduler.status().admission.deferred, 'deferral to engage');
    await new Promise(resolve => setTimeout(resolve, 30));
    for (const id of [f.mission.id, second.id]) {
      const events = f.store.readEvents(id).events.filter(e => e.type === 'mission_deferred');
      assert.equal(events.length, 1, `mission ${id} has one deferral event`);
    }
    assert.equal(f.admitted.length, 0);
  } finally {
    await f.cleanup();
  }
});

test('admission.enabled=false ignores the probe entirely', async () => {
  const pressure: HostPressure = { loadPerCpu: 99, freeMemRatio: 0 };
  const f = admissionFixture(pressure, { enabled: false });
  try {
    f.scheduler.enqueue(f.dir, f.mission.id);
    await until(() => f.admitted.length === 1, 'admission despite saturated probe');
    assert.equal(f.scheduler.status().admission.deferred, false);
    assert.equal(f.store.readEvents(f.mission.id).events.filter(e => e.type === 'mission_deferred').length, 0);
  } finally {
    await f.cleanup();
  }
});

test('memory pressure alone (load inert, e.g. Windows) still defers', async () => {
  const pressure: HostPressure = { loadPerCpu: 0, freeMemRatio: 0.01 };
  const f = admissionFixture(pressure, { maxLoadPerCpu: 2, minFreeMemRatio: 0.05, recheckMs: 3600_000 });
  try {
    f.scheduler.enqueue(f.dir, f.mission.id);
    await until(() => f.scheduler.status().admission.deferred, 'memory deferral to engage');
    assert.equal(f.admitted.length, 0);
    assert.match(f.scheduler.status().admission.reason!, /memory/);
  } finally {
    await f.cleanup();
  }
});
