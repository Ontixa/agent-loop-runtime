import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { MissionStore } from '../mission/mission-store.js';
import { createMission, prepareMission, MissionPreparationError } from '../engine/mission-factory.js';
import { MissionRunner } from '../engine/mission-runner.js';
import { LockTimeoutError } from '../util/atomic-file.js';
import { MissionState, AgentType, TaskStatus } from '../types.js';
import type { MissionSpec, AgentConfig, TaskNode } from '../types.js';

/**
 * Chaos regression — locked-worktree / mission-lock contention.
 *
 * Roadmap v0.2: "locked worktree (lock held by dead/stale process) — reclaim
 * or fail-closed, never false-complete".
 *
 * `mission.json.lock` serializes every state mutation. A crash can orphan it
 * mid-section. The contract (src/util/atomic-file.ts, exercised end-to-end
 * through the runner here):
 *
 *   - recorded owner pid confirmed dead → the lock is reclaimed immediately
 *     and the mission runs for real;
 *   - recorded owner pid alive (or unverifiable) → the lock is NEVER broken —
 *     acquisition fails closed with LockTimeoutError, the mission stays in
 *     its committed state, and the foreign owner's lock file is preserved
 *     byte-for-byte;
 *   - pre-existing mission branch/worktree path → preflight refuses to
 *     prepare rather than adopt or overwrite someone else's workspace.
 */

let gitOk = true;
try { execFileSync('git', ['--version'], { stdio: 'pipe' }); } catch { gitOk = false; }
const describeGit = gitOk ? describe : describe.skip;

let repo: string;
let store: MissionStore;
let fakeAgentJs: string;
const sleepers: number[] = [];

const NODE = process.execPath;
const spec: MissionSpec = { objective: 'Make hello.txt', acceptanceCriteria: ['check passes'] };
const agent: AgentConfig = { name: 'fake', type: AgentType.CUSTOM, command: NODE, args: [] };
const task = (): TaskNode => ({ id: 't-1', title: 'create hello.txt', dependsOn: [], status: TaskStatus.PENDING });

