import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, type IncomingHttpHeaders } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlApi } from '../daemon/control-api.js';
import { MissionScheduler } from '../engine/scheduler.js';
import { MissionStore } from '../mission/mission-store.js';
import { createMission } from '../engine/mission-factory.js';
import { requestApproval, loadApprovals } from '../policy/approvals.js';
import { loadPolicy } from '../policy/policy.js';
import { AgentType, MissionState } from '../types.js';
import type { MissionSpec, RuntimeEvent } from '../types.js';

/**
 * Control API v1 contract freeze (docs/control-api-contract.md).
 *
 * Every assertion here pins a wire shape that ai-cli-editor depends on:
 * exact response key sets, status codes, the {error} envelope, and the
 * NDJSON meta-line contract of ?follow. A deliberate contract change must
 * update this suite AND the doc in the same commit — an accidental drift
 * fails here.
 *
 * Fixture mirrors control-api-auth.test.ts: missions stay in `created` (no
 * git worktree), the scheduler is never registered with the repo, and the
 * API binds 127.0.0.1:0 with an explicit token.
 */

interface FixtureResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Record<string, any>;
  raw: string;
}

let dir: string;
let store: MissionStore;
let api: ControlApi;
let token: string;
let missionId: string;
let approvalId: string;

const spec: MissionSpec = { objective: 'Contract fixture mission', acceptanceCriteria: ['done'] };

