import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
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
import type { MissionSpec } from '../types.js';

/**
 * Bearer-token enforcement across the ENTIRE control-API route surface.
 *
 * Route inventory is enumerated explicitly from daemon/control-api.ts — every
 * route must reject a missing or wrong bearer token with 401 BEFORE touching
 * mission state. The only intentionally unauthenticated response is the CORS
 * preflight (OPTIONS → 204, empty body): it carries no data and is required
 * for browser preflight semantics. If a future route ships unauthenticated,
 * this suite fails — the allowlist must be edited deliberately.
 *
 * No git required: missions stay in `created` state (never prepared), so no
 * worktree/preflight runs. The scheduler is intentionally NOT registered with
 * the repo — `POST /v1/missions` persists + enqueues, but no runner starts.
 */

interface FixtureRequest {
  status: number;
  body: Record<string, any>;
}

let dir: string;
let store: MissionStore;
let api: ControlApi;
let token: string;
let missionId: string;
let approvalId: string;

const spec: MissionSpec = { objective: 'Auth fixture mission', acceptanceCriteria: ['n/a'] };
const WRONG_TOKEN = `alr_${randomBytes(24).toString('hex')}`;

function req(method: string, path: string, opts: { token?: string | null; host?: string; body?: unknown } = {}): Promise<FixtureRequest> {
  return new Promise((resolve, reject) => {
    const r = request(`${api.url}${path}`, {
      method,
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.host ? { Host: opts.host } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {})
      }
    }, res => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.once('end', () => {
        let parsed: Record<string, any> = {};
        try { parsed = JSON.parse(data); } catch { /* empty/non-JSON body */ }
        resolve({ status: res.statusCode!, body: parsed });
      });
      res.once('error', reject);
    });
    r.setTimeout(10_000, () => r.destroy(new Error('fixture request timed out')));
    r.once('error', reject);
    if (opts.body !== undefined) r.write(JSON.stringify(opts.body));
    r.end();
  });
}

/**
 * Full route inventory (daemon/control-api.ts `handle()`). `authed` is the
 * exact status a correctly-authenticated request must return against the
 * fixture state — auth passing is proven by reaching the route's real verdict.
 */
