import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { MissionStore } from '../mission/mission-store.js';
import { createMission, prepareMission } from '../engine/mission-factory.js';
import { MissionRunner } from '../engine/mission-runner.js';
import { recoverMission } from '../engine/recovery.js';
import { loadPolicy } from '../policy/policy.js';
import { loadApprovals, decideApproval, grantedScopePaths } from '../policy/approvals.js';
import { MissionState, AgentType, TaskStatus } from '../types.js';
import type { MissionSpec, AgentConfig, TaskNode, Policy } from '../types.js';

/**
 * Scope-expansion e2e: a mission whose work exceeds the approved envelope
 * (the diff touches out-of-scope/protected paths, or the planner declares
 * paths/commands beyond scope+policy) must pause on a persisted human
 * approval covering the EXACT expansion — never widen silently.
 *   approve → granted paths are legitimate scope on re-review → completes
 *   deny    → blocked, envelope unchanged, a re-drive re-gates
 *   timeout → blocked, the request stays pending (a timeout is not a decision)
 *
 * Provider-free: the agent is a node script writing fixture files.
 */

let gitOk = true;
try { execFileSync('git', ['--version'], { stdio: 'pipe' }); } catch { gitOk = false; }
const describeGit = gitOk ? describe : describe.skip;

const NODE = process.execPath;

let fixtureDir: string;
let repo: string;
let store: MissionStore;
let fakeAgentJs: string;
let launches: string;

const agent: AgentConfig = { name: 'fake', type: AgentType.CUSTOM, command: NODE, args: [] };
const scopedSpec: MissionSpec = {
  objective: 'Work inside allowed/', acceptanceCriteria: ['work done'],
  scope: ['allowed/']
};
const task: TaskNode = { id: 't-1', title: 'do work', dependsOn: [], status: TaskStatus.PENDING };

/**
 * Fake agent: in planning mode it emits `planJson`; in execute mode it runs
 * `execJs` in the worktree. Every launch is recorded so tests can assert the
 * exact invocation sequence.
 */
function initRepo(opts: { execJs: string; planJson?: string }) {
  fixtureDir = mkdtempSync(join(tmpdir(), 'alr-scopex-'));
  repo = join(fixtureDir, 'repo');
  const hooks = join(fixtureDir, 'hooks');
  mkdirSync(repo); mkdirSync(hooks);
  // Git spawns on this class of host have exceeded 30s under load — bound the
  // fixture setup generously so a slow fork never masquerades as a logic failure.
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', timeout: 120_000 });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 't@t.dev']);
  git(['config', 'user.name', 'T']);
  git(['config', 'core.hooksPath', hooks]);
  mkdirSync(join(repo, 'allowed'));
  writeFileSync(join(repo, 'allowed', 'seed.txt'), 'seed\n');
  git(['add', '.']); git(['-c', 'commit.gpgSign=false', 'commit', '-qm', 'init']);
  store = new MissionStore(repo);
  launches = join(fixtureDir, 'launches.jsonl');
  fakeAgentJs = join(fixtureDir, 'fake-agent.cjs');
  writeFileSync(fakeAgentJs, `
const fs = require('node:fs');
const planning = process.argv.slice(2).some(a => a.startsWith('You are a planning component'));
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify(planning ? 'plan' : 'execute') + '\\n');
if (planning) console.log(${JSON.stringify(opts.planJson ?? '[{"title":"do work","dependsOn":[]}]')});
else { ${opts.execJs} }
`);
}

afterEach(() => { if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true }); });

function calls(): string[] {
  return existsSync(launches)
    ? readFileSync(launches, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    : [];
}

function mkMission(policyOverride: Partial<Policy> = {}, spec: MissionSpec = scopedSpec, planning = false) {
  return createMission({
    repoPath: repo, spec,
    agent: { ...agent, args: [fakeAgentJs, '{objective}'] },
    policy: { ...loadPolicy(repo).policy, ...policyOverride },
    planning,
    workspaceMode: 'worktree'
  }, store);
}

// Git worktree ops + spawned agents on slow/Windows hosts have been observed
// exceeding 300s per mission leg — keep the ceiling generous so timing noise
// never masquerades as a logic failure.
async function waitFor(cond: () => boolean, timeoutMs = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline');
    await new Promise(r => setTimeout(r, 50));
  }
}

function pendingApproval(missionId: string) {
  const p = loadApprovals(store.dir(missionId)).filter(a => a.status === 'pending');
  assert.equal(p.length, 1, 'exactly one pending gate expected');
  return p[0];
}