function req(method: string, path: string, opts: { body?: unknown } = {}): Promise<FixtureResponse> {
  return new Promise((resolve, reject) => {
    const r = request(`${api.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {})
      }
    }, res => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.once('end', () => {
        let parsed: Record<string, any> = {};
        try { parsed = JSON.parse(data); } catch { /* 204/empty */ }
        resolve({ status: res.statusCode!, headers: res.headers, body: parsed, raw: data });
      });
      res.once('error', reject);
    });
    r.setTimeout(10_000, () => r.destroy(new Error('fixture request timed out')));
    r.once('error', reject);
    if (opts.body !== undefined) r.write(JSON.stringify(opts.body));
    r.end();
  });
}

/** Pin the exact key set of an object — added/removed keys both fail. */
function keys(obj: Record<string, any>, expected: string[], what: string): void {
  assert.deepEqual(Object.keys(obj).sort(), [...expected].sort(), `${what} keys`);
}

function isIso(v: unknown): boolean {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'alr-api-contract-'));
  store = new MissionStore(dir);
  const mission = createMission({
    repoPath: dir, spec,
    agent: { name: 'fake', type: AgentType.CUSTOM, command: process.execPath, args: [] }
  }, store);
  missionId = mission.id;
  approvalId = requestApproval(store.dir(missionId), missionId, 'push', 'fixture gate').id;
  // Mirror a pending approval into the mission record (what the runner does
  // when it raises a gate mid-run) so the summary projection is exercised.
  store.mutate(missionId, m => {
    m.approvals.push({
      id: approvalId, gate: 'push', detail: 'fixture gate',
      status: 'pending', requestedAt: new Date().toISOString()
    });
  });
  api = new ControlApi({
    host: '127.0.0.1', port: 0,
    token: `fixture_${randomBytes(24).toString('hex')}`,
    repos: new Map([[dir, { store, policy: loadPolicy(dir).policy }]]),
    scheduler: new MissionScheduler(),
    version: 'contract-test', startedAt: Date.now()
  });
  await api.start();
  token = api.bearerToken;
});
after(async () => {
  await api.stop();
  rmSync(dir, { recursive: true, force: true });
});

const MISSION_SUMMARY_KEYS = [
  'schemaVersion', 'id', 'kind', 'state', 'revision', 'policyHash', 'objective',
  'repo', 'agent', 'worktree', 'workspaceMode', 'usage', 'pendingApprovals',
  'checkpoints', 'createdAt', 'updatedAt', 'at'
  // absent on this fixture: branch, lastRecovery, outcome (undefined keys are dropped)
];

describe('GET /v1/status', () => {
  test('pins the status envelope', async () => {
    const res = await req('GET', '/v1/status');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /application\/json/);
    keys(res.body, ['schemaVersion', 'status', 'version', 'uptimeMs', 'scheduler', 'repos', 'corrupt', 'at'], 'status');
    assert.equal(res.body.schemaVersion, 1);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.version, 'contract-test');
    assert.equal(typeof res.body.uptimeMs, 'number');
    assert.deepEqual(res.body.repos, [dir]);
    assert.deepEqual(res.body.corrupt, []);
    keys(res.body.scheduler, ['queued', 'running', 'admission'], 'scheduler');
    assert.equal(typeof res.body.scheduler.queued, 'number');
    assert.ok(Array.isArray(res.body.scheduler.running));
    assert.equal(res.body.scheduler.admission.deferred, false);
    assert.ok(isIso(res.body.at));
  });
});

describe('mission summary shape (shared by list/detail/action responses)', () => {
  test('pins every projected field', async () => {
    const res = await req('GET', '/v1/missions');
    assert.equal(res.status, 200);
    keys(res.body, ['schemaVersion', 'missions'], 'missions list');
    assert.equal(res.body.schemaVersion, 1);
    assert.equal(res.body.missions.length, 1);
    const m = res.body.missions[0];
    keys(m, MISSION_SUMMARY_KEYS, 'mission summary');
    assert.equal(m.schemaVersion, 1);
    assert.equal(m.id, missionId);
    assert.equal(m.kind, 'objective');
    assert.equal(m.state, MissionState.CREATED);
    assert.equal(typeof m.revision, 'number');
    assert.equal(typeof m.policyHash, 'string');
    assert.equal(m.objective, spec.objective);
    assert.equal(m.repo, dir);
    keys(m.agent, ['type', 'name'], 'agent projection');
    assert.equal(m.agent.type, 'custom');
    assert.equal(m.agent.name, 'fake');
    assert.equal(m.workspaceMode, 'worktree');
    keys(m.usage, ['agentInvocations', 'repairPasses', 'wallTimeMs'], 'usage');
    assert.equal(m.checkpoints, 0);
    assert.ok(isIso(m.createdAt) && isIso(m.updatedAt) && isIso(m.at));
    // pendingApprovals entries project id/gate/detail (+paths/commands when bound)
    assert.equal(m.pendingApprovals.length, 1);
    keys(m.pendingApprovals[0], ['id', 'gate', 'detail'], 'pending approval projection');
    assert.equal(m.pendingApprovals[0].gate, 'push');
    // Never projected into the summary: spec prompt details, tasks, passes, env
    assert.ok(!('spec' in m) && !('tasks' in m) && !('passes' in m) && !('env' in m));
  });
});

describe('POST /v1/missions', () => {
  test('201 → {mission} only (no top-level schemaVersion)', async () => {
    const res = await req('POST', '/v1/missions', {
      body: { repo: dir, spec: { objective: 'api-created', acceptanceCriteria: ['c'] } }
    });
    assert.equal(res.status, 201);
    keys(res.body, ['mission'], 'create response');
    keys(res.body.mission, MISSION_SUMMARY_KEYS, 'created summary');
    assert.equal(res.body.mission.state, MissionState.CREATED);
  });

  test('kind defaults to objective; only "maintenance" is honored', async () => {
    const maintenance = await req('POST', '/v1/missions', {
      body: { repo: dir, spec, kind: 'maintenance' }
    });
    assert.equal(maintenance.body.mission.kind, 'maintenance');
    const other = await req('POST', '/v1/missions', {
      body: { repo: dir, spec, kind: 'continuous' }
    });
    assert.equal(other.body.mission.kind, 'objective');
  });

  test('validation errors → 400 {error}; unknown repo → 404', async () => {
    for (const [body, match] of [
      [{}, /required/],
      [{ repo: dir }, /required/],
      [{ repo: dir, spec: { objective: 'x' } }, /required/],
      [{ repo: dir, spec: { objective: 'x'.repeat(4097), acceptanceCriteria: ['c'] } }, /too large/],
      [{ repo: dir, spec, inPlace: true }, /in-place/i]
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const res = await req('POST', '/v1/missions', { body });
      assert.equal(res.status, 400, JSON.stringify(body));
      keys(res.body, ['error'], 'error envelope');
      assert.match(res.body.error, match);
    }
    const res = await req('POST', '/v1/missions', { body: { repo: '/no/such/repo', spec } });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'unknown repo: /no/such/repo');
  });

  test('invalid JSON body → the route-level catch maps to 500', async () => {
    const res = await new Promise<FixtureResponse>((resolve, reject) => {
      const r = request(`${api.url}/v1/missions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      }, res2 => {
        let data = '';
        res2.on('data', (c: Buffer) => { data += c.toString(); });
        res2.once('end', () => resolve({
          status: res2.statusCode!, headers: res2.headers,
          body: JSON.parse(data) as Record<string, any>, raw: data
        }));
        res2.once('error', reject);
      });
      r.once('error', reject);
      r.end('{not json');
    });
    // body() rejects → caught by the server-level handler → 500 {error}.
    assert.equal(res.status, 500);
    keys(res.body, ['error'], 'error envelope');
    assert.equal(res.body.error, 'internal error');
  });
});