/** kill(pid, 0) probe — ESRCH = dead, EPERM = alive but unverifiable. */
const pidDead = (pid: number): boolean => {
  try { process.kill(pid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Leave a mission lock exactly as a crashed owner would: valid record, no release. */
function plantLock(missionId: string, pid: number, ageToEpoch = false): string {
  const lockPath = join(store.dir(missionId), 'mission.json.lock');
  writeFileSync(lockPath, JSON.stringify({
    pid, nonce: '0123456789abcdef', at: new Date().toISOString()
  }));
  if (ageToEpoch) utimesSync(lockPath, new Date(0), new Date(0));
  return lockPath;
}

function initRepo() {
  repo = mkdtempSync(join(tmpdir(), 'alr-chaos-lock-'));
  const g = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 'chaos@test']);
  g(['config', 'user.name', 'chaos']);
  writeFileSync(join(repo, 'app.txt'), 'x\n');
  g(['add', '.']); g(['commit', '-qm', 'init']);
  store = new MissionStore(repo);
  fakeAgentJs = join(repo, 'fake-agent.cjs');
  writeFileSync(fakeAgentJs, `require('fs').writeFileSync('hello.txt','made by agent');\n`);
}

beforeEach(() => { if (gitOk) initRepo(); });
afterEach(() => {
  for (const pid of sleepers.splice(0)) {
    try { if (!pidDead(pid)) process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  if (repo) rmSync(repo, { recursive: true, force: true });
});

function mkMission() {
  return createMission({
    repoPath: repo, spec,
    agent: { ...agent, args: [fakeAgentJs, '{objective}'] },
    workspaceMode: 'worktree'
  }, store);
}

describeGit('lock contention — reclaim dead, refuse live, never false-complete', () => {
  test('mission lock left by a dead process is reclaimed; the run completes for real', async () => {
    const m = mkMission();
    await prepareMission(m, store, { plannerTasks: [task()] });

    // A crashed writer's lock: fresh mtime, valid owner record, dead pid.
    const dead = spawnSync(NODE, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    assert.ok(dead.pid && dead.status === 0, 'dead-owner fixture child must have run');
    for (let i = 0; i < 40 && !pidDead(dead.pid!); i++) await sleep(50);
    assert.ok(pidDead(dead.pid!), 'fixture child must be dead before planting its lock');
    const lockPath = plantLock(m.id, dead.pid!);

    const result = await new MissionRunner(store, {}).run(m.id);
    assert.equal(result.state, MissionState.COMPLETED,
      'dead-owner lock must be reclaimed, not stall the mission');
    assert.equal(result.usage.agentInvocations, 1, 'the agent really ran');
    assert.ok(existsSync(join(result.workspace.path, 'hello.txt')), 'real work landed');
    assert.equal(existsSync(lockPath), false, 'the reclaimed lock was released normally');
  });

  test('mission lock held by a live foreign process fails closed — lock preserved, mission untouched', async () => {
    const m = mkMission();
    await prepareMission(m, store, { plannerTasks: [task()] });

    // A competing writer: live foreign pid. The lock is ALSO aged — an
    // adversarial shape: age must never authorize breaking a live owner's
    // lock (only a confirmed-dead pid may be reclaimed).
    const sleeper = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'],
      { stdio: 'ignore', windowsHide: true });
    assert.ok(sleeper.pid, 'sleeper spawned');
    sleepers.push(sleeper.pid!);
    const lockPath = plantLock(m.id, sleeper.pid!, true);
    const foreignLock = readFileSync(lockPath, 'utf8');

    // Every mutation path (claim → error-transition → release) hits the held
    // lock and times out; run() must surface the failure, never complete.
    await assert.rejects(
      () => new MissionRunner(store, {}).run(m.id),
      LockTimeoutError
    );

    const after = store.mustLoad(m.id);
    assert.equal(after.state, MissionState.PREPARED,
      'a held lock must leave the committed state untouched');
    assert.equal(after.runner, undefined, 'the claim never committed');
    assert.equal(after.outcome, undefined);
    assert.equal(after.usage.agentInvocations, 0, 'no agent ran under a contested lock');
    assert.ok(!existsSync(join(store.dir(m.id), 'receipt.json')), 'no receipt');
    assert.equal(readFileSync(lockPath, 'utf8'), foreignLock,
      'the live foreign lock was never broken or rewritten');
    assert.ok(!store.events(m.id).some(e => e.type === 'mission_completed'),
      'no completion event may be emitted');
  });

  test('existing mission branch + worktree path → preflight refuses, run can never fabricate completion', async () => {
    const m = mkMission(); // state 'created'; worktree path computed but not yet allocated

    // Simulate a competing process that already owns this mission's
    // branch/worktree slot (e.g. a stale allocation or concurrent prepare).
    const missionBranch = `agentloop/${m.id}`;
    execFileSync('git', ['branch', missionBranch], { cwd: repo, stdio: 'pipe' });
    mkdirSync(join(repo, '.agentloop', 'worktrees', m.id), { recursive: true });

    await assert.rejects(
      () => prepareMission(m, store),
      (err: unknown) => {
        assert.ok(err instanceof MissionPreparationError, 'must be a preflight refusal');
        assert.match(err.message, /already exists/);
        return true;
      }
    );

    const after = store.mustLoad(m.id);
    assert.equal(after.state, MissionState.CREATED,
      'refused preparation must leave the mission created, never advanced');
    assert.equal(after.tasks.length, 0);
    assert.equal(after.outcome, undefined);

    // Driving it anyway must not fabricate progress: the state machine has
    // no legal created→running edge through the runner, so run() no-ops on
    // the persisted state — still created, still no work claimed.
    const res = await new MissionRunner(store, {}).run(m.id);
    assert.equal(res.state, MissionState.CREATED);
    assert.equal(res.usage.agentInvocations, 0, 'no agent invocation was consumed');
    assert.equal(res.outcome, undefined);
    // The claim it took was released again — nothing is left impersonating
    // an active runner.
    assert.equal(store.mustLoad(m.id).runner, undefined, 'lease released after the no-op');
  });
});
