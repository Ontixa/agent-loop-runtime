import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from '../daemon/daemon.js';
import { MissionScheduler } from '../engine/scheduler.js';
import { setWriteFaultInjector } from '../util/atomic-file.js';

async function fixture(configured: boolean, bindFailure = false, publicationFailure = false) {
  const dir = mkdtempSync(join(tmpdir(), 'alr-daemon-startup-'));
  const oldHome = process.env.AGENTLOOP_HOME;
  const oldToken = process.env.AGENTLOOP_API_TOKEN;
  const signals = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
  process.env.AGENTLOOP_HOME = dir;
  delete process.env.AGENTLOOP_API_TOKEN;
  const token = configured ? `fixture_${randomBytes(24).toString('hex')}` : undefined;
  const daemon = new Daemon({ repos: [], scheduler: new MissionScheduler(), version: 'test',
    config: { host: '127.0.0.1', port: bindFailure ? -1 : 0, token } });
  try {
    if (publicationFailure) {
      setWriteFaultInjector((op, path) => {
        if (op === 'rename' && path === join(dir, 'daemon.json')) throw new Error('fixture publication failure');
      });
      await assert.rejects(daemon.start(), /fixture publication failure/);
      const api = (daemon as unknown as { api: { server: Server | null } }).api;
      assert.ok(!api.server?.listening, 'publication failure must close the listener');
      assert.equal(existsSync(join(dir, 'daemon.json')), false);
      assert.deepEqual(readdirSync(dir), [], 'failed atomic write must remove its credential-bearing temporary file');
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        assert.deepEqual(process.listeners(signal), signals[signal]);
      }
      return;
    }
    if (bindFailure) {
      await assert.rejects(daemon.start());
      assert.equal(existsSync(join(dir, 'daemon.json')), false, 'failed startup must not publish credentials');
      return;
    }
    await daemon.start();
    const state = JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8'));
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(dir, 'daemon.json')).mode & 0o777, 0o600);
    }
    assert.ok(Number(new URL(state.url).port) > 0, 'published URL must locate the running listener');
    const status = (bearer?: string) => new Promise<number>((resolve, reject) => {
      const req = request(`${state.url}/v1/status`, {
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode!)); res.once('error', reject);
      });
      req.setTimeout(10_000, () => req.destroy(new Error('fixture request timed out')));
      req.once('error', reject); req.end();
    });
    assert.equal(await status(), 401);
    assert.equal(await status(state.token), 200, 'published credential must authorize the running API');
    assert.ok(typeof state.token === 'string' && state.token.length > 0, 'credential must be populated');
    if (configured) assert.ok(state.token === token, 'configured credential must be preserved');
  } finally {
    setWriteFaultInjector(null);
    await daemon.stop();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signals[signal].includes(listener)) process.removeListener(signal, listener);
      }
    }
    if (oldHome === undefined) delete process.env.AGENTLOOP_HOME; else process.env.AGENTLOOP_HOME = oldHome;
    if (oldToken === undefined) delete process.env.AGENTLOOP_API_TOKEN; else process.env.AGENTLOOP_API_TOKEN = oldToken;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('daemon publishes its generated credential after API startup', () => fixture(false));
test('daemon publishes its configured credential after API startup', () => fixture(true));
test('failed API startup does not publish a daemon credential', () => fixture(false, true));
test('failed status publication closes the API and removes temporary credential state', () => fixture(false, false, true));