describe('GET /v1/missions/:id', () => {
  test('200 → {schemaVersion, mission, tasks}', async () => {
    const res = await req('GET', `/v1/missions/${missionId}`);
    assert.equal(res.status, 200);
    keys(res.body, ['schemaVersion', 'mission', 'tasks'], 'detail response');
    assert.equal(res.body.schemaVersion, 1);
    keys(res.body.mission, MISSION_SUMMARY_KEYS, 'detail summary');
    assert.deepEqual(res.body.tasks, []);
  });

  test('unknown id → 404 with the mission id in the error', async () => {
    const res = await req('GET', '/v1/missions/msn_missing');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'mission not found: msn_missing');
  });
});

describe('GET /v1/missions/:id/events (paged)', () => {
  test('pins the page envelope', async () => {
    const res = await req('GET', `/v1/missions/${missionId}/events`);
    assert.equal(res.status, 200);
    keys(res.body, ['schemaVersion', 'missionId', 'events', 'skippedLines', 'nextAfter', 'hasMore'], 'events page');
    assert.equal(res.body.schemaVersion, 1);
    assert.equal(res.body.missionId, missionId);
    assert.equal(res.body.hasMore, false);
    assert.equal(res.body.skippedLines, 0);
    // mission_created + state-mutating fixture writes → at least seq 1
    assert.ok(res.body.events.length >= 1);
    const evt = res.body.events[0] as RuntimeEvent;
    keys(evt as Record<string, any>, ['id', 'seq', 'type', 'at', 'missionId', 'data'], 'event record');
    assert.equal(evt.type, 'mission_created');
    assert.equal(evt.missionId, missionId);
    assert.equal(res.body.nextAfter, res.body.events.at(-1).seq);
  });

  test('?after and ?limit paginate; nextAfter resumes the page', async () => {
    store.emit(missionId, 'checkpoint_created', { sha: 'c1' });
    store.emit(missionId, 'checkpoint_created', { sha: 'c2' });
    const page1 = await req('GET', `/v1/missions/${missionId}/events?limit=1`);
    assert.equal(page1.body.events.length, 1);
    assert.equal(page1.body.hasMore, true);
    const page2 = await req('GET',
      `/v1/missions/${missionId}/events?after=${page1.body.nextAfter}&limit=100`);
    assert.ok(page2.body.events.every((e: RuntimeEvent) => (e.seq ?? 0) > page1.body.nextAfter));
    // ?follow=0 stays page mode; non-numeric after degrades to 0
    const notFollow = await req('GET', `/v1/missions/${missionId}/events?follow=0&after=abc`);
    assert.equal(notFollow.status, 200);
    assert.match(String(notFollow.headers['content-type']), /application\/json/);
  });
});