describeGit('scope-expansion — diff exceeds approved scope', () => {
  test('approved expansion covers exactly the listed paths → mission completes', async () => {
    initRepo({ execJs: `
fs.mkdirSync('extra', { recursive: true });
fs.writeFileSync('allowed/ok.txt', 'in scope');
fs.writeFileSync('extra/expanded.txt', 'beyond envelope');
` });
    const mission = mkMission();
    await prepareMission(mission, store, { plannerTasks: [task] });

    const runner = new MissionRunner(store);
    const running = runner.run(mission.id);
    try {
      await waitFor(() => store.mustLoad(mission.id).state === MissionState.WAITING_FOR_APPROVAL);
      const req = pendingApproval(mission.id);
      const fresh = store.mustLoad(mission.id);
      assert.equal(req.gate, 'scope-expansion');
      assert.deepEqual(req.paths, ['extra/expanded.txt'], 'gate bound to the exact violating path');
      assert.match(req.detail, /out-of-scope/);
      assert.equal(req.policyHash, fresh.policyHash);
      assert.equal(req.worktree, fresh.workspace.path);

      decideApproval(store.dir(mission.id), mission.id, req.id, 'approved', 'operator');
      const final = await running;
      assert.equal(final.state, MissionState.COMPLETED);
      assert.equal(final.outcome?.result, 'completed');

      // The grant is the persisted decision itself — bound, exact, auditable.
      const grants = grantedScopePaths(loadApprovals(store.dir(mission.id)),
        { policyHash: final.policyHash, worktree: final.workspace.path });
      assert.deepEqual(grants, ['extra/expanded.txt']);
      const events = store.events(mission.id);
      assert.ok(events.some(e => e.type === 'approval_required' && e.data?.gate === 'scope-expansion'));
      assert.ok(events.some(e => e.type === 'approval_decided' && e.data?.status === 'approved'));
      const receipt = JSON.parse(readFileSync(join(store.dir(mission.id), 'receipt.json'), 'utf8'));
      assert.deepEqual(receipt.approvals[0].paths, ['extra/expanded.txt']);
      assert.equal(receipt.approvals[0].status, 'approved');
    } finally {
      runner.requestCancel();
      await running.catch(() => undefined);
    }
  });

  test('denied expansion → blocked, envelope unchanged, and re-drive re-gates', async () => {
    initRepo({ execJs: `fs.writeFileSync('outside.txt', 'beyond envelope');` });
    const mission = mkMission();
    await prepareMission(mission, store, { plannerTasks: [task] });

    const runner = new MissionRunner(store);
    const running = runner.run(mission.id);
    try {
      await waitFor(() => store.mustLoad(mission.id).state === MissionState.WAITING_FOR_APPROVAL);
      const req = pendingApproval(mission.id);
      decideApproval(store.dir(mission.id), mission.id, req.id, 'denied', 'operator');

      const final = await running;
      assert.equal(final.state, MissionState.BLOCKED);
      assert.match(final.stateHistory.at(-1)?.reason ?? '', /approval denied/);
      // Fail closed: spec.scope untouched, nothing granted.
      assert.deepEqual(final.spec.scope, ['allowed/']);
      assert.equal(grantedScopePaths(loadApprovals(store.dir(mission.id)),
        { policyHash: final.policyHash, worktree: final.workspace.path }).length, 0);
      assert.ok(store.events(mission.id).some(e =>
        e.type === 'mission_blocked' && e.data?.gate === 'scope-expansion'));
    } finally {
      runner.requestCancel();
      await running.catch(() => undefined);
    }

    // A denied expansion never sticks: recovering and re-driving the mission
    // hits the same uncovered violation and raises a FRESH pending request.
    await recoverMission(store, mission.id);
    const runner2 = new MissionRunner(store);
    const rerun = runner2.run(mission.id);
    try {
      await waitFor(() => store.mustLoad(mission.id).state === MissionState.WAITING_FOR_APPROVAL);
      const req2 = pendingApproval(mission.id);
      assert.equal(req2.gate, 'scope-expansion');
      assert.deepEqual(req2.paths, ['outside.txt']);
      assert.notEqual(req2.id, loadApprovals(store.dir(mission.id))[0].id,
        'the denied decision is not resurrected — a fresh approval is required');
      const ledger = loadApprovals(store.dir(mission.id));
      assert.equal(ledger.filter(a => a.status === 'denied').length, 1);
      assert.equal(ledger.filter(a => a.status === 'pending').length, 1);
    } finally {
      runner2.requestCancel();
      const r = await rerun;
      assert.equal(r.state, MissionState.CANCELLED);
    }
  });

  test('unanswered expansion request → approval timeout blocks fail-closed', async () => {
    initRepo({ execJs: `fs.writeFileSync('outside.txt', 'beyond envelope');` });
    const mission = mkMission({ approvalTimeoutMs: 0 });
    await prepareMission(mission, store, { plannerTasks: [task] });

    const final = await new MissionRunner(store).run(mission.id);
    assert.equal(final.state, MissionState.BLOCKED);
    assert.match(final.stateHistory.at(-1)?.reason ?? '', /approval timed out/);
    const ledger = loadApprovals(store.dir(mission.id));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].status, 'pending');
    assert.deepEqual(ledger[0].paths, ['outside.txt']);
    assert.ok(store.events(mission.id).some(e =>
      e.type === 'mission_blocked' && e.data?.reason === 'approval timeout'));
    assert.deepEqual(final.spec.scope, ['allowed/'], 'envelope unchanged — a timeout never widens it');
  });

  test('protected-path modification is gated the same way; approval is on record', async () => {
    // '.agentloop/**' is a default protected path. An operator approval is the
    // recorded override: granted paths are excluded from further violations.
    initRepo({ execJs: `
fs.mkdirSync('.agentloop', { recursive: true });
fs.writeFileSync('.agentloop/tamper.txt', 'agent touched runtime state');
fs.writeFileSync('allowed/ok.txt', 'in scope');
` });
    const mission = mkMission();
    await prepareMission(mission, store, { plannerTasks: [task] });

    const runner = new MissionRunner(store);
    const running = runner.run(mission.id);
    try {
      await waitFor(() => store.mustLoad(mission.id).state === MissionState.WAITING_FOR_APPROVAL);
      const req = pendingApproval(mission.id);
      assert.equal(req.gate, 'scope-expansion');
      assert.deepEqual(req.paths, ['.agentloop/tamper.txt']);
      assert.match(req.detail, /protected paths modified/);

      decideApproval(store.dir(mission.id), mission.id, req.id, 'approved', 'operator');
      const final = await running;
      assert.equal(final.state, MissionState.COMPLETED);
      const decided = loadApprovals(store.dir(mission.id))[0];
      assert.equal(decided.status, 'approved');
      assert.deepEqual(decided.paths, ['.agentloop/tamper.txt']);
    } finally {
      runner.requestCancel();
      await running.catch(() => undefined);
    }
  });
});

