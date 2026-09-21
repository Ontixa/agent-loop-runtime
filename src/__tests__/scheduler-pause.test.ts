import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionScheduler } from '../engine/scheduler.js';
import { ControlApi } from '../daemon/control-api.js';
import { MissionStore } from '../mission/mission-store.js';
import { createMission } from '../engine/mission-factory.js';
import { resolvePolicy } from '../policy/policy.js';
import { AgentType, MissionState } from '../types.js';

function ownedScheduler(id: string) {
  const scheduler = new MissionScheduler();
  let requests = 0;
  // Test-only injected owner: no provider process, scheduling, or pause side
  // effects. Exercise the real pause method, including its boolean result.
  const state = scheduler as unknown as {
    running: Map<string, { runner: { requestPause(): void } }>;
  };
  state.running.set(id, { runner: { requestPause() { requests++; } } });
  return { scheduler, requests: () => requests };
}

test('scheduler acknowledges an owned pause and requests it exactly once', () => {
  const owner = ownedScheduler('owned');
  assert.equal(owner.scheduler.pause('owned'), true);
  assert.equal(owner.requests(), 1);
});

test('scheduler reports a missing mission without requesting another owner to pause', () => {
  const owner = ownedScheduler('owned');
  assert.equal(owner.scheduler.pause('missing'), false);
  assert.equal(owner.requests(), 0);
});

async function pauseOverHttp(owned: boolean, authorized: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'alr-pause-api-'));
  const store = new MissionStore(dir);
  const policy = resolvePolicy();
  const mission = createMission({
    repoPath: dir, policy,
    spec: { objective: 'Pause fixture', acceptanceCriteria: ['not executed by this route test'] },
    agent: { name: 'fixture', type: AgentType.CUSTOM, command: process.execPath }
  }, store);
  // Route tests need a persisted running record, not a Git checkout or child.
  store.transition(mission, MissionState.PREPARED, 'fixture prepared');
  store.transition(mission, MissionState.RUNNING, 'fixture running');
  const before = store.mustLoad(mission.id);
  const owner = ownedScheduler(owned ? mission.id : 'another-mission');
  const token = `fixture_${randomBytes(24).toString('hex')}`;
  const api = new ControlApi({
    host: '127.0.0.1', port: 0, token,
    repos: new Map([[dir, { store, policy }]]), scheduler: owner.scheduler,
    version: 'test', startedAt: Date.now()
  });
  try {
    await api.start();
    // Port zero avoids collisions; inspect the actual listener only in tests.
    const server = (api as unknown as { server: Server }).server;
    const { port } = server.address() as AddressInfo;
    const response = await new Promise<{ status: number; body: { mission?: { state: string } } }>((resolve, reject) => {
      const req = request({
        hostname: '127.0.0.1', port, method: 'POST',
        path: `/v1/missions/${mission.id}/pause`,
        headers: { Host: '127.0.0.1', ...(authorized ? { Authorization: `Bearer ${token}` } : {}) }
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(body) }); }
          catch (err) { reject(err); }
        });
        res.on('error', reject);
      });
      req.setTimeout(10_000, () => req.destroy(new Error('loopback pause request timed out')));
      req.on('error', reject);
      req.end();
    });
    return { response, before, after: store.mustLoad(mission.id), requests: owner.requests() };
  } finally {
    await api.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('authenticated API owned pause leaves state mutation to its runner, not fallback', async () => {
  const { response, before, after, requests } = await pauseOverHttp(true, true);
  assert.equal(response.status, 200);
  assert.equal(requests, 1);
  assert.equal(response.body.mission?.state, MissionState.RUNNING);
  assert.deepEqual(after, before, 'API must not race the owning runner with a fallback transition');
});

test('authenticated API unowned pause preserves the existing fallback transition', async () => {
  const { response, before, after, requests } = await pauseOverHttp(false, true);
  assert.equal(response.status, 200);
  assert.equal(requests, 0);
  assert.equal(after.state, MissionState.PAUSED);
  assert.equal(response.body.mission?.state, MissionState.PAUSED);
  assert.equal(after.revision, before.revision! + 1);
  assert.equal(after.stateHistory.at(-1)?.reason, 'operator pause requested');
});

test('unauthorized API pause does not call a runner or mutate mission state', async () => {
  const { response, before, after, requests } = await pauseOverHttp(true, false);
  assert.equal(response.status, 401);
  assert.equal(requests, 0);
  assert.deepEqual(after, before);
});