describe('mission actions', () => {
  test('POST pause → 200 {mission} (created state is left as-is)', async () => {
    const res = await req('POST', `/v1/missions/${missionId}/pause`);
    assert.equal(res.status, 200);
    keys(res.body, ['mission'], 'pause response');
    assert.equal(res.body.mission.state, MissionState.CREATED);
  });

  test('POST resume → 409 {error} for a non-recoverable state', async () => {
    const res = await req('POST', `/v1/missions/${missionId}/resume`);
    assert.equal(res.status, 409);
    keys(res.body, ['error'], 'conflict envelope');
  });

  test('POST cancel → 200 {mission} with terminal state', async () => {
    const res = await req('POST', `/v1/missions/${missionId}/cancel`);
    assert.equal(res.status, 200);
    keys(res.body, ['mission'], 'cancel response');
    assert.equal(res.body.mission.state, MissionState.CANCELLED);
  });
});

describe('approvals routes', () => {
  test('GET /v1/missions/:id/approvals → ledger entries', async () => {
    const res = await req('GET', `/v1/missions/${missionId}/approvals`);
    assert.equal(res.status, 200);
    keys(res.body, ['schemaVersion', 'approvals'], 'approvals list');
    assert.equal(res.body.schemaVersion, 1);
    const entry = res.body.approvals.find((a: any) => a.id === approvalId);
    assert.ok(entry, 'ledger must contain the pending request');
    keys(entry, ['id', 'gate', 'detail', 'status', 'requestedAt'], 'approval entry');
    assert.equal(entry.status, 'pending');
  });

  test('POST approvals/:approvalId decides; absent decision means approved', async () => {
    // No `decision` field → approved (documented default; only 'denied' denies).
    const res = await req('POST', `/v1/missions/${missionId}/approvals/${approvalId}`, {
      body: { by: 'contract-test' }
    });
    assert.equal(res.status, 200);
    keys(res.body, ['approval'], 'decision response');
    const a = res.body.approval;
    assert.equal(a.id, approvalId);
    assert.equal(a.status, 'approved');
    assert.equal(a.decidedBy, 'contract-test');
    assert.ok(isIso(a.decidedAt));
    // Re-deciding a settled approval conflicts.
    const again = await req('POST', `/v1/missions/${missionId}/approvals/${approvalId}`, {
      body: { decision: 'denied' }
    });
    assert.equal(again.status, 409);
    keys(again.body, ['error'], 'conflict envelope');
    // Unknown approval id → 409 (same envelope — no existence leak split).
    const missing = await req('POST', `/v1/missions/${missionId}/approvals/ap_nope`, { body: {} });
    assert.equal(missing.status, 409);
    assert.equal(loadApprovals(store.dir(missionId)).find(x => x.id === approvalId)?.status, 'approved');
  });
});

