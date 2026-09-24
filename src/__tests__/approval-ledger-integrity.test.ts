import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MissionStore } from '../mission/mission-store.js';
import { createMission } from '../engine/mission-factory.js';
import { MissionRunner } from '../engine/mission-runner.js';
import {
  requestApproval, decideApproval, loadApprovals, approvalsPath, CorruptApprovalsError
} from '../policy/approvals.js';
import { MissionState, AgentType } from '../types.js';
import type { MissionSpec, AgentConfig, ApprovalRequest } from '../types.js';

/**
 * Approvals-ledger integrity — fail closed, never silent.
 *
 * approvals.json is the operator-facing decision record the runner polls.
 * The agent process can write the filesystem (documented advisory boundary),
 * so a corrupted/truncated/wiped ledger must NEVER be read as "every gate
 * decided" — that path fabricated `approval_decided` evidence and resumed
 * the mission with 'approval granted' while no human decided anything.
 *
 * Mirrors the mission.json contract: corrupt state is loud, preserved
 * byte-for-byte, and never overwritten with blank defaults.
 */

let dir: string;
let store: MissionStore;
const savedApprovalKey = process.env.AGENTLOOP_APPROVAL_KEY;

const spec: MissionSpec = { objective: 'Ship the fix', acceptanceCriteria: ['tests pass'] };
const agent: AgentConfig = { name: 'fake', type: AgentType.QWEN };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alr-ledger-'));
  store = new MissionStore(dir);
  delete process.env.AGENTLOOP_APPROVAL_KEY;
});
afterEach(() => {
  if (savedApprovalKey === undefined) delete process.env.AGENTLOOP_APPROVAL_KEY;
  else process.env.AGENTLOOP_APPROVAL_KEY = savedApprovalKey;
  rmSync(dir, { recursive: true, force: true });
});

// ─── loadApprovals: missing vs corrupt vs malformed ──────────────────────

describe('approvals ledger — read integrity', () => {
  test('missing file is an empty ledger (gate never raised)', () => {
    assert.deepEqual(loadApprovals(store.dir('m-none')), []);
  });

  test('valid round-trip still works', () => {
    const mdir = store.dir('m-ok');
    const req = requestApproval(mdir, 'm-ok', 'push', 'push branch');
    decideApproval(mdir, 'm-ok', req.id, 'approved', 'op');
    const loaded = loadApprovals(mdir);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].status, 'approved');
  });

  test('unparseable JSON throws a typed error and preserves the bytes', () => {
    const mdir = store.dir('m-corrupt');
    requestApproval(mdir, 'm-corrupt', 'push', 'push branch');
    const path = approvalsPath(mdir);
    writeFileSync(path, '{"approvals": [{"id": "ap_x", "sta'); // torn write

    assert.throws(() => loadApprovals(mdir), CorruptApprovalsError);
    // Byte-for-byte preservation — operators inspect the damage, no auto-repair.
    assert.equal(readFileSync(path, 'utf-8'), '{"approvals": [{"id": "ap_x", "sta');
  });

  test('malformed shapes throw instead of crashing or being read as empty', () => {
    const mdir = store.dir('m-shape');
    mkdirSync(mdir, { recursive: true });
    const path = approvalsPath(mdir);
    const malformed: string[] = [
      '{"approvals": "yes"}',                    // string, not array
      '{"approvals": {"a": {}}}',                // object, not array
      '{"approvals": [{}]}',                     // entry without id/status
      '{"approvals": [{"id": "ap_1"}]}',         // entry without status
      '{"approvals": [{"id": "ap_1", "status": "bogus"}]}',
      '{"approvals": [42]}',
      '42',                                      // non-object root
      '"approvals"'                              // non-object root
    ];
    for (const bad of malformed) {
      writeFileSync(path, bad);
      assert.throws(() => loadApprovals(mdir), CorruptApprovalsError, `must reject: ${bad}`);
      assert.equal(readFileSync(path, 'utf-8'), bad, 'file preserved');
    }
  });

  test('writers never clobber a corrupt ledger', () => {
    const mdir = store.dir('m-clobber');
    mkdirSync(mdir, { recursive: true });
    const path = approvalsPath(mdir);
    writeFileSync(path, 'not json at all');

    assert.throws(() => requestApproval(mdir, 'm-clobber', 'push', 'p'), CorruptApprovalsError);
    assert.throws(() => decideApproval(mdir, 'm-clobber', 'ap_x', 'approved', 'op'), CorruptApprovalsError);
    assert.equal(readFileSync(path, 'utf-8'), 'not json at all', 'corrupt bytes preserved');
  });
});

