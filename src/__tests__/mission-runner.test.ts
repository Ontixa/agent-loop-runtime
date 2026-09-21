import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { MissionStore } from '../mission/mission-store.js';
import { createMission, prepareMission } from '../engine/mission-factory.js';
import { MissionRunner } from '../engine/mission-runner.js';
import { loadPolicy } from '../policy/policy.js';
import { MissionState, AgentType, TaskStatus } from '../types.js';
import type { MissionSpec, AgentConfig, TaskNode } from '../types.js';

/**
 * Mission-runner safety tests: a mission must never complete without real
 * work and real validation. Uses a real temp git repo + node fake agents.
 */

let gitOk = true;
try { execFileSync('git', ['--version'], { stdio: 'pipe' }); } catch { gitOk = false; }
const describeGit = gitOk ? describe : describe.skip;

let repo: string;
let store: MissionStore;
let fakeAgentJs: string;

const NODE = process.execPath;

const spec: MissionSpec = { objective: 'Make hello.txt', acceptanceCriteria: ['check passes'] };
const agent: AgentConfig = {
  name: 'fake', type: AgentType.CUSTOM,
  command: NODE, args: [] // set per-test
};

function initRepo() {
  repo = mkdtempSync(join(tmpdir(), 'alr-run-'));
  const g = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 't@t.dev']);
  g(['config', 'user.name', 'T']);
  writeFileSync(join(repo, 'app.txt'), 'x\n');
  g(['add', '.']); g(['commit', '-qm', 'init']);
  store = new MissionStore(repo);
}

beforeEach(() => {
  if (!gitOk) return;
  initRepo();
  fakeAgentJs = join(repo, 'fake-agent.cjs');
  writeFileSync(fakeAgentJs, `
const fs=require('fs');
const args=process.argv.slice(2);
const mode=(args.find(a=>a.startsWith('--mode='))||'--mode=success').slice(7);
if(mode==='fail'){console.error('boom');process.exit(7);}
if(mode==='work'){fs.writeFileSync('hello.txt','made by agent');console.log('made it');}
else console.log('noop');
`);
});
afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

function mkMission(extra: Partial<Parameters<typeof createMission>[0]> = {}) {
  return createMission({
    repoPath: repo, spec, agent: { ...agent, args: [fakeAgentJs, '{objective}'] },
    workspaceMode: 'worktree', ...extra
  }, store);
}

describeGit('false-completion guards', () => {
  test('empty task graph → FAILED, never completed', async () => {
    const m = mkMission();
    await prepareMission(m, store); // no plannerTasks → tasks = []
    const runner = new MissionRunner(store, {});
    const result = await runner.run(m.id);
    assert.equal(result.state, MissionState.FAILED);
    assert.ok(result.outcome?.summary.includes('no executable tasks') ||
              result.outcome?.summary.includes('Planner produced no'));
    assert.notEqual(result.state, MissionState.COMPLETED);
  });

  test('mission with tasks actually invokes the agent', async () => {
    const tasks: TaskNode[] = [{
      id: 't-1', title: 'create hello.txt', dependsOn: [], status: TaskStatus.PENDING
    }];
    const m = mkMission({
      agent: { ...agent, args: [fakeAgentJs, '--mode=work', '{objective}'] }
    });
    await prepareMission(m, store, { plannerTasks: tasks });
    const runner = new MissionRunner(store, {});
    const result = await runner.run(m.id);
    assert.ok(result.usage.agentInvocations >= 1, 'agent must have been invoked');
    assert.ok(result.passes.length >= 1);
    // agent's write landed in the worktree
    assert.ok(existsSync(join(result.workspace.path, 'hello.txt')));
  });

  test('failing agent does not falsely complete the mission', async () => {
    const tasks: TaskNode[] = [{
      id: 't-1', title: 'do work', dependsOn: [], status: TaskStatus.PENDING
    }];
    const m = mkMission({
      agent: { ...agent, args: [fakeAgentJs, '--mode=fail', '{objective}'] }
    });
    await prepareMission(m, store, { plannerTasks: tasks });
    const runner = new MissionRunner(store, {});
    const result = await runner.run(m.id);
    // Agent failed → validation has no passing work → mission must not complete
    assert.notEqual(result.state, MissionState.COMPLETED);
  });
});

