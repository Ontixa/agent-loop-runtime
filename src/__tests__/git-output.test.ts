import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitSep, gitTry, GitOutputLimitError, MAX_GIT_OUTPUT_BYTES } from '../git/git-runner.js';

test('tiny Git output budget rejects instead of returning a complete version', async () => {
  await assert.rejects(() => gitSep(['--version'], process.cwd(), 10_000, { maxOutputBytes: 1 }),
    (error: unknown) => error instanceof GitOutputLimitError && error.stderr === '' && error.limitBytes === 1);
});

test('exact aggregate boundary returns complete Git output', async () => {
  const expected = await gitSep(['--version'], process.cwd());
  const bytes = Buffer.byteLength(expected.stdout) + Buffer.byteLength(expected.stderr);
  assert.deepEqual(await gitSep(['--version'], process.cwd(), 10_000, { maxOutputBytes: bytes }), expected);
  await assert.rejects(() => gitSep(['--version'], process.cwd(), 10_000, { maxOutputBytes: bytes - 1 }), GitOutputLimitError);
});

test('invalid budgets reject before executable lookup', async () => {
  for (const maxOutputBytes of [0, -1, NaN, Infinity, 1.5, MAX_GIT_OUTPUT_BYTES + 1]) {
    await assert.rejects(() => gitSep(['--version'], 'does-not-exist', 10_000, { maxOutputBytes }), RangeError);
  }
});

test('gitTry propagates overflow rather than reporting a missing result', async () => {
  await assert.rejects(() => gitTry(['--version'], process.cwd(), 10_000, { maxOutputBytes: 1 }), GitOutputLimitError);
});

test('overflow remains incomplete through safety callers in an isolated fixture', () => {
  const child = spawnSync(process.execPath, [
    fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('./fixtures/git-output-probe.ts', import.meta.url))
  ], { encoding: 'utf8', timeout: 90_000, windowsHide: true });
  assert.equal(child.error, undefined, `${child.error?.message}\n${child.stderr}`);
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
  assert.equal(result.checks.length, 6);
  assert.ok(result.directChildKillRequests > 0);
});