describeGit('scope-expansion — plan-declared requests', () => {
  test('plan requesting out-of-envelope paths/commands gates BEFORE any execution', async () => {
    initRepo({
      planJson: JSON.stringify([{
        title: 'work beyond scope', dependsOn: [],
        paths: ['extra/'], commands: [[NODE, '-e', 'process.exit(0)']]
      }]),
      execJs: `
fs.mkdirSync('extra', { recursive: true });
fs.writeFileSync('extra/expanded.txt', 'declared + approved');
`
    });
    const mission = mkMission({}, scopedSpec, true);
    await prepareMission(mission, store);

    const runner = new MissionRunner(store);
    const running = runner.run(mission.id);
    try {
      await waitFor(() => store.mustLoad(mission.id).state === MissionState.WAITING_FOR_APPROVAL);
      // Only the planner ran — execution is held until a human decides.
      assert.deepEqual(calls(), ['plan']);
      assert.equal(store.mustLoad(mission.id).usage.agentInvocations, 1);

      const req = pendingApproval(mission.id);
      assert.equal(req.gate, 'scope-expansion');
      assert.deepEqual(req.paths, ['extra/']);
      assert.deepEqual(req.commands, [[NODE, '-e', 'process.exit(0)']]);

      decideApproval(store.dir(mission.id), mission.id, req.id, 'approved', 'operator');
      const final = await running;
      assert.equal(final.state, MissionState.COMPLETED);
      assert.deepEqual(calls(), ['plan', 'execute']);
      // The granted path covered the actual diff — review approved.
      assert.equal(final.passes.at(-1)?.review?.verdict, 'approve');
      assert.equal(final.planning?.source, 'agent');
    } finally {
      runner.requestCancel();
      await running.catch(() => undefined);
    }
  });

  test('denied plan expansion → blocked before any implementation invocation', async () => {
    initRepo({
      planJson: JSON.stringify([{ title: 'reach beyond', dependsOn: [], paths: ['elsewhere/'] }]),
      execJs: `fs.writeFileSync('elsewhere/x.txt', 'never reached');`
    });
    const mission = mkMission({}, scopedSpec, true);
    await prepareMission(mission, store);

    const runner = new MissionRunner(store);
    const running = runner.run(mission.id);
    try {
      await waitFor(() => store.mustLoad(mission.id).state === MissionState.WAITING_FOR_APPROVAL);
      const req = pendingApproval(mission.id);
      assert.deepEqual(req.paths, ['elsewhere/']);
      decideApproval(store.dir(mission.id), mission.id, req.id, 'denied', 'operator');

      const final = await running;
      assert.equal(final.state, MissionState.BLOCKED);
      // Fail closed: the denied plan never produced an implementation attempt.
      assert.deepEqual(calls(), ['plan']);
      assert.equal(final.usage.agentInvocations, 1);
      assert.equal(existsSync(join(final.workspace.path, 'elsewhere', 'x.txt')), false);
    } finally {
      runner.requestCancel();
      await running.catch(() => undefined);
    }
  });

  test('in-envelope plan requests proceed without any gate', async () => {
    initRepo({
      planJson: JSON.stringify([{ title: 'inside scope', dependsOn: [], paths: ['allowed/'] }]),
      execJs: `fs.writeFileSync('allowed/ok.txt', 'in scope');`
    });
    const mission = mkMission({}, scopedSpec, true);
    await prepareMission(mission, store);

    const final = await new MissionRunner(store).run(mission.id);
    assert.equal(final.state, MissionState.COMPLETED);
    assert.deepEqual(calls(), ['plan', 'execute']);
    assert.equal(loadApprovals(store.dir(mission.id)).length, 0, 'no approval was needed');
  });
});
