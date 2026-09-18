import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { requestApproval, decideApproval, loadApprovals, approvalStatus } from '../policy/approvals.js';
import { MissionStore } from '../mission/mission-store.js';
import { createMission } from '../engine/mission-factory.js';
import { detectStaleMissions, recoverMission } from '../engine/recovery.js';
import { MissionState, AgentType } from '../types.js';
import type { MissionSpec, AgentConfig } from '../types.js';

let dir: string;
let store: MissionStore;

const spec: MissionSpec = { objective: 'Ship the fix', acceptanceCriteria: ['tests pass'] };
const agent: AgentConfig = { name: 'fake', type: AgentType.QWEN };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alr-approve-'));
  store = new MissionStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('approval gates', () => {
  test('request creates pending approval persisted on disk', () => {
    const mdir = store.dir('m-test');
    const req = requestApproval(mdir, 'm-test', 'push', 'push agentloop/m-1 to origin');
    assert.equal(req.status, 'pending');
    assert.equal(req.gate, 'push');
    assert.ok(req.id.startsWith('ap_'));
    assert.deepEqual(loadApprovals(mdir), [req]);
  });

  test('decide records decision with actor and timestamp', () => {
    const mdir = store.dir('m-test');
    const req = requestApproval(mdir, 'm-test', 'dangerous-command', 'rm -rf build/');
    const decided = decideApproval(mdir, 'm-test', req.id, 'approved', 'alice');
    assert.equal(decided!.status, 'approved');
    assert.equal(decided!.decidedBy, 'alice');
    assert.ok(decided!.decidedAt);
  });

  test('double-decide is rejected — no flip-flopping', () => {
    const mdir = store.dir('m-test');
    const req = requestApproval(mdir, 'm-test', 'push', 'push');
    decideApproval(mdir, 'm-test', req.id, 'denied', 'alice');
    const second = decideApproval(mdir, 'm-test', req.id, 'approved', 'mallory');
    assert.equal(second, null, 'decided approval must not be re-decidable');
    assert.equal(approvalStatus(mdir, req.id)!.status, 'denied');
  });

  test('unknown approval id returns null', () => {
    const mdir = store.dir('m-test');
    assert.equal(decideApproval(mdir, 'm-test', 'ap_ghost', 'approved', 'x'), null);
  });
});

describe('crash recovery', () => {
  const mkMission = () => createMission({ repoPath: dir, spec, agent }, store);

  test('active mission with dead runner pid → marked stale', async () => {
    const m = mkMission();
    const loaded = store.mustLoad(m.id);
    store.transition(loaded, MissionState.PREPARED, 'prep');
    const m2 = store.mustLoad(m.id);
    store.transition(m2, MissionState.RUNNING, 'go');
    // Attach a runner record with a definitely-dead pid and old heartbeat
    const m3 = store.mustLoad(m.id);
    m3.runner = { pid: 999999, heartbeatAt: new Date(Date.now() - 120000).toISOString(), startedAt: new Date().toISOString() };
    store.save(m3);

    const stale = await detectStaleMissions(store);
    assert.equal(stale.length, 1);
    assert.equal(store.mustLoad(m.id).state, MissionState.STALE);
  });

  test('mission owned by our own live pid is not marked stale', async () => {
    const m = mkMission();
    const loaded = store.mustLoad(m.id);
    store.transition(loaded, MissionState.PREPARED, 'prep');
    const m2 = store.mustLoad(m.id);
    store.transition(m2, MissionState.RUNNING, 'go');
    const m3 = store.mustLoad(m.id);
    m3.runner = { pid: process.pid, heartbeatAt: new Date(Date.now() - 120000).toISOString(), startedAt: new Date().toISOString() };
    store.save(m3);

    const stale = await detectStaleMissions(store);
    assert.equal(stale.length, 0, 'our own running process should not self-stale');
    assert.equal(store.mustLoad(m.id).state, MissionState.RUNNING);
  });

  test('terminal missions are never marked stale', async () => {
    const m = mkMission();
    const loaded = store.mustLoad(m.id);
    store.transition(loaded, MissionState.CANCELLED, 'done');
    const stale = await detectStaleMissions(store);
    assert.equal(stale.length, 0);
  });

  test('recoverMission: stale → prepared, preserving record', async () => {
    const m = mkMission();
    let loaded = store.mustLoad(m.id);
    store.transition(loaded, MissionState.PREPARED, 'prep');
    loaded = store.mustLoad(m.id);
    store.transition(loaded, MissionState.RUNNING, 'go');
    loaded = store.mustLoad(m.id);
    loaded.runner = { pid: 999999, heartbeatAt: new Date(Date.now() - 120000).toISOString(), startedAt: new Date().toISOString() };
    loaded.workspace.mode = 'in-place';
    loaded.workspace.path = dir;
    store.save(loaded);
    await detectStaleMissions(store);

    const recovered = await recoverMission(store, m.id);
    assert.equal(recovered.state, MissionState.PREPARED);
    assert.equal(recovered.spec.objective, spec.objective);
  });

  test('recoverMission refuses non-resumable states', async () => {
    const m = mkMission();
    await assert.rejects(() => recoverMission(store, m.id), /not recoverable/);
    const loaded = store.mustLoad(m.id);
    store.transition(loaded, MissionState.CANCELLED, 'done');
    await assert.rejects(() => recoverMission(store, m.id), /not recoverable/);
  });

  test('waiting_for_approval mission recovers and reloads decisions', async () => {
    const m = mkMission();
    let loaded = store.mustLoad(m.id);
    store.transition(loaded, MissionState.PREPARED, 'prep');
    loaded = store.mustLoad(m.id);
    store.transition(loaded, MissionState.RUNNING, 'go');
    loaded = store.mustLoad(m.id);
    store.transition(loaded, MissionState.WAITING_FOR_APPROVAL, 'gate');
    loaded = store.mustLoad(m.id);
    loaded.workspace.mode = 'in-place';
    loaded.workspace.path = dir;
    store.save(loaded);

    // Human approves while "runtime down"
    const mdir = store.dir(m.id);
    const req = requestApproval(mdir, m.id, 'push', 'push branch');
    decideApproval(mdir, m.id, req.id, 'approved', 'human');

    const recovered = await recoverMission(store, m.id);
    assert.equal(recovered.state, MissionState.PREPARED);
    assert.equal(recovered.approvals.find(a => a.id === req.id)?.status, 'approved');
  });
});
