import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MissionStore, missionDir, CorruptStateError } from '../mission/mission-store.js';
import { createMission } from '../engine/mission-factory.js';
import { MissionState, AgentType } from '../types.js';
import type { MissionSpec, AgentConfig } from '../types.js';
import { IllegalTransitionError } from '../mission/state-machine.js';

let dir: string;
let store: MissionStore;

const spec: MissionSpec = {
  objective: 'Fix the flaky login test',
  acceptanceCriteria: ['npm test passes']
};
const agent: AgentConfig = { name: 'fake', type: AgentType.QWEN };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alr-store-'));
  store = new MissionStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeMission() {
  return createMission({ repoPath: dir, spec, agent }, store);
}

describe('MissionStore persistence', () => {
  test('creates mission dir under .agentloop/missions/<id>', () => {
    const m = makeMission();
    assert.ok(existsSync(join(dir, '.agentloop', 'missions', m.id, 'mission.json')));
    assert.equal(m.state, MissionState.CREATED);
  });

  test('round-trips mission fields through disk', () => {
    const m = makeMission();
    const loaded = store.mustLoad(m.id);
    assert.equal(loaded.id, m.id);
    assert.equal(loaded.spec.objective, spec.objective);
    assert.deepEqual(loaded.spec.acceptanceCriteria, spec.acceptanceCriteria);
    assert.equal(loaded.agent.name, 'fake');
    assert.equal(loaded.policy.maxMissionMinutes > 0, true);
  });

  test('load returns null for unknown id, mustLoad throws', () => {
    assert.equal(store.load('m_nonexistent'), null);
    assert.throws(() => store.mustLoad('m_nonexistent'));
  });

  test('list and listActive', () => {
    const a = makeMission();
    const b = makeMission();
    assert.equal(store.list().length, 2);
    assert.equal(store.listActive().length, 2);
    store.transition(store.mustLoad(a.id), MissionState.CANCELLED, 'done');
    assert.equal(store.listActive().length, 1);
    assert.equal(store.list().length, 2);
  });

  test('transition persists state + appends stateHistory + emits event', () => {
    const m = makeMission();
    store.transition(store.mustLoad(m.id), MissionState.PREPARED, 'ready');
    const loaded = store.mustLoad(m.id);
    assert.equal(loaded.state, MissionState.PREPARED);
    assert.equal(loaded.stateHistory.length, 2);
    assert.equal(loaded.stateHistory[1].reason, 'ready');

    const events = store.events(m.id);
    const stateEvt = events.find(e => e.type === 'state_changed');
    assert.ok(stateEvt, 'state_changed event emitted');
    assert.equal((stateEvt!.data as { to: string }).to, 'prepared');
  });

  test('illegal transition throws and does not persist', () => {
    const m = makeMission();
    assert.throws(
      () => store.transition(store.mustLoad(m.id), MissionState.COMPLETED, 'cheat'),
      IllegalTransitionError
    );
    assert.equal(store.mustLoad(m.id).state, MissionState.CREATED);
  });

  test('mission_created event is emitted with bounded payload', () => {
    const m = makeMission();
    const events = store.events(m.id);
    const created = events.find(e => e.type === 'mission_created');
    assert.ok(created);
    assert.ok(JSON.stringify(created!.data).length < 1000);
  });

  test('events.jsonl is append-only structured log', () => {
    const m = makeMission();
    store.emit(m.id, 'agent_started', { pid: 1234 });
    store.emit(m.id, 'checkpoint_created', { sha: 'abc123' });
    const lines = readFileSync(join(missionDir(dir, m.id), 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean);
    assert.ok(lines.length >= 3);
    for (const line of lines) {
      const e = JSON.parse(line);
      assert.ok(e.type && e.at);
    }
  });
});

describe('atomic persistence', () => {
  test('mission.json contains no stray temp files after save', () => {
    const m = makeMission();
    store.save(store.mustLoad(m.id));
    store.save(store.mustLoad(m.id));
    const files = readdirSync(missionDir(dir, m.id));
    assert.ok(!files.some(f => f.endsWith('.tmp')), 'no temp files left');
  });

  test('corrupt mission.json is loud and preserved — never read as missing', () => {
    const m = makeMission();
    const mdir = missionDir(dir, m.id);
    writeFileSync(join(mdir, 'mission.json'), '{corrupt', 'utf8');
    assert.throws(() => store.load(m.id), CorruptStateError);
    // Raw bytes are preserved for diagnosis — not quarantined or blanked
    assert.equal(readFileSync(join(mdir, 'mission.json'), 'utf8'), '{corrupt');
    // And it is surfaced via listCorrupt() rather than silently dropped
    const corrupt = store.listCorrupt();
    assert.ok(corrupt.some(e => e.id === m.id), 'corrupt mission must appear in listCorrupt()');
    assert.ok(!store.list().some(e => e.id === m.id), 'corrupt mission is not a loadable record');
  });
});