describe('unknown routes and edge paths', () => {
  test('unknown route → 404 "not found: METHOD path"', async () => {
    const res = await req('GET', '/v1/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'not found: GET /v1/nope');
  });

  test('trailing slashes are not normalized', async () => {
    for (const p of ['/v1/missions/', '/v1/status/']) {
      const res = await req('GET', p);
      assert.equal(res.status, 404, `GET ${p} must 404 — paths are exact`);
    }
  });

  test('unknown mission action → 404', async () => {
    const res = await req('GET', `/v1/missions/${missionId}/bogus`);
    assert.equal(res.status, 404);
    assert.match(res.body.error, /^not found: GET /);
  });

  test('wrong method on a known path → 404', async () => {
    // POST /v1/missions/:id (no action) is not a route.
    const res = await req('POST', `/v1/missions/${missionId}`, { body: {} });
    assert.equal(res.status, 404);
  });

  test('unauthenticated and host-mismatch envelopes are {error}', async () => {
    const unauth = await new Promise<FixtureResponse>((resolve, reject) => {
      const r = request(`${api.url}/v1/status`, res2 => {
        let data = '';
        res2.on('data', (c: Buffer) => { data += c.toString(); });
        res2.once('end', () => resolve({
          status: res2.statusCode!, headers: res2.headers,
          body: JSON.parse(data) as Record<string, any>, raw: data
        }));
      });
      r.once('error', reject);
      r.end();
    });
    assert.equal(unauth.status, 401);
    keys(unauth.body, ['error'], '401 envelope');
    assert.equal(unauth.body.error, 'unauthorized: bearer token required');

    const port = new URL(api.url).port;
    const badHost = await new Promise<FixtureResponse>((resolve, reject) => {
      const r = request(`${api.url}/v1/status`, {
        headers: { Authorization: `Bearer ${token}`, Host: `evil.example:${port}` }
      }, res2 => {
        let data = '';
        res2.on('data', (c: Buffer) => { data += c.toString(); });
        res2.once('end', () => resolve({
          status: res2.statusCode!, headers: res2.headers,
          body: JSON.parse(data) as Record<string, any>, raw: data
        }));
      });
      r.once('error', reject);
      r.end();
    });
    assert.equal(badHost.status, 403);
    keys(badHost.body, ['error'], '403 envelope');
  });
});

describe('GET /v1/missions/:id/events?follow (NDJSON contract)', () => {
  function stream(path: string): Promise<{ status: number; headers: IncomingHttpHeaders; lines: Record<string, any>[] }> {
    return new Promise((resolve, reject) => {
      const lines: Record<string, any>[] = [];
      let status = 0;
      let headers: IncomingHttpHeaders = {};
      let partial = '';
      const r = request(`${api.url}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Connection: 'close' }
      }, res => {
        status = res.statusCode!;
        headers = res.headers;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          partial += chunk;
          const parts = partial.split('\n');
          partial = parts.pop() ?? '';
          for (const l of parts) if (l) lines.push(JSON.parse(l));
        });
        res.on('end', () => {
          if (partial) lines.push(JSON.parse(partial));
          resolve({ status, headers, lines });
        });
        res.on('error', reject);
      });
      r.setTimeout(15_000, () => r.destroy(new Error('follow stream timed out')));
      r.once('error', reject);
      r.end();
    });
  }

  test('terminal mission: begin → event lines → end(terminal), headers pinned', async () => {
    // missionId was cancelled by the actions suite above — terminal already.
    const s = await stream(`/v1/missions/${missionId}/events?follow=1`);
    assert.equal(s.status, 200);
    assert.match(String(s.headers['content-type']), /^application\/x-ndjson/);
    assert.equal(s.headers['cache-control'], 'no-cache, no-transform');
    assert.equal(s.headers['x-accel-buffering'], 'no');
    keys(s.lines[0], ['meta', 'missionId', 'state', 'after', 'at'], 'begin line');
    assert.equal(s.lines[0].meta, 'begin');
    assert.equal(s.lines[0].missionId, missionId);
    assert.equal(s.lines[0].after, 0);
    const events = s.lines.filter(l => typeof l.seq === 'number');
    assert.ok(events.length >= 1 && events.every(e => e.missionId === missionId));
    const last = s.lines.at(-1)!;
    keys(last, ['meta', 'reason', 'state', 'skippedLines', 'at'], 'end line');
    assert.equal(last.meta, 'end');
    assert.equal(last.reason, 'terminal');
    assert.equal(last.state, MissionState.CANCELLED);
    assert.equal(typeof last.skippedLines, 'number');
  });

  test('follower cap → 429 {error}', async () => {
    const capped = new ControlApi({
      host: '127.0.0.1', port: 0, token,
      repos: new Map([[dir, { store, policy: loadPolicy(dir).policy }]]),
      scheduler: new MissionScheduler(), version: 'contract-test', startedAt: Date.now(),
      maxFollowers: 0 // every follow request exceeds the cap
    });
    await capped.start();
    try {
      const res = await new Promise<FixtureResponse>((resolve, reject) => {
        const r = request(`${capped.url}/v1/missions/${missionId}/events?follow=1`, {
          headers: { Authorization: `Bearer ${token}` }
        }, res2 => {
          let data = '';
          res2.on('data', (c: Buffer) => { data += c.toString(); });
          res2.once('end', () => resolve({
            status: res2.statusCode!, headers: res2.headers,
            body: JSON.parse(data) as Record<string, any>, raw: data
          }));
        });
        r.once('error', reject);
        r.end();
      });
      assert.equal(res.status, 429);
      keys(res.body, ['error'], '429 envelope');
      assert.match(res.body.error, /too many open event streams/);
    } finally {
      await capped.stop();
    }
  });
});
