#!/usr/bin/env node
// A deterministic custom-agent fixture, not an AI/vendor integration demo.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/demo-mission.mjs [--fail-validation]');
  console.log('Runs a bounded, provider-free custom-agent fixture in a retained temporary repository.');
  console.log('--fail-validation deliberately writes wrong content and exits 1 after validation rejects it.');
  process.exit(0);
}
if (args.some(arg => arg !== '--fail-validation')) {
  console.error('Unknown argument; use --help.');
  process.exit(2);
}

const failValidation = args.includes('--fail-validation');
const fixture = mkdtempSync(join(tmpdir(), 'agentloop-demo-'));
console.log('Deterministic fixture agent: no model, credentials or provider calls.');
console.log(`Evidence retained: ${fixture}`);
process.env.AGENTLOOP_LOG_FILE = join(fixture, 'runtime.log');
const { MissionStore, createMission, prepareMission, MissionRunner,
  resolvePolicy, AgentType, TaskStatus, MissionState } = await import('../dist/index.js');

const repository = join(fixture, 'repository');
const git = (argv, cwd = repository) => execFileSync('git', argv, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30_000
});
git(['init', '-b', 'main', repository], fixture);
git(['config', 'user.name', 'Agent Loop Demo']);
git(['config', 'user.email', 'demo@example.invalid']);
const hooks = join(fixture, 'empty-hooks');
mkdirSync(hooks);
git(['config', 'core.hooksPath', hooks]);
writeFileSync(join(repository, '.gitignore'), '.agentloop/\n');
writeFileSync(join(repository, 'README.md'), '# Disposable mission demo\n');
git(['add', '--', '.gitignore', 'README.md']);
git(['-c', 'commit.gpgSign=false', 'commit', '-m', 'test: initialize disposable demo']);

const expected = 'Verified by a real content gate.\n';
const agentPath = join(fixture, 'fixture-agent.cjs');
const verifierPath = join(fixture, 'verify.cjs');
const agentSource = `require('node:fs').writeFileSync('result.txt', ${JSON.stringify(failValidation ? 'wrong content\n' : expected)});\n`;
const verifierSource = `require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'), ${JSON.stringify(expected)});\n`;
writeFileSync(agentPath, agentSource);
writeFileSync(verifierPath, verifierSource);
const gate = [process.execPath, verifierPath];
const store = new MissionStore(repository);
const mission = createMission({
  repoPath: repository,
  agent: { name: 'deterministic-fixture', type: AgentType.CUSTOM,
    command: process.execPath, args: [agentPath] },
  policy: resolvePolicy({
    allowLocalCommit: false, allowPush: 'never', allowPullRequest: 'never', allowMerge: 'never',
    maxMissionMinutes: 2, maxAgentInvocations: 1, maxRepairPasses: 0,
    agentTimeoutMs: 10_000, approvalTimeoutMs: 5_000, allowedCommands: [gate]
  }),
  spec: { objective: 'Create result.txt with the exact demonstration bytes.',
    acceptanceCriteria: ['The independent content gate passes.'],
    nonGoals: ['Provider integration', 'Changes to the caller repository', 'Remote Git operations'] }
}, store);
await prepareMission(mission, store, { plannerTasks: [{
  id: 'write-result', title: 'Write fixture output', dependsOn: [], status: TaskStatus.PENDING
}] });
const runner = new MissionRunner(store, { extraGates: [{ name: 'exact-content', argv: gate }] });
const deadline = setTimeout(() => runner.requestCancel(), 120_000);
let result;
try { result = await runner.run(mission.id); }
finally { clearTimeout(deadline); }

console.log(`Mission: ${result.id}\nState: ${result.state}`);
console.log(`Worktree: ${result.workspace.path}\nReceipt: ${result.outcome?.receiptPath}`);
assert.equal(result.state, failValidation ? MissionState.FAILED : MissionState.COMPLETED);
assert.equal(result.usage.agentInvocations, 1);
assert.equal(readFileSync(agentPath, 'utf8'), agentSource);
assert.equal(readFileSync(verifierPath, 'utf8'), verifierSource);
const receipt = JSON.parse(readFileSync(result.outcome.receiptPath, 'utf8'));
assert.equal(receipt.receiptFormat, 'agentloop/mission-receipt');
assert.equal(receipt.mission.id, result.id);
assert.equal(receipt.mission.state, result.state);
assert.equal(receipt.usage.agentInvocations, 1);
assert.equal(receipt.passes.length, 1);
assert.equal(receipt.passes[0].agentExit, 'success');
assert.equal(receipt.passes[0].gates.length, 1);
assert.equal(receipt.passes[0].gates[0].passed, !failValidation);
assert.equal(git(['status', '--porcelain']), '', 'Original checkout changed');
for (const checkout of [repository, result.workspace.path]) {
  assert.equal(git(['rev-parse', 'HEAD'], checkout).trim(), result.repository.baseSha);
}
const changed = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], result.workspace.path)
  .split('\0').filter(Boolean).map(entry => entry.slice(3));
assert.deepEqual(changed, ['result.txt']);
assert.equal(readFileSync(join(result.workspace.path, 'result.txt'), 'utf8'),
  failValidation ? 'wrong content\n' : expected);
console.log('Original checkout unchanged; worktree content and persisted receipt verified.');
console.log(failValidation
  ? 'Expected rejection: a clean agent exit cannot override a failing content gate.'
  : 'Demo passed. This verifies the runtime fixture, not any vendor CLI.');
process.exitCode = failValidation ? 1 : 0;
