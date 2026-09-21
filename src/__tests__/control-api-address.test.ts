import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { ControlApi } from '../daemon/control-api.js';
import { MissionScheduler } from '../engine/scheduler.js';

function api(host: string, port = 0, configured = true) {
  return new ControlApi({ host, port,
    token: configured ? `fixture_${randomBytes(24).toString('hex')}` : undefined,
    repos: new Map(), scheduler: new MissionScheduler(), version: 'test', startedAt: Date.now() });
}

function status(url: string, token?: string, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}/v1/status`, { headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(host ? { Host: host } : {})
    } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode!)); res.once('error', reject);
    });
    req.setTimeout(10_000, () => req.destroy(new Error('fixture request timed out')));
    req.once('error', reject); req.end();
  });
}

for (const host of ['127.0.0.1', '::1']) {
  test(`published ${host} URL uses the live port and enforces Host/auth`, async t => {
    const server = api(host);
    const fallback = `http://${host === '::1' ? '[::1]' : host}:0`;
    try {
      assert.equal(server.url, fallback);
      try { await server.start(); }
      catch (error) {
        if (host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EPROTONOSUPPORT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          t.skip('OS cannot bind IPv6 loopback'); return;
        }
        throw error;
      }
      const url = new URL(server.url);
      assert.ok(Number(url.port) > 0, 'published port must be assigned by the listener');
      assert.equal(await status(server.url, server.bearerToken), 200);
      assert.equal(await status(server.url), 401);
      assert.equal(await status(server.url, server.bearerToken, `evil.example:${url.port}`), 403);
      assert.equal(await status(server.url, server.bearerToken, `${url.hostname}:0`), 403);
      const wrongPort = Number(url.port) === 65535 ? 65534 : Number(url.port) + 1;
      assert.equal(await status(server.url, server.bearerToken, `${url.hostname}:${wrongPort}`), 403);
    } finally {
      await server.stop();
    }
    assert.equal(server.url, fallback, 'stop must discard the assigned port');
  });
}

test('failed bind retains configured URL, not a stale listening address', async () => {
  const server = api('127.0.0.1', -1);
  try { await assert.rejects(server.start()); }
  finally { await server.stop(); }
  assert.equal(server.url, 'http://127.0.0.1:-1');
});

test('actual assigned port is accepted without a Host override', async () => {
  const server = api('127.0.0.1');
  try {
    await server.start();
    const listener = (server as unknown as { server: Server }).server;
    const { port } = listener.address() as AddressInfo;
    assert.equal(await status(`http://127.0.0.1:${port}`, server.bearerToken), 200);
  } finally { await server.stop(); }
});

test('nonloopback binding still requires an explicit credential', async () => {
  const server = api('0.0.0.0', 0, false);
  try { await assert.rejects(server.start(), /without a token/); }
  finally { await server.stop(); }
  assert.equal(server.url, 'http://0.0.0.0:0');
});