// ─── runner: waiting mission vs tampered ledger ──────────────────────────

describe('waiting_for_approval vs ledger tampering', () => {
  /** Drive a mission to WAITING_FOR_APPROVAL with a recorded pending gate. */
  function waitingMission() {
    const m = createMission({ repoPath: dir, spec, agent }, store);
    let loaded = store.mustLoad(m.id);
    store.transition(loaded, MissionState.PREPARED, 'prep');
    loaded = store.mustLoad(m.id);
    store.transition(loaded, MissionState.RUNNING, 'go');
    loaded = store.mustLoad(m.id);
    store.transition(loaded, MissionState.WAITING_FOR_APPROVAL, 'gate: dangerous-command');
    // Mirror what raiseApproval persists: ledger write + mission.approvals sync.
    const req = requestApproval(store.dir(m.id), m.id, 'dangerous-command',
      'npm publish requires approval', [['npm', 'publish']]);
    store.mutate(m.id, mm => { mm.approvals = loadApprovals(store.dir(m.id)); });
    return { mission: store.mustLoad(m.id), req };
  }

  function assertNoFabricatedGrant(missionId: string): void {
    const events = store.events(missionId);
    assert.ok(!events.some(e => e.type === 'approval_decided'),
      'no human decided — approval_decided must never be fabricated');
    const granted = store.mustLoad(missionId).stateHistory
      .some(h => /approval granted/i.test(h.reason ?? ''));
    assert.ok(!granted, 'mission must never transition as if approval was granted');
  }

  test('corrupt ledger blocks the mission — never resumes on unreadable evidence', async () => {
    const { mission } = waitingMission();
    writeFileSync(approvalsPath(store.dir(mission.id)), '{ "approvals": [ torn');

    const final = await new MissionRunner(store).run(mission.id);
    assert.equal(final.state, MissionState.BLOCKED,
      'a corrupt approvals ledger must block, not resume as granted');
    assertNoFabricatedGrant(mission.id);
  });

  test('wiped ledger (empty approvals array) is not a decision', async () => {
    const { mission } = waitingMission();
    // The exact tamper a filesystem-capable agent can do: erase the gate record.
    writeFileSync(approvalsPath(store.dir(mission.id)),
      JSON.stringify({ missionId: mission.id, approvals: [] }));

    const final = await new MissionRunner(store).run(mission.id);
    assert.equal(final.state, MissionState.BLOCKED);
    assertNoFabricatedGrant(mission.id);
  });

  test('deleted ledger file while waiting is not a decision', async () => {
    const { mission } = waitingMission();
    unlinkSync(approvalsPath(store.dir(mission.id)));

    const final = await new MissionRunner(store).run(mission.id);
    assert.equal(final.state, MissionState.BLOCKED);
    assertNoFabricatedGrant(mission.id);
  });

  test('deleting only the pending entry leaves unverifiable residue — blocked', async () => {
    const { mission, req } = waitingMission();
    // Record a second (decided) gate in the mirror, then strip the pending one
    // from disk: the ledger no longer contains a gate the mission awaits.
    const mdir = store.dir(mission.id);
    const decided: ApprovalRequest = {
      id: 'ap_old_decided', gate: 'push', detail: 'earlier gate',
      status: 'approved', requestedAt: new Date().toISOString(),
      decidedAt: new Date().toISOString(), decidedBy: 'op'
    };
    store.mutate(mission.id, mm => { mm.approvals = [...mm.approvals, decided]; });
    writeFileSync(approvalsPath(mdir),
      JSON.stringify({ missionId: mission.id, approvals: [decided] }));

    const final = await new MissionRunner(store).run(mission.id);
    assert.equal(final.state, MissionState.BLOCKED,
      `pending gate ${req.id} vanished from the ledger — the stale approved entry is not a decision for it`);
    assertNoFabricatedGrant(mission.id);
  });

  test('an intact decided ledger still resumes — the honest path is unchanged', async () => {
    const { mission, req } = waitingMission();
    decideApproval(store.dir(mission.id), mission.id, req.id, 'approved', 'op');
    store.mutate(mission.id, mm => { mm.approvals = loadApprovals(store.dir(mission.id)); });

    const final = await new MissionRunner(store).run(mission.id);
    // Resume honored the real decision; with no executable tasks the mission
    // then fails on its own merits — the point is the grant path still works.
    assert.equal(final.state, MissionState.FAILED);
    assert.ok(store.mustLoad(mission.id).stateHistory
      .some(h => /approval granted/i.test(h.reason ?? '')),
      'a genuine approved decision must still resume the mission');
  });
});