describeGit('invocation budget admission', () => {
  function task(id: string): TaskNode {
    return { id, title: 'create hello.txt', dependsOn: [], status: TaskStatus.PENDING };
  }

  function budgetMission(gate: string[]) {
    const policy = loadPolicy(repo).policy;
    return mkMission({
      agent: { ...agent, args: [fakeAgentJs, '--mode=work', '{objective}'] },
      budget: { maxAgentInvocations: 1, maxRepairPasses: 1 },
      policy: { ...policy, allowedCommands: [...policy.allowedCommands, gate] }
    });
  }

  test('last allowed invocation still validates and completes', async () => {
    const gate = [NODE, '-e', 'if(require("fs").readFileSync("hello.txt","utf8")!=="made by agent")process.exit(1)'];
    const mission = budgetMission(gate);
    await prepareMission(mission, store, { plannerTasks: [task('t-1')] });
    const result = await new MissionRunner(store, {
      extraGates: [{ name: 'actual-output', argv: gate }]
    }).run(mission.id);
    assert.equal(result.state, MissionState.COMPLETED);
    assert.equal(result.usage.agentInvocations, 1);
    assert.equal(result.passes.length, 1);
    assert.equal(result.passes[0].gates?.[0].passed, true);
    assert.equal(result.outcome?.result, 'completed');
  });

  test('a second ready task cannot exceed the invocation limit', async () => {
    const mission = budgetMission([NODE, '-e', 'process.exit(0)']);
    await prepareMission(mission, store, { plannerTasks: [task('t-1'), task('t-2')] });
    const result = await new MissionRunner(store).run(mission.id);
    assert.equal(result.state, MissionState.FAILED);
    assert.equal(result.usage.agentInvocations, 1);
    assert.equal(result.passes.length, 1);
    assert.equal(result.tasks[1].status, TaskStatus.PENDING);
    assert.match(result.outcome?.summary ?? '', /budget exceeded: 1 agent invocations/);
  });

  test('a failed final validation cannot start an over-budget repair', async () => {
    const gate = [NODE, '-e', 'process.exit(1)'];
    const mission = budgetMission(gate);
    await prepareMission(mission, store, { plannerTasks: [task('t-1')] });
    const result = await new MissionRunner(store, {
      extraGates: [{ name: 'failing-check', argv: gate }]
    }).run(mission.id);
    assert.equal(result.state, MissionState.FAILED);
    assert.equal(result.usage.agentInvocations, 1);
    assert.equal(result.usage.repairPasses, 0);
    assert.equal(result.passes.length, 1);
    assert.equal(result.passes[0].gates?.[0].passed, false);
    assert.match(result.outcome?.summary ?? '', /budget exceeded: 1 agent invocations/);
  });
});

describeGit('repair task outcome honesty', () => {
  async function prepareRepair(mode: 'fail' | 'hang', agentTimeoutMs = 5000) {
    writeFileSync(fakeAgentJs, `
const fs = require('fs');
if (!process.argv.at(-1).includes('previous pass did not satisfy')) process.exit(0);
fs.writeFileSync('hello.txt', 'made by repair');
if (process.argv[2] === 'fail') { console.error('repair failed after write'); process.exit(7); }
setInterval(() => {}, 1000);
`);
    const gate = [NODE, '-e', 'if(require("fs").readFileSync("hello.txt","utf8")!=="made by repair")process.exit(1)'];
    const policy = loadPolicy(repo).policy;
    const mission = mkMission({
      agent: { ...agent, args: [fakeAgentJs, mode, '{objective}'] },
      budget: { maxAgentInvocations: 2, maxRepairPasses: 1, agentTimeoutMs },
      policy: { ...policy, allowedCommands: [...policy.allowedCommands, gate] }
    });
    await prepareMission(mission, store, { plannerTasks: [{
      id: 'initial', title: 'make hello.txt', dependsOn: [], status: TaskStatus.PENDING
    }] });
    const runner = new MissionRunner(store, { extraGates: [{ name: 'repair-output', argv: gate }] });
    return { mission, runner };
  }

  for (const [mode, exitKind] of [['fail', 'failed'], ['hang', 'timeout']] as const) {
    test(`${exitKind} repair stays failed even when subsequent validation passes`, async () => {
      const { mission, runner } = await prepareRepair(mode, 1000);
      const result = await runner.run(mission.id);
      const repairTask = result.tasks.find(task => task.id.startsWith('repair_'));
      assert.equal(result.state, MissionState.COMPLETED, 'real validation judges the resulting work');
      assert.equal(result.passes[0].gates?.[0].passed, false);
      assert.equal(result.passes[1].gates?.[0].passed, true);
      assert.equal(result.passes[1].agentExit, exitKind);
      assert.equal(repairTask?.status, TaskStatus.FAILED);
      assert.equal(repairTask?.result, exitKind);
      assert.ok(repairTask?.completedAt);
      assert.equal(result.usage.agentInvocations, 2);
    });
  }

  test('cancelling a repair leaves no running task in the terminal mission', async () => {
    const { mission, runner } = await prepareRepair('hang');
    const cancelWhenSpawned = setInterval(() => {
      const pass = store.mustLoad(mission.id).passes.at(-1);
      if (pass?.kind === 'repair' && pass.agentPid) runner.requestCancel();
    }, 20);
    try {
      const result = await runner.run(mission.id);
      const repairTask = result.tasks.find(task => task.id.startsWith('repair_'));
      assert.equal(result.state, MissionState.CANCELLED);
      assert.equal(repairTask?.status, TaskStatus.CANCELLED);
      assert.equal(repairTask?.result, 'cancelled');
      assert.ok(repairTask?.completedAt);
      assert.equal(result.passes.at(-1)?.agentExit, 'cancelled');
      assert.equal(result.tasks.some(task => task.status === TaskStatus.RUNNING), false);
      assert.equal(result.passes[0].gates?.[0].passed, false);
    } finally {
      clearInterval(cancelWhenSpawned);
    }
  });
});
