import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { MissionStore } from '../mission/mission-store.js';
import { createMission, prepareMission } from '../engine/mission-factory.js';
import { MissionRunner } from '../engine/mission-runner.js';
import { ControlApi } from '../daemon/control-api.js';
import { MissionScheduler } from '../engine/scheduler.js';
import { loadPolicy } from '../policy/policy.js';
import { loadApprovals } from '../policy/approvals.js';
import { MissionState, AgentType, TaskStatus } from '../types.js';
import type { MissionSpec, AgentConfig, TaskNode, Policy } from '../types.js';

/**
 * Approval-gate e2e: a real mission driven by the runner reaches
 * waiting_for_approval on an unapproved validation gate, then
 *   (a) the operator DENIES through the control API → blocked with denial
 *       evidence, the gated command never executes;
 *   (b) nobody answers inside policy.approvalTimeoutMs → blocked with timeout
 *       evidence — a timeout is never recorded as a decision.
 *
 * Provider-free: the agent is a node script; the gated command is a sentinel
 * write — if it ever ran, `gate-ran.txt` would exist in the worktree.
 */

let gitOk = true;
try { execFileSync('git', ['--version'], { stdio: 'pipe' }); } catch { gitOk = false; }
const describeGit = gitOk ? describe : describe.skip;

const NODE = process.execPath;
const SENTINEL = 'gate-ran.txt';
// Unapproved argv: not in allowedCommands, matches no refused class →
// classifyCommand fails closed to 'needs-approval'.
const GATED_GATE = {
  name: 'sentinel-gate',
  argv: [NODE, '-e', `require('fs').writeFileSync('${SENTINEL}','1')`]
};

let repo: string;
let store: MissionStore;
let fakeAgentJs: string;

const spec: MissionSpec = { objective: 'Make hello.txt', acceptanceCriteria: ['check passes'] };
const agent: AgentConfig = { name: 'fake', type: AgentType.CUSTOM, command: NODE, args: [] };
const task: TaskNode = { id: 't-1', title: 'create hello.txt', dependsOn: [], status: TaskStatus.PENDING };

function initRepo() {
  repo = mkdtempSync(join(tmpdir(), 'alr-apgate-'));
  const g = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 't@t.dev']);
  g(['config', 'user.name', 'T']);
  writeFileSync(join(repo, 'app.txt'), 'x\n');
  g(['add', '.']); g(['commit', '-qm', 'init']);
  store = new MissionStore(repo);
  fakeAgentJs = join(repo, 'fake-agent.cjs');
  writeFileSync(fakeAgentJs, `
const fs=require('fs');
fs.writeFileSync('hello.txt','made by agent');
console.log('made it');
`);
}

beforeEach(() => { if (gitOk) initRepo(); });
afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

function mkMission(policyOverride: Partial<Policy> = {}) {
  return createMission({
    repoPath: repo, spec,
    agent: { ...agent, args: [fakeAgentJs, '{objective}'] },
    policy: { ...loadPolicy(repo).policy, ...policyOverride },
    workspaceMode: 'worktree'
  }, store);
}

// Execute→validate on a real worktree involves git ops + a spawned agent —
// on slow/Windows hosts this has been observed taking >100s, so the approval
// wait needs a generous ceiling rather than a tight timing assumption.
async function waitFor(cond: () => boolean, timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline');
    await new Promise(r => setTimeout(r, 50));
  }
}

