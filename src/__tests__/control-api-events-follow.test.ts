import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlApi } from '../daemon/control-api.js';
import { MissionScheduler } from '../engine/scheduler.js';
import { MissionStore } from '../mission/mission-store.js';
import { createMission } from '../engine/mission-factory.js';
import { resolvePolicy } from '../policy/policy.js';
import { AgentType, MissionState } from '../types.js';
import type { Policy } from '../types.js';
import type { FollowLimits } from '../daemon/event-follow.js';

/**
 * Route-level coverage for `GET /v1/missions/:id/events?follow` — the NDJSON
 * live tail used by the cockpit. Missions are real persisted records (no git
 * checkout needed for route behavior); follow limits are shrunk so timers
 * fire within the test.
 */

interface Fixture {
  dir: string;
  store: MissionStore;
  api: ControlApi;
  token: string;
  url: string;
  mission: { id: string };
  /** Live follower set inside ControlApi (private — inspected like other route tests). */
  followers: Set<unknown>;
}

interface StreamHandle {
  req: ClientRequest;
  lines: Array<Record<string, unknown>>;
  raw: () => string;
  done: Promise<void>;
  status: () => number;
  header: (name: string) => string | string[] | undefined;
}

async function fixture(limits: FollowLimits = {}, maxFollowers?: number): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'alr-follow-api-'));
  const store = new MissionStore(dir);
  const policy: Policy = resolvePolicy();
  const mission = createMission({
    repoPath: dir, policy,
    spec: { objective: 'Follow fixture', acceptanceCriteria: ['not executed by route tests'] },
    agent: { name: 'fixture', type: AgentType.CUSTOM, command: process.execPath }
  }, store);
  const token = `fixture_${randomBytes(24).toString('hex')}`;
  const api = new ControlApi({
    host: '127.0.0.1', port: 0, token,
    repos: new Map([[dir, { store, policy }]]), scheduler: new MissionScheduler(),
    version: 'test', startedAt: Date.now(),
    follow: { pollMs: 25, heartbeatMs: 50, drainMs: 60, maxDurationMs: 45_000, ...limits },
    ...(maxFollowers !== undefined ? { maxFollowers } : {})
  });
  await api.start();
  const followers = (api as unknown as { followers: Set<unknown> }).followers;
  return { dir, store, api, token, url: api.url, mission, followers };
}

async function cleanup(f: Fixture): Promise<void> {
  await f.api.stop();
  rmSync(f.dir, { recursive: true, force: true });
}

/**
 * Open a request and parse the response as NDJSON lines. `done` resolves on
 * stream end OR request/socket failure (error is retained for inspection) so
 * disconnect paths never hang a test.
 */
function stream(f: Fixture, path: string, token?: string): StreamHandle {
  const lines: Array<Record<string, unknown>> = [];
  let raw = '';
  let status = 0;
  let headers: IncomingHttpHeaders = {};
  let partial = '';
  let settled = false;
  const pushLine = (line: string) => {
    if (!line) return;
    try { lines.push(JSON.parse(line) as Record<string, unknown>); }
    catch { lines.push({ unparsed: line }); }
  };
  const handle: StreamHandle = {
    req: undefined as unknown as ClientRequest,
    lines,
    raw: () => raw,
    done: undefined as unknown as Promise<void>,
    status: () => status,
    header: n => headers[n]
  };
  handle.done = new Promise<void>(resolve => {
    const finish = () => {
      if (settled) return;
      settled = true;
      pushLine(partial); // last line may lack a trailing newline (JSON errors)
      resolve();
    };
    const req = request(`${f.url}${path}`, {
      // No connection reuse: each fixture socket must die with its response so
      // api.stop() does not wait out the server keep-alive timeout.
      headers: { Connection: 'close', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    }, res => {
      status = res.statusCode!;
      headers = res.headers;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
        partial += chunk;
        const parts = partial.split('\n');
        partial = parts.pop() ?? '';
        for (const line of parts) pushLine(line);
      });
      res.on('end', finish);
      res.on('error', finish);
    });
    req.setTimeout(30_000, () => req.destroy(new Error('fixture request timed out')));
    req.on('error', finish); // disconnect tests destroy the socket — not a failure
    req.end();
    handle.req = req;
  });
  return handle;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('follow requires the bearer token', async () => {
  const f = await fixture();
  try {
    for (const token of [undefined, 'wrong-token']) {
      const s = stream(f, `/v1/missions/${f.mission.id}/events?follow=1`, token);
      await s.done;
      assert.equal(s.status(), 401);
      assert.equal(f.followers.size, 0, 'rejected requests must not hold a follower slot');
    }
  } finally { await cleanup(f); }
});

test('follow on an unknown mission keeps not-found semantics', async () => {
  const f = await fixture();
  try {
    const s = stream(f, '/v1/missions/msn-nope/events?follow=1', f.token);
    await s.done;
    assert.equal(s.status(), 404);
    assert.match(String(s.lines[0]?.error ?? ''), /mission not found/);
  } finally { await cleanup(f); }
});

test('without follow the events route still returns the JSON page', async () => {
  const f = await fixture();
  try {
    const s = stream(f, `/v1/missions/${f.mission.id}/events`, f.token);
    await s.done;
    assert.equal(s.status(), 200);
    assert.match(String(s.header('content-type')), /application\/json/);
    const body = JSON.parse(s.raw());
    assert.ok(Array.isArray(body.events), 'page mode keeps the events array shape');
    assert.equal(body.missionId, f.mission.id);
  } finally { await cleanup(f); }
});

