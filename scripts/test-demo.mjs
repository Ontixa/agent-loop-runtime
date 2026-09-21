#!/usr/bin/env node
// Exercise the documented CLI contract, including a deliberately failed mission.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./demo-mission.mjs', import.meta.url));
for (const scenario of [
  { args: ['--help'], status: 0, message: 'Usage:' },
  { args: ['--unknown'], status: 2, message: 'Unknown argument' },
  { args: [], status: 0, message: 'Demo passed.' },
  { args: ['--fail-validation'], status: 1, message: 'Expected rejection:' }
]) {
  const result = spawnSync(process.execPath, [script, ...scenario.args], {
    encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  assert.ifError(result.error);
  assert.equal(result.status, scenario.status, output);
  assert.ok(output.includes(scenario.message), output);
  console.log(`PASS ${scenario.args.join(' ') || 'successful mission'}`);
  if (scenario.args.length === 0 || scenario.args.includes('--fail-validation')) {
    assert.ok(output.includes('Original checkout unchanged; worktree content and persisted receipt verified.'), output);
    console.log(output);
  }
}
