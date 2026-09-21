import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));

// Exercise the real CLI, not just MissionRunner: CLI planning must consume
// the same cumulative invocation budget as implementation and repair.
function runFixture(noPlan: boolean, opts: {
  cap?: number; worktree?: boolean; unborn?: boolean; mode?: 'invalid' | 'failed' | 'timeout';
} = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'alr-planning-budget-'));
  const repo = join(fixture, 'repo');
  const hooks = join(fixture, 'empty-hooks');
  mkdirSync(repo);
  mkdirSync(hooks);
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: repo, stdio: 'pipe', timeout: 30_000, windowsHide: true
  });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Planning fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.hooksPath', hooks]);
  const launches = join(fixture, 'launches.jsonl');
  const agent = join(fixture, 'agent.cjs');
  const verifier = join(fixture, 'verify.cjs');
  writeFileSync(agent, `
const fs = require('node:fs');
const planning = process.argv.slice(2).some(arg => arg.startsWith('You are a planning component'));
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify(planning ? 'plan' : 'execute') + '\\n');
if (planning) {
  fs.writeFileSync(${JSON.stringify(join(fixture, 'planning-cwd.txt'))}, process.cwd());
  const mode = ${JSON.stringify(opts.mode ?? 'success')};
  if (mode === 'failed') process.exit(7);
  else if (mode === 'timeout') setInterval(() => {}, 1000);
  else if (mode === 'invalid') console.log('not a plan');
  else console.log(JSON.stringify([{ title: 'Write result', dependsOn: [] }]));
}
else fs.writeFileSync('result.txt', 'verified output\\n');
`);
  writeFileSync(verifier, "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt', 'utf8'), 'verified output\\n');\n");
  const gate = [process.execPath, verifier];
  writeFileSync(join(repo, '.gitignore'), '.agentloop/\n');
  writeFileSync(join(repo, 'agentloop.config.json'), JSON.stringify({
    agents: [{ name: 'fixture', type: 'custom', command: process.execPath, args: [agent] }],
    defaultAgent: 'fixture', validationCommands: { content: gate }
  }));
  writeFileSync(join(repo, 'agentloop.policy.json'), JSON.stringify({
    allowLocalCommit: false, allowPush: 'never', allowPullRequest: 'never', allowMerge: 'never',
    maxAgentInvocations: opts.cap ?? 1, maxRepairPasses: 0, maxMissionMinutes: 2,
    agentTimeoutMs: opts.mode === 'timeout' ? 1000 : 10_000, allowedCommands: [gate]
  }));
  git(['add', '--', '.gitignore', 'agentloop.config.json', 'agentloop.policy.json']);
  if (!opts.unborn) {
    git(['-c', 'commit.gpgSign=false', 'commit', '-qm', 'Initialize fixture']);
    assert.equal(git(['status', '--porcelain']).toString(), '');
  }
  const result = spawnSync(process.execPath, [tsx, cli, 'run', 'Write result.txt',
    '--criteria', 'Exact content passes', ...(opts.worktree ? [] : ['--in-place', '--approve-in-place']),
    ...(noPlan ? ['--no-plan'] : [])], {
    cwd: repo, encoding: 'utf8', timeout: 90_000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGENTLOOP_LOG_FILE: join(fixture, 'runtime.log') }
  });
  assert.ifError(result.error);
  const ids = readdirSync(join(repo, '.agentloop', 'missions'));
  assert.equal(ids.length, 1);
  const missionDir = join(repo, '.agentloop', 'missions', ids[0]);
  const mission = JSON.parse(readFileSync(join(missionDir, 'mission.json'), 'utf8'));
  const receipt = existsSync(join(missionDir, 'receipt.json'))
    ? JSON.parse(readFileSync(join(missionDir, 'receipt.json'), 'utf8')) : undefined;
  const calls = existsSync(launches)
    ? readFileSync(launches, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { fixture, result, mission, receipt, calls };
}

test('CLI planning and execution share maxAgentInvocations=1', t => {
  const { fixture, result, mission, receipt, calls } = runFixture(false);
  t.diagnostic(JSON.stringify({ fixture, calls, state: mission.state, recorded: mission.usage.agentInvocations }));
  assert.ok(calls.length <= 1, `cap=1 launched ${calls.length} agents: ${calls.join(', ')}`);
  assert.deepEqual(calls, ['plan']);
  assert.equal(mission.usage.agentInvocations, 1);
  assert.equal(receipt.usage.agentInvocations, 1);
  assert.notEqual(result.status, 0, 'implementation must not run after planning consumes the cap');
  assert.equal(mission.state, 'failed');
  assert.equal(receipt.passes[0].kind, 'plan');
  assert.equal(receipt.passes[0].gates, undefined, 'planning is not validation');
  assert.equal(receipt.passes[0].review, undefined, 'planning is not execution review');
  assert.equal(receipt.passes[0].checkpointSha, undefined);
});

test('CLI cap2 plans inside the prepared worktree, then validates the worker', () => {
  const { fixture, result, mission, receipt, calls } = runFixture(false, { cap: 2, worktree: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(calls, ['plan', 'execute']);
  assert.equal(readFileSync(join(fixture, 'planning-cwd.txt'), 'utf8'), mission.workspace.path);
  assert.notEqual(mission.workspace.path, mission.repository.path);
  assert.equal(mission.usage.agentInvocations, 2);
  assert.equal(receipt.usage.agentInvocations, 2);
  assert.equal(receipt.planning.source, 'agent');
  assert.deepEqual(receipt.passes.map((p: { kind: string }) => p.kind), ['plan', 'execute']);
  assert.equal(receipt.passes[0].gates, undefined);
  assert.equal(receipt.passes[1].gates[0].passed, true);
});

test('CLI preflight rejection launches no planner or worker', () => {
  const { result, mission, calls } = runFixture(false, { unborn: true, worktree: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no commits/);
  assert.deepEqual(calls, []);
  assert.equal(mission.usage.agentInvocations, 0);
  assert.deepEqual(mission.passes, []);
});

for (const mode of ['invalid', 'failed', 'timeout'] as const) {
  test(`CLI ${mode} planner falls back without refunding its counted attempt`, () => {
    const { result, mission, receipt, calls } = runFixture(false, { cap: 2, mode });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(calls, ['plan', 'execute']);
    assert.equal(mission.usage.agentInvocations, 2);
    assert.equal(receipt.planning.source, 'fallback');
    assert.equal(receipt.passes[0].agentExit, mode === 'invalid' ? 'success' : mode);
    assert.equal(receipt.passes[1].gates[0].passed, true);
  });
}

test('CLI --no-plan allows the sole invocation to complete a real content gate', t => {
  const { fixture, result, mission, receipt, calls } = runFixture(true);
  t.diagnostic(JSON.stringify({ fixture, calls, state: mission.state, recorded: mission.usage.agentInvocations }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(calls, ['execute']);
  assert.equal(mission.state, 'completed');
  assert.equal(mission.usage.agentInvocations, 1);
  assert.equal(receipt.usage.agentInvocations, 1);
  assert.equal(receipt.passes.length, 1);
  assert.equal(receipt.passes[0].gates[0].passed, true);
});
