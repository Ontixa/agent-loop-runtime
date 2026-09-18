import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { MissionStore } from '../mission/mission-store.js';
import { createMission, prepareMission } from '../engine/mission-factory.js';
import { MissionRunner } from '../engine/mission-runner.js';
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