const routes = (): Array<{ method: string; path: string; body?: unknown; authed: number }> => [
  { method: 'GET',  path: '/v1/status',                                              authed: 200 },
  { method: 'GET',  path: '/v1/missions',                                            authed: 200 },
  { method: 'POST', path: '/v1/missions',   body: { repo: dir, spec },               authed: 201 },
  { method: 'GET',  path: `/v1/missions/${missionId}`,                               authed: 200 },
  { method: 'GET',  path: `/v1/missions/${missionId}/events`,                        authed: 200 },
  { method: 'GET',  path: `/v1/missions/${missionId}/approvals`,                     authed: 200 },
  { method: 'POST', path: `/v1/missions/${missionId}/approvals/${approvalId}`,
    body: { decision: 'denied', by: 'auth-test' },                                   authed: 200 },
  { method: 'POST', path: `/v1/missions/${missionId}/pause`,                         authed: 200 },
  // A `created` mission is not recoverable → the route's real verdict is 409.
  { method: 'POST', path: `/v1/missions/${missionId}/resume`,                        authed: 409 },
  // created → cancelled is legal; keep last — the mission goes terminal.
  { method: 'POST', path: `/v1/missions/${missionId}/cancel`,                        authed: 200 }
];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'alr-api-auth-'));
  store = new MissionStore(dir);
  const mission = createMission({
    repoPath: dir, spec,
    agent: { name: 'fake', type: AgentType.CUSTOM, command: process.execPath, args: [] }
  }, store);
  missionId = mission.id;
  approvalId = requestApproval(store.dir(missionId), missionId, 'push', 'fixture gate').id;
  api = new ControlApi({
    host: '127.0.0.1', port: 0,
    token: `fixture_${randomBytes(24).toString('hex')}`,
    repos: new Map([[dir, { store, policy: loadPolicy(dir).policy }]]),
    scheduler: new MissionScheduler(), // repo NOT registered: enqueue never starts a runner
    version: 'test', startedAt: Date.now()
  });
  await api.start();
  token = api.bearerToken;
});
after(async () => {
  await api.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('control API bearer enforcement — every route', () => {
  test('no token → 401 on every route, before any handler runs', async () => {
    for (const r of routes()) {
      const res = await req(r.method, r.path, { body: r.body });
      assert.equal(res.status, 401, `${r.method} ${r.path} must reject missing token`);
      assert.equal(res.body.error, 'unauthorized: bearer token required');
      assert.ok(!JSON.stringify(res.body).includes(r.path), '401 must not echo route info');
    }
  });

  test('wrong token → 401 on every route', async () => {
    for (const r of routes()) {
      const res = await req(r.method, r.path, { token: WRONG_TOKEN, body: r.body });
      assert.equal(res.status, 401, `${r.method} ${r.path} must reject wrong token`);
    }
  });

  test('malformed Authorization headers → 401', async () => {
    for (const header of ['', 'Basic dXNlcjpwYXNz', 'Bearer', `bearer ${token}`, `Bearer ${token}x`]) {
      const res = await new Promise<FixtureRequest>((resolve, reject) => {
        const r = request(`${api.url}/v1/status`, { headers: { Authorization: header } }, res2 => {
          res2.resume();
          res2.once('end', () => resolve({ status: res2.statusCode!, body: {} }));
          res2.once('error', reject);
        });
        r.setTimeout(10_000, () => r.destroy(new Error('fixture request timed out')));
        r.once('error', reject);
        r.end();
      });
      assert.equal(res.status, 401, `Authorization: ${JSON.stringify(header)} must not authenticate`);
    }
  });

  test('correct token reaches each route — real verdicts, never 401/403', async () => {
    for (const r of routes()) {
      const res = await req(r.method, r.path, { token, body: r.body });
      assert.equal(res.status, r.authed, `${r.method} ${r.path} authed → ${r.authed}, got ${res.status}`);
    }
    // The cancel route above moved the fixture mission to a terminal state —
    // prove the mutation actually happened (auth passed, route executed).
    assert.equal(store.mustLoad(missionId).state, MissionState.CANCELLED);
    assert.equal(loadApprovals(store.dir(missionId)).find(a => a.id === approvalId)?.status, 'denied');
  });
});

describe('unauthenticated surface — explicit allowlist', () => {
  test('OPTIONS preflight is the ONLY unauthenticated response (204, empty body)', async () => {
    for (const path of ['/', '/v1/status', '/v1/missions', `/v1/missions/${missionId}`]) {
      const res = await req('OPTIONS', path);
      assert.equal(res.status, 204, `OPTIONS ${path} must be a bare preflight`);
    }
    // A preflight must carry no payload — body parsed empty above. And it must
    // not be a backdoor: POST with an OPTIONS-ish shape still needs auth.
    assert.equal((await req('POST', '/v1/missions', { body: { spec } })).status, 401);
  });

  test('unknown/unimplemented paths → 401 unauthenticated (no route enumeration)', async () => {
    for (const path of ['/v1/nope', '/v1/debug', '/v1/config', '/v1/shutdown',
      `/v1/missions/${missionId}/log`, '/v1/missions/ap_nonexistent/x', '/v2/status', '/']) {
      const res = await req('GET', path);
      assert.equal(res.status, 401, `GET ${path} must not reveal existence without auth`);
    }
    // With auth the same probes get the honest 404 — existence leaks only to
    // authenticated callers, never the other way around.
    assert.equal((await req('GET', '/v1/nope', { token })).status, 404);
  });

  test('host-header mismatch → 403 even with a valid token, before mutation', async () => {
    const port = new URL(api.url).port;
    const res = await req('GET', '/v1/status', { token, host: `evil.example:${port}` });
    assert.equal(res.status, 403);
  });
});
