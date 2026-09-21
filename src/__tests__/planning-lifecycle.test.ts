import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMission, prepareMission } from '../engine/mission-factory.js';
import { MissionStore } from '../mission/mission-store.js';
import { MissionRunner } from '../engine/mission-runner.js';
import { MissionScheduler } from '../engine/scheduler.js';
import { recoverMission, reapIfOurs } from '../engine/recovery.js';
import { defaultPlan, planningTimeoutMs } from '../engine/planner.js';
import { resolvePolicy } from '../policy/policy.js';
import { AgentType, MissionState } from '../types.js';

async function fixture(cap = 2, opts: { unprepared?: boolean; unborn?: boolean; successfulPlanner?: boolean; noPlanning?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'alr-plan-lifecycle-'));
  const repo = join(dir, 'repo');
  const hooks = join(dir, 'hooks');
  mkdirSync(repo); mkdirSync(hooks);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', timeout: 30_000 });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.hooksPath', hooks]);
  writeFileSync(join(repo, '.gitignore'), '.agentloop/\n');
  git(['add', '--', '.gitignore']);
  if (!opts.unborn) git(['-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture']);
  const launches = join(dir, 'launches.jsonl');
  const agent = join(dir, 'agent.cjs');
  writeFileSync(agent, `
const fs = require('node:fs');
const planning = process.argv.slice(2).some(arg => arg.startsWith('You are a planning component'));
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify(planning ? 'plan' : 'execute') + '\\n');
if (planning) {
  if (${opts.successfulPlanner === true}) console.log(JSON.stringify([{ title: 'Write result', dependsOn: [] }]));
  else setInterval(() => {}, 1000);
}
else fs.writeFileSync('result.txt', 'verified');
`);
  const verifier = join(dir, 'verify.cjs');
  writeFileSync(verifier, "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'verified');");
  const gate = [process.execPath, verifier];
  const store = new MissionStore(repo);
  const mission = createMission({
    repoPath: repo, planning: !opts.unprepared && !opts.noPlanning,
    spec: { objective: 'write result.txt', acceptanceCriteria: ['exact content'] },
    agent: { name: 'fixture', type: AgentType.CUSTOM, command: process.execPath, args: [agent] },
    policy: resolvePolicy({ allowLocalCommit: false, allowedCommands: [gate],
      maxAgentInvocations: cap, maxRepairPasses: 0, maxMissionMinutes: 2, agentTimeoutMs: 30_000 })
  }, store);
  if (!opts.unprepared) await prepareMission(mission, store, { plannerTasks: opts.noPlanning ? defaultPlan() : undefined });
  const calls = () => existsSync(launches)
    ? readFileSync(launches, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { dir, repo, store, mission, gate, calls };
}

test('legacy preplanned mission without planning metadata runs only its worker', async () => {
  const f = await fixture(1, { noPlanning: true });
  assert.equal(f.store.mustLoad(f.mission.id).planning, undefined);
  const result = await new MissionRunner(f.store, { extraGates: [{ name: 'content', argv: f.gate }] }).run(f.mission.id);
  assert.equal(result.state, MissionState.COMPLETED);
  assert.equal(result.planning, undefined);
  assert.equal(result.usage.agentInvocations, 1);
  assert.deepEqual(f.calls(), ['execute']);
  assert.equal(result.passes[0].kind, 'execute');
  assert.equal(result.passes[0].gates?.[0].passed, true);
});

for (const unborn of [false, true]) {
  test(`scheduler ${unborn ? 'preflight rejection launches zero agents' : 'planner consumes the shared cap'}`, async () => {
    const f = await fixture(1, { unprepared: true, unborn, successfulPlanner: true });
    const scheduler = new MissionScheduler({ extraGates: [{ name: 'content', argv: f.gate }] });
    scheduler.registerRepo(f.repo, f.store, f.mission.policy);
    try {
      scheduler.enqueue(f.repo, f.mission.id);
      await until(() => f.store.mustLoad(f.mission.id).state === MissionState.FAILED);
      const result = f.store.mustLoad(f.mission.id);
      assert.deepEqual(f.calls(), unborn ? [] : ['plan']);
      assert.equal(result.usage.agentInvocations, unborn ? 0 : 1);
      if (!unborn) {
        assert.equal(result.passes[0].kind, 'plan');
        assert.equal(result.planning?.source, 'agent');
        assert.notEqual(result.workspace.path, f.repo);
      }
    } finally { await scheduler.stop(); }
  });
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'planner did not reach the expected persisted boundary');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('expired cumulative mission wall budget never spawns planning', async () => {
  const f = await fixture();
  f.store.mutate(f.mission.id, m => { m.usage.startedAt = new Date(Date.now() - 180_000).toISOString(); });
  const result = await new MissionRunner(f.store).run(f.mission.id);
  assert.equal(result.state, MissionState.FAILED);
  assert.equal(result.usage.agentInvocations, 0);
  assert.deepEqual(f.calls(), []);
});