test('terminal missions replay the log then close with reason terminal', async () => {
  const f = await fixture();
  try {
    f.store.transition(f.store.mustLoad(f.mission.id), MissionState.CANCELLED, 'done');
    const s = stream(f, `/v1/missions/${f.mission.id}/events?follow=1`, f.token);
    await s.done;
    assert.equal(s.status(), 200);
    assert.match(String(s.header('content-type')), /application\/x-ndjson/);
    assert.equal(s.lines[0]?.meta, 'begin');
    const events = s.lines.filter(l => typeof l.seq === 'number');
    assert.ok(events.some(e => e.type === 'mission_created'));
    assert.ok(events.some(e => e.type === 'state_changed' &&
      (e.data as { to?: string })?.to === MissionState.CANCELLED));
    const last = s.lines.at(-1)!;
    assert.equal(last.meta, 'end');
    assert.equal(last.reason, 'terminal');
    assert.equal(last.state, MissionState.CANCELLED);
    await until(() => f.followers.size === 0, 'follower cleanup after close');
  } finally { await cleanup(f); }
});

test('?after filters the replayed backlog before live appends', async () => {
  const f = await fixture();
  try {
    f.store.emit(f.mission.id, 'checkpoint_created', { sha: 'old' });
    const s = stream(f, `/v1/missions/${f.mission.id}/events?follow&after=1`, f.token);
    await until(() => s.lines.some(l => l.meta === 'begin'), 'stream begin');
    // seq 1 is mission_created; only the checkpoint (seq 2) may replay.
    await until(() => s.lines.some(l => l.type === 'checkpoint_created'), 'replayed checkpoint');
    assert.ok(!s.lines.some(l => l.type === 'mission_created'), 'after=1 must skip seq 1');
  } finally { await cleanup(f); }
});

test('live appends stream to an open follower and terminal state ends it', async () => {
  const f = await fixture();
  try {
    const s = stream(f, `/v1/missions/${f.mission.id}/events?follow`, f.token);
    await until(() => f.followers.size === 1, 'follower registration');
    await until(() => s.lines.some(l => l.type === 'mission_created'), 'replayed mission_created');

    f.store.emit(f.mission.id, 'checkpoint_created', { sha: 'cafe', kind: 'manual' });
    await until(() => s.lines.some(l =>
      l.type === 'checkpoint_created' && (l.data as { sha?: string })?.sha === 'cafe'),
      'live checkpoint_created event');

    f.store.transition(f.store.mustLoad(f.mission.id), MissionState.CANCELLED, 'test done');
    await s.done;
    const last = s.lines.at(-1)!;
    assert.equal(last.meta, 'end');
    assert.equal(last.reason, 'terminal');
    assert.ok(s.lines.some(l => l.type === 'state_changed' &&
      (l.data as { to?: string })?.to === MissionState.CANCELLED),
      'the terminal transition event itself must be streamed before close');
    await until(() => f.followers.size === 0, 'follower cleanup after terminal close');
  } finally { await cleanup(f); }
});

test('idle followers receive heartbeat meta lines', async () => {
  const f = await fixture();
  try {
    const s = stream(f, `/v1/missions/${f.mission.id}/events?follow=1`, f.token);
    await until(() => s.lines.filter(l => l.meta === 'heartbeat').length >= 2, 'heartbeats');
    assert.ok(s.lines.every(l => l.meta || typeof l.seq === 'number' || 'unparsed' in l),
      'every line is either an event or a meta line');
  } finally { await cleanup(f); }
});

test('the hard duration cap ends a non-terminal follow with reason limit', async () => {
  const f = await fixture({ maxDurationMs: 150 });
  try {
    const s = stream(f, `/v1/missions/${f.mission.id}/events?follow=1`, f.token);
    await s.done;
    const last = s.lines.at(-1)!;
    assert.equal(last.meta, 'end');
    assert.equal(last.reason, 'limit');
    assert.equal(f.followers.size, 0);
  } finally { await cleanup(f); }
});

test('client disconnect releases the follower slot', async () => {
  const f = await fixture();
  try {
    const s = stream(f, `/v1/missions/${f.mission.id}/events?follow=1`, f.token);
    await until(() => f.followers.size === 1, 'follower registration');
    s.req.destroy();
    await until(() => f.followers.size === 0, 'follower cleanup after disconnect');
  } finally { await cleanup(f); }
});

test('the connection cap rejects extra followers with 429', async () => {
  const f = await fixture({}, 1);
  try {
    const first = stream(f, `/v1/missions/${f.mission.id}/events?follow=1`, f.token);
    await until(() => f.followers.size === 1, 'first follower registration');
    const second = stream(f, `/v1/missions/${f.mission.id}/events?follow=1`, f.token);
    await second.done;
    assert.equal(second.status(), 429);
    assert.equal(f.followers.size, 1, 'a rejected stream must not consume a slot');
    first.req.destroy();
    await until(() => f.followers.size === 0, 'first follower cleanup');
  } finally { await cleanup(f); }
});

test('api stop closes an open follower promptly', async () => {
  const f = await fixture();
  const s = stream(f, `/v1/missions/${f.mission.id}/events?follow=1`, f.token);
  await until(() => f.followers.size === 1, 'follower registration');
  await f.api.stop();
  await s.done;
  assert.equal(f.followers.size, 0);
  rmSync(f.dir, { recursive: true, force: true });
});
