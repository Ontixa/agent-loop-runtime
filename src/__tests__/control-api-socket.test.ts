import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlApi } from '../daemon/control-api.js';
import { Daemon } from '../daemon/daemon.js';
import { MissionScheduler } from '../engine/scheduler.js';
import { socketPathError } from '../daemon/socket-transport.js';

/**
 * Socket transport for the control API (daemon.socketPath / --socket):
 * a Unix domain socket on POSIX or a Windows named pipe replaces the TCP
 * loopback listener. Bearer auth, the Host-header gate and every route
 * behavior are unchanged — the socket only narrows network exposure.
 */

function endpoint(dir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\alr-test-${randomBytes(6).toString('hex')}`
    : join(dir, 'ctl.sock');
}

function api(socketPath: string, token = `fixture_${randomBytes(24).toString('hex')}`) {
  return new ControlApi({
    socketPath, token,
    repos: new Map(), scheduler: new MissionScheduler(), version: 'test', startedAt: Date.now()
  });
}

function sockReq(socketPath: string, path: string, opts: { token?: string; host?: string } = {}): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const r = request({
      socketPath, path,
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.host ? { Host: opts.host } : {})
      }
    }, res => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.once('end', () => {
        let body: Record<string, any> = {};
        try { body = JSON.parse(data); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode!, body });
      });
      res.once('error', reject);
    });
    r.setTimeout(10_000, () => r.destroy(new Error('fixture request timed out')));
    r.once('error', reject);
    r.end();
  });
}

describe('socketPathError — endpoint shape validation', () => {
  test('POSIX: absolute path inside the sun_path bound is accepted', () => {
    assert.equal(socketPathError('/run/agentloop/ctl.sock', 'linux'), null);
    assert.equal(socketPathError('/tmp/a.sock', 'darwin'), null);
  });

  test('POSIX: relative paths and oversized paths are rejected', () => {
    assert.match(socketPathError('ctl.sock', 'linux') ?? '', /absolute path/);
    assert.match(socketPathError(`/${'x'.repeat(200)}`, 'linux') ?? '', /sun_path/);
  });

  test('Windows: a named pipe path is required', () => {
    assert.equal(socketPathError('\\\\.\\pipe\\agentloop', 'win32'), null);
    assert.match(socketPathError('C:\\tmp\\ctl.sock', 'win32') ?? '', /named pipe/);
    assert.match(socketPathError('\\\\.\\pipe\\', 'win32') ?? '', /must not be empty/);
  });

  test('non-string, empty and control-character values are rejected', () => {
    assert.match(socketPathError(42) ?? '', /non-empty string/);
    assert.match(socketPathError('') ?? '', /non-empty string/);
    assert.match(socketPathError('/tmp/a\nb.sock', 'linux') ?? '', /control characters/);
  });
});

describe('control API over a socket endpoint', () => {
  test('serves /v1/status with bearer auth and the Host gate intact', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'alr-api-sock-'));
    const sock = endpoint(dir);
    const server = api(sock);
    try {
      assert.equal(server.transport, process.platform === 'win32' ? 'pipe' : 'unix');
      assert.equal(server.socketPath, sock);
      assert.equal(server.url, 'http://localhost', 'socket clients use the localhost request base');
      await server.start();

      assert.equal((await sockReq(sock, '/v1/status')).status, 401, 'no token → 401');
      const ok = await sockReq(sock, '/v1/status', { token: server.bearerToken });
      assert.equal(ok.status, 200, 'bearer token must authorize over the socket');
      assert.equal(ok.body.status, 'ok');
      assert.equal(ok.body.schemaVersion, 1);
      assert.equal(
        (await sockReq(sock, '/v1/status', { token: server.bearerToken, host: 'evil.example' })).status,
        403, 'foreign Host header → 403 even on a socket');

      if (process.platform !== 'win32') {
        assert.equal(statSync(sock).mode & 0o777, 0o600, 'socket file must be owner-only');
      }
      await server.stop();
      if (process.platform !== 'win32') {
        assert.equal(existsSync(sock), false, 'stop must release the socket file');
      } else {
        t.diagnostic('named pipe endpoints are not filesystem objects — nothing to unlink');
      }
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stale POSIX socket file is reclaimed; a live peer is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alr-api-sock-stale-'));
    const sock = endpoint(dir);
    try {
      if (process.platform !== 'win32') {
        // A dead daemon leaves the socket file behind — bind must recover it.
        writeFileSync(sock, 'stale');
      }
      const first = api(sock);
      await first.start();
      try {
        assert.equal((await sockReq(sock, '/v1/status', { token: first.bearerToken })).status, 200);
        // A second bind on a LIVE endpoint must fail — never silently
        // multi-instance the control surface (Windows pipes allow it at OS level).
        const second = api(sock);
        await assert.rejects(second.start(), /already in use/);
        await second.stop();
      } finally {
        await first.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an invalid endpoint fails closed before binding', async () => {
    const bad = process.platform === 'win32' ? 'not-a-pipe' : 'relative.sock';
    const server = api(bad);
    await assert.rejects(server.start(), process.platform === 'win32' ? /named pipe/ : /absolute path/);
    await server.stop();
  });
});

describe('daemon socket publication', () => {
  test('daemon.json carries socketPath + transport (no TCP url) and the token still works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alr-daemon-sock-'));
    const oldHome = process.env.AGENTLOOP_HOME;
    const oldToken = process.env.AGENTLOOP_API_TOKEN;
    const signals = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
    process.env.AGENTLOOP_HOME = dir;
    delete process.env.AGENTLOOP_API_TOKEN;
    const sock = endpoint(dir);
    const daemon = new Daemon({
      repos: [], scheduler: new MissionScheduler(), version: 'test',
      config: { socketPath: sock }
    });
    try {
      await daemon.start();
      const state = JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(state.transport, process.platform === 'win32' ? 'pipe' : 'unix');
      assert.equal(state.socketPath, sock, 'the endpoint must be discoverable by local tooling');
      assert.equal(state.url, undefined, 'a socket transport must not publish a TCP url');
      assert.ok(typeof state.token === 'string' && state.token.length > 0);
      const res = await sockReq(sock, '/v1/status', { token: state.token as string });
      assert.equal(res.status, 200, 'published credential must authorize over the socket');
    } finally {
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
  });
});