test('planning timeout is bounded by remaining cumulative wall budget', async () => {
  const f = await fixture();
  f.store.mutate(f.mission.id, m => {
    m.budget.maxMissionMinutes = 0.02;
    m.usage.startedAt = new Date().toISOString();
  });
  const result = await new MissionRunner(f.store).run(f.mission.id);
  assert.equal(result.state, MissionState.FAILED);
  // Slow pre-spawn I/O can exhaust the deadline before admission. That is a
  // correct zero-launch outcome, not a reason to increase the runtime budget.
  assert.ok(result.usage.agentInvocations <= 1);
  assert.ok(f.calls().every(call => call === 'plan'));
  assert.ok(f.calls().length <= 1);
  for (const pass of result.passes) assert.equal(pass.agentExit, 'timeout');
});

test('planner timeout selection deterministically honors configured and remaining limits', () => {
  const mission = {
    budget: { maxMissionMinutes: 10, agentTimeoutMs: 300_000 },
    usage: { startedAt: new Date(0).toISOString() }
  } as Parameters<typeof planningTimeoutMs>[0];
  assert.equal(planningTimeoutMs(mission, 0), 120_000);
  mission.budget.agentTimeoutMs = 4000;
  assert.equal(planningTimeoutMs(mission, 0), 4000);
  assert.equal(planningTimeoutMs(mission, 599_500), 500);
  assert.equal(planningTimeoutMs(mission, 600_000), 0);
  assert.equal(planningTimeoutMs(mission, 600_001), 0);
});

test('cancelled planner records its debit, pid and cancellation without implementation', async () => {
  const f = await fixture();
  const runner = new MissionRunner(f.store);
  const running = runner.run(f.mission.id);
  await until(() => !!f.store.mustLoad(f.mission.id).passes[0]?.agentPid && f.calls().length === 1);
  const inFlight = f.store.mustLoad(f.mission.id);
  assert.equal(inFlight.usage.agentInvocations, 1);
  assert.equal(inFlight.passes[0].intent?.kind, 'plan');
  runner.requestCancel();
  const result = await running;
  assert.equal(result.state, MissionState.CANCELLED);
  assert.equal(result.planning?.status, 'cancelled');
  assert.equal(result.passes[0].agentExit, 'cancelled');
  assert.ok(result.passes[0].finishedAt);
  assert.deepEqual(f.calls(), ['plan']);
});

for (const cap of [1, 2]) {
  test(`paused planner resumes without a repeat attempt at cap ${cap}`, async () => {
    const f = await fixture(cap);
    const runner = new MissionRunner(f.store, { extraGates: [{ name: 'content', argv: f.gate }] });
    const running = runner.run(f.mission.id);
    await until(() => !!f.store.mustLoad(f.mission.id).passes[0]?.agentPid && f.calls().length === 1);
    runner.requestPause();
    const paused = await running;
    assert.equal(paused.state, MissionState.PAUSED);
    assert.equal(paused.usage.agentInvocations, 1);
    assert.equal(paused.passes[0].interrupted, true);
    assert.equal(paused.planning?.source, 'fallback');
    await recoverMission(f.store, f.mission.id);
    const result = await new MissionRunner(f.store, { extraGates: [{ name: 'content', argv: f.gate }] }).run(f.mission.id);
    assert.equal(result.state, cap === 1 ? MissionState.FAILED : MissionState.COMPLETED);
    assert.deepEqual(f.calls(), cap === 1 ? ['plan'] : ['plan', 'execute']);
    assert.equal(result.usage.agentInvocations, cap);
    if (cap === 2) assert.equal(result.passes[1].gates?.[0].passed, true);
  });
}

test('runner killed during planning preserves unknown outcome and never replans on recovery', async () => {
  const f = await fixture(1);
  const childScript = join(f.dir, 'runner.mjs');
  writeFileSync(childScript, `
import { MissionRunner } from ${JSON.stringify(new URL('../engine/mission-runner.ts', import.meta.url).href)};
import { MissionStore } from ${JSON.stringify(new URL('../mission/mission-store.ts', import.meta.url).href)};
await new MissionRunner(new MissionStore(${JSON.stringify(f.repo)})).run(${JSON.stringify(f.mission.id)});
`);
  const child = spawn(process.execPath, ['--import', 'tsx', childScript], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'ignore', windowsHide: true,
    env: { ...process.env, AGENTLOOP_LOG_FILE: join(f.dir, 'child.log') }
  });
  const exited = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject); });
  try {
    await until(() => !!f.store.mustLoad(f.mission.id).passes[0]?.agentPid && f.calls().length === 1);
    child.kill('SIGKILL');
    await exited;
    const recovered = await recoverMission(f.store, f.mission.id);
    assert.equal(recovered.usage.agentInvocations, 1);
    assert.equal(recovered.passes[0].interrupted, true);
    assert.equal(recovered.passes[0].agentExit, undefined, 'unknown outcome is not a success or a known cancellation');
    assert.ok(recovered.lastRecovery?.interruptedPasses.includes(1));
    assert.equal(recovered.planning?.source, 'fallback');
    const result = await new MissionRunner(f.store).run(f.mission.id);
    assert.equal(result.state, MissionState.FAILED);
    assert.deepEqual(f.calls(), ['plan']);
    assert.equal(result.usage.agentInvocations, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    const pass = f.store.mustLoad(f.mission.id).passes[0];
    if (pass?.agentPid) reapIfOurs(pass.agentPid, Date.parse(pass.startedAt));
  }
});
