import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function probe(mode: string) {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('./fixtures/file-lock-probe.ts', import.meta.url)), mode
  ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  // External bound also contains a broken retry loop; phases distinguish
  // loader/setup/attempt/cleanup failures without printing credentials.
  if (result.error) assert.fail(`probe ${mode}: ${result.error.message}\n${result.stderr}\n${result.stdout}`);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const mode of ['aged-live', 'fresh-live', 'malformed', 'invalid-pid', 'invalid-nonce', 'probe-eperm', 'probe-unknown', 'replacement']) {
  test(`lock contention preserves ${mode} ownership`, () => {
    const result = probe(mode);
    assert.equal(result.entered, false, mode);
    assert.equal(result.preserved, true, mode);
    assert.equal(result.error, 'LockTimeoutError', mode);
  });
}
for (const mode of ['stat-eperm', 'read-eperm', 'unlink-eperm', 'stat-enoent', 'unlink-enoent']) {
  test(`lock ${mode} fails closed within the external deadline`, () => {
    const result = probe(mode);
    assert.equal(result.entered, false);
    assert.equal(result.preserved, true);
    assert.equal(result.error, mode.endsWith('eperm') ? 'EPERM' : 'LockTimeoutError');
  });
}
test('stale lock from an exited child can be recovered', () => {
  const result = probe('dead');
  assert.equal(result.entered, true);
  assert.equal(result.error, undefined);
});
test('callback failure releases the owning lock', () => {
  const result = probe('callback-error');
  assert.equal(result.error, 'callback');
  assert.equal(result.preserved, true);
});
test('nonfinite or negative lock bounds fail before creating a lock', () => {
  const result = probe('invalid-bounds');
  assert.equal(result.entered, false);
  assert.equal(result.error, 'RangeError');
  assert.equal(result.preserved, true);
});
test('zero timeout permits one free acquisition but no contended retry', () => {
  const result = probe('zero-timeout');
  assert.equal(result.freeAcquired, true);
  assert.equal(result.entered, false);
  assert.equal(result.error, 'LockTimeoutError');
  assert.equal(result.preserved, true);
});