function apiReq(api: ControlApi, method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const r = request(`${api.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }
    }, res => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.once('end', () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : {} }));
      res.once('error', reject);
    });
    r.setTimeout(10_000, () => r.destroy(new Error('fixture request timed out')));
    r.once('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

describeGit('approval gates — operator decisions e2e', () => {
  test('denied via control API → blocked, denial evidence, gated command never ran', async () => {
    const mission = mkMission();
    await prepareMission(mission, store, { plannerTasks: [task] });

    const api = new ControlApi({
      host: '127.0.0.1', port: 0, token: `fixture_${randomBytes(24).toString('hex')}`,
      repos: new Map([[repo, { store, policy: mission.policy }]]),
      scheduler: new MissionScheduler(), version: 'test', startedAt: Date.now()
    });
    await api.start();
    const token = api.bearerToken;
    const runner = new MissionRunner(store, { extraGates: [GATED_GATE] });
    const runnerPromise = runner.run(mission.id);
    try {
      // The runner drives execute → validating → waiting_for_approval.
      await waitFor(() => store.mustLoad(mission.id).state === MissionState.WAITING_FOR_APPROVAL);

      // Operator discovers the pending gate through the API, then denies it.
      const list = await apiReq(api, 'GET', `/v1/missions/${mission.id}/approvals`, token);
      assert.equal(list.status, 200);
      const pending = (list.body.approvals as any[]).find(a => a.status === 'pending');
      assert.ok(pending, 'a pending approval must be visible via the API');
      assert.equal(pending.gate, 'dangerous-command');

      const dec = await apiReq(api, 'POST', `/v1/missions/${mission.id}/approvals/${pending.id}`,
        token, { decision: 'denied', by: 'e2e-operator' });
      assert.equal(dec.status, 200);
      assert.equal(dec.body.approval.status, 'denied');
      assert.equal(dec.body.approval.decidedBy, 'e2e-operator');

      const final = await runnerPromise;
      assert.equal(final.state, MissionState.BLOCKED);

      // Denial evidence: persisted ledger + mission mirror + event stream.
      const ledger = loadApprovals(store.dir(mission.id));
      const decided = ledger.find(a => a.id === pending.id);
      assert.equal(decided?.status, 'denied');
      assert.equal(decided?.decidedBy, 'e2e-operator');
      assert.ok(decided?.decidedAt);
      const events = store.events(mission.id);
      assert.ok(events.some(e => e.type === 'approval_decided' && e.data?.status === 'denied'),
        'denial must be recorded in the event stream');
      assert.ok(events.some(e => e.type === 'mission_blocked'),
        'blocked outcome must be recorded');
      assert.ok(!events.some(e => e.data?.status === 'approved'),
        'no approval may be recorded for a denied gate');

      // Zero gated effects: the unapproved argv never spawned.
      assert.equal(existsSync(join(final.workspace.path, SENTINEL)), false,
        'denied gate command must never execute');
      const gateResult = final.passes.at(-1)?.gates?.find(g => g.name === GATED_GATE.name);
      assert.equal(gateResult?.exitCode, null);
      assert.equal(gateResult?.passed, false);
      assert.match(gateResult?.note ?? '', /requires approval/);

      // Honest termination: blocked, not completed; exactly one agent pass
      // (the execute step) — no repair or retry burned budget after denial.
      assert.notEqual(final.state, MissionState.COMPLETED);
      assert.equal(final.outcome, undefined, 'blocked missions record no outcome');
      assert.equal(final.usage.agentInvocations, 1);
      assert.equal(final.passes.length, 1);
      assert.equal(final.stateHistory.at(-1)?.state, MissionState.BLOCKED);
      assert.match(final.stateHistory.at(-1)?.reason ?? '', /approval denied/);
    } finally {
      // On any failure the runner may still be polling the approval ledger —
      // cancel it so the test exits instead of waiting out the 1h timeout.
      runner.requestCancel();
      await api.stop();
      await runnerPromise.catch(() => undefined);
    }
  });

  test('unanswered approval → approvalTimeoutMs blocks the mission; no decision recorded', async () => {
    // approvalTimeoutMs: 0 → the first poll already exceeds the deadline.
    // Worst case the runner waits one poll interval (~5s) before blocking —
    // the outcome is identical, so the assertion is deterministic.
    const mission = mkMission({ approvalTimeoutMs: 0 });
    await prepareMission(mission, store, { plannerTasks: [task] });

    const final = await new MissionRunner(store, { extraGates: [GATED_GATE] }).run(mission.id);
    assert.equal(final.state, MissionState.BLOCKED);

    // Timeout evidence is distinct from a human decision: the ledger entry
    // stays pending, no approval_decided event exists, and the block reason
    // is the timeout — never an implicit deny/approve.
    const ledger = loadApprovals(store.dir(mission.id));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].status, 'pending', 'timed-out approval must not be auto-decided');
    const events = store.events(mission.id);
    assert.ok(events.some(e => e.type === 'approval_required'), 'gate request must be recorded');
    assert.ok(events.some(e =>
      e.type === 'mission_blocked' && e.data?.reason === 'approval timeout'),
      'timeout must be recorded as the block reason');
    assert.ok(!events.some(e => e.type === 'approval_decided'),
      'a timeout is not a decision — no approval_decided event may exist');
    assert.match(final.stateHistory.at(-1)?.reason ?? '', /approval timed out/);

    // Same zero-effect guarantee: the gated argv never ran.
    assert.equal(existsSync(join(final.workspace.path, SENTINEL)), false);
    assert.equal(final.usage.agentInvocations, 1);
    assert.equal(final.passes.length, 1);
    assert.equal(final.outcome, undefined);
  });
});
