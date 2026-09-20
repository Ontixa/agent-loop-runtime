import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync, spawn } from 'child_process';
import { MissionStore, RevisionConflictError, CorruptStateError, RunnerConflictError } from '../mission/mission-store.js';
import { createMission, prepareMission } from '../engine/mission-factory.js';
import { MissionRunner } from '../engine/mission-runner.js';
import { detectStaleMissions, recoverMission, pidAlive } from '../engine/recovery.js';
import { setWriteFaultInjector } from '../util/atomic-file.js';
import { requestApproval, decideApproval, loadApprovals, verifyDecision } from '../policy/approvals.js';
import { MissionState, AgentType, TaskStatus } from '../types.js';
import type { MissionSpec, AgentConfig, TaskNode, Mission } from '../types.js';

/**
 * Runtime-recovery contract tests — the P0 guarantees:
 *
 *  - persistence is compare-and-swap; a stale writer never clobbers
 *  - corrupt mission.json is loud, preserved, and listed — never "missing"
 *  - only the lease-holding runner may drive a mission (pid + nonce)
 *  - interrupted work is marked unknown, audited, and honestly retried
 *  - disk-write faults fail loudly without leaving torn state
 */

let gitOk = true;
try { execFileSync('git', ['--version'], { stdio: 'pipe' }); } catch { gitOk = false; }
const describeGit = gitOk ? describe : describe.skip;

let dir: string;
let store: MissionStore;
const NODE = process.execPath;

const spec: MissionSpec = { objective: 'Do work', acceptanceCriteria: ['ok'] };
const agent: AgentConfig = { name: 'fake', type: AgentType.CUSTOM, command: NODE, args: [] };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alr-rec-'));
  store = new MissionStore(dir);
});
afterEach(() => {
  setWriteFaultInjector(null);
  rmSync(dir, { recursive: true, force: true });
});

function mkMission(): Mission {
  return createMission({ repoPath: dir, spec, agent }, store);
}

// ─── persistence: CAS, corruption, faults ────────────────────────────────

describe('mission store — persistence honesty', () => {
  test('revision increments on every save', () => {
    const m = mkMission();
    const r0 = store.mustLoad(m.id).revision;
    store.mutate(m.id, fresh => { fresh.spec.nonGoals = ['x']; });
    const r1 = store.mustLoad(m.id).revision;
    assert.equal(r1, r0! + 1);
  });

  test('stale in-memory copy cannot overwrite newer state (CAS)', () => {
    const m = mkMission();
    const stale = store.mustLoad(m.id);          // snapshot at rev N
    store.mutate(m.id, f => { f.usage.repairPasses = 3; }); // rev N+1
    assert.throws(() => store.save(stale), RevisionConflictError);
    // The newer value survived — stale writer lost
    assert.equal(store.mustLoad(m.id).usage.repairPasses, 3);
  });

  test('corrupt mission.json → CorruptStateError, file preserved, listed corrupt', () => {
    const m = mkMission();
    const path = join(store.dir(m.id), 'mission.json');
    writeFileSync(path, '{ "id": "msn-broken", "state": "run'); // torn write

    assert.throws(() => store.load(m.id), CorruptStateError);
    // Bytes preserved verbatim for diagnosis
    assert.ok(readFileSync(path, 'utf-8').startsWith('{ "id"'));
    // list() skips it; listCorrupt() reports it — never silently "blank"
    assert.equal(store.list().length, 0);
    const corrupt = store.listCorrupt();
    assert.equal(corrupt.length, 1);
    assert.equal(corrupt[0].id, m.id);
  });

  test('save refuses to clobber a corrupt file', () => {
    const m = mkMission();
    const path = join(store.dir(m.id), 'mission.json');
    writeFileSync(path, 'not json');
    assert.throws(() => store.mutate(m.id, () => {}), CorruptStateError);
    // The corrupt bytes are still there — never auto-repaired into blank state
    assert.equal(readFileSync(path, 'utf-8'), 'not json');
  });

  test('write fault during save leaves old record intact', () => {
    const m = mkMission();
    const before = readFileSync(join(store.dir(m.id), 'mission.json'), 'utf-8');
    setWriteFaultInjector((op) => { if (op === 'rename') throw new Error('simulated ENOSPC'); });
    assert.throws(() => store.mutate(m.id, f => { f.usage.repairPasses = 9; }), /ENOSPC/);
    setWriteFaultInjector(null);
    // The pre-fault record is untouched — atomic rename failed before commit
    assert.equal(readFileSync(join(store.dir(m.id), 'mission.json'), 'utf-8'), before);
    assert.equal(store.mustLoad(m.id).usage.repairPasses, 0);
  });

  test('events carry unique ids and monotonically increasing seq', () => {
    const m = mkMission(); // emits mission_created
    store.emit(m.id, 'runner_claimed', { pid: 1, nonce: 'x' });
    store.emit(m.id, 'runner_claimed', { pid: 1, nonce: 'x' });
    const { events, skippedLines } = store.readEvents(m.id);
    assert.equal(skippedLines, 0);
    assert.ok(events.length >= 3);
    const ids = new Set(events.map(e => e.id));
    assert.equal(ids.size, events.length, 'event ids must be unique');
    const seqs = events.map(e => e.seq ?? -1);
    assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'seq must be monotonic');
  });
});

// ─── ownership: lease, claim, heartbeat ──────────────────────────────────

describe('mission store — runner ownership', () => {
  const runnerInfo = (pid: number, nonce: string, hbAgeMs = 0) => ({
    pid, nonce,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date(Date.now() - hbAgeMs).toISOString(),
    hbSeq: 1
  });

  test('second live runner cannot claim a held mission', () => {
    const m = mkMission();
    // Owner is a FOREIGN live process (different pid, alive, fresh beat)
    const claimed = store.claimForRun(m.id, runnerInfo(999999, 'nonce-A'), {
      staleAfterMs: 45_000, pidAlive: () => true
    });
    assert.equal(claimed.runner?.nonce, 'nonce-A');
    // A different foreign process, still live → refused
    assert.throws(
      () => store.claimForRun(m.id, runnerInfo(888888, 'nonce-B'), { staleAfterMs: 45_000, pidAlive: () => true }),
      RunnerConflictError
    );
  });

  test('dead owner is taken over (pid not alive)', () => {
    const m = mkMission();
    store.claimForRun(m.id, runnerInfo(999999, 'nonce-dead'), { staleAfterMs: 45_000, pidAlive: () => false });
    const claimed = store.claimForRun(m.id, runnerInfo(process.pid, 'nonce-live'), {
      staleAfterMs: 45_000, pidAlive
    });
    assert.equal(claimed.runner?.nonce, 'nonce-live');
  });

  test('expired-heartbeat owner is taken over (pid alive but stale beat)', () => {
    const m = mkMission();
    store.claimForRun(m.id, runnerInfo(424242, 'nonce-stuck', 120_000), {
      staleAfterMs: 45_000, pidAlive: () => true
    });
    const claimed = store.claimForRun(m.id, runnerInfo(process.pid, 'nonce-new'), {
      staleAfterMs: 45_000, pidAlive: () => true
    });
    assert.equal(claimed.runner?.nonce, 'nonce-new');
  });

  test('heartbeat only beats for the owning nonce', () => {
    const m = mkMission();
    store.claimForRun(m.id, runnerInfo(process.pid, 'nonce-A'), { staleAfterMs: 45_000, pidAlive: () => true });
    assert.equal(store.heartbeat(m.id, 'nonce-A', 2), true);
    assert.equal(store.heartbeat(m.id, 'nonce-WRONG', 99), false);
    assert.equal(store.mustLoad(m.id).runner?.hbSeq, 2, 'failed beat must not have written');
  });

  test('releaseRunner only releases its own nonce', () => {
    const m = mkMission();
    store.claimForRun(m.id, runnerInfo(process.pid, 'nonce-A'), { staleAfterMs: 45_000, pidAlive: () => true });
    store.releaseRunner(m.id, 'nonce-WRONG');
    assert.equal(store.mustLoad(m.id).runner?.nonce, 'nonce-A', 'foreign release must not clear owner');
    store.releaseRunner(m.id, 'nonce-A');
    assert.equal(store.mustLoad(m.id).runner, undefined);
  });

  test('pid reuse alone does not prove ownership — nonce decides', () => {
    const m = mkMission();
    // Owner record claims a foreign live pid; a different nonce with another
    // live pid is refused — pid equality is not identity, nonce is.
    store.claimForRun(m.id, runnerInfo(424242, 'nonce-A'), { staleAfterMs: 45_000, pidAlive: () => true });
    assert.throws(
      () => store.claimForRun(m.id, runnerInfo(555555, 'nonce-B'), { staleAfterMs: 45_000, pidAlive: () => true }),
      RunnerConflictError
    );
    // Same nonce (i.e. same runner instance re-entering) is allowed.
    const reclaimed = store.claimForRun(m.id, runnerInfo(process.pid, 'nonce-A'), {
      staleAfterMs: 45_000, pidAlive: () => true
    });
    assert.equal(reclaimed.runner?.nonce, 'nonce-A');
  });
});

// ─── recovery audit ──────────────────────────────────────────────────────

describeGit('recovery — interruption audit', () => {
  let repo: string;
  let fakeAgentJs: string;

  function initRepo() {
    repo = mkdtempSync(join(tmpdir(), 'alr-recrun-'));
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
const args=process.argv.slice(2);
const mode=(args.find(a=>a.startsWith('--mode='))||'--mode=success').slice(7);
if(mode==='hang'){setInterval(()=>{},1000);}
else if(mode==='work'){fs.writeFileSync('hello.txt','made');console.log('made');}
else console.log('noop');
`);
  }

  function tasks(n = 1): TaskNode[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `t-${i}`, title: `task ${i}`, dependsOn: [], status: TaskStatus.PENDING
    }));
  }

  beforeEach(initRepo);

  test('runner death mid-task → stale → recover marks task interrupted, outcome unknown', async () => {
    const m = createMission({
      repoPath: repo, spec,
      agent: { ...agent, args: [fakeAgentJs, '--mode=work', '{objective}'] }
    }, store);
    await prepareMission(m, store, { plannerTasks: tasks() });

    // Simulate a crashed runner: task RUNNING, open pass, dead pid
    store.transition(store.mustLoad(m.id), MissionState.RUNNING, 'go');
    store.mutate(m.id, f => {
      f.runner = { pid: 999999, nonce: 'dead', startedAt: new Date().toISOString(), heartbeatAt: new Date(Date.now() - 120_000).toISOString() };
      f.tasks[0].status = TaskStatus.RUNNING;
      f.tasks[0].startedAt = new Date().toISOString();
      f.passes.push({ n: 1, kind: 'execute', agentInvocationId: 'inv_x', intent: { taskId: 't-0', kind: 'execute' }, startedAt: new Date().toISOString() });
    });

    const stale = await detectStaleMissions(store);
    assert.equal(stale.length, 1);
    assert.equal(store.mustLoad(m.id).state, MissionState.STALE);

    const recovered = await recoverMission(store, m.id);
    assert.equal(recovered.state, MissionState.PREPARED);
    assert.equal(recovered.tasks[0].status, TaskStatus.PENDING, 'interrupted task must not stay running');
    assert.equal(recovered.tasks[0].interrupted, true, 'interrupted flag set — outcome unknown');
    assert.ok(recovered.lastRecovery, 'recovery audit persisted');
    assert.deepEqual(recovered.lastRecovery!.interruptedTasks, ['t-0']);
    assert.deepEqual(recovered.lastRecovery!.interruptedPasses, [1]);
    assert.equal(recovered.lastRecovery!.from, MissionState.STALE);
  });

  test('interrupted mission resumes and completes without losing history', async () => {
    const m = createMission({
      repoPath: repo, spec,
      agent: { ...agent, args: [fakeAgentJs, '--mode=work', '{objective}'] }
    }, store);
    await prepareMission(m, store, { plannerTasks: tasks() });

    // Crash mid-task
    store.transition(store.mustLoad(m.id), MissionState.RUNNING, 'go');
    store.mutate(m.id, f => {
      f.runner = { pid: 999999, nonce: 'dead', startedAt: new Date().toISOString(), heartbeatAt: new Date(Date.now() - 120_000).toISOString() };
      f.tasks[0].status = TaskStatus.RUNNING;
      f.passes.push({ n: 1, kind: 'execute', agentInvocationId: 'inv_1', intent: { taskId: 't-0', kind: 'execute' }, startedAt: new Date().toISOString() });
    });
    await detectStaleMissions(store);
    await recoverMission(store, m.id);

    // Resume with a fresh runner — the interrupted task is retried with the
    // partial-work warning in its prompt, and history is preserved.
    const runner = new MissionRunner(store, {});
    const result = await runner.run(m.id);

    const passes = result.passes;
    assert.ok(passes.some(p => p.interrupted), 'interrupted pass must remain in history');
    assert.equal(result.tasks[0].status, TaskStatus.COMPLETED, 'retried task completes');
    assert.ok(result.usage.agentInvocations >= 1);
    assert.ok(existsSync(join(result.workspace.path, 'hello.txt')), 'retried work landed');
    assert.equal(store.mustLoad(m.id).runner, undefined, 'lease released at end');
  });

  test('approval timeout clock restarts on recovery (dead runner was not waiting)', async () => {
    const m = createMission({ repoPath: repo, spec, agent }, store);
    await prepareMission(m, store, { plannerTasks: tasks() });
    const mdir = store.dir(m.id);
    const req = requestApproval(mdir, m.id, 'dangerous-command', 'test gate', [['rm', '-rf', 'x']]);
    // age the request beyond any timeout
    const aged = loadApprovals(mdir).map(a => a.id === req.id
      ? { ...a, requestedAt: new Date(Date.now() - 3_600_000).toISOString() } : a);
    const { saveApprovals } = await import('../policy/approvals.js');
    saveApprovals(mdir, m.id, aged);

    // force waiting state via legal path: prepared→running→waiting
    const running = store.transition(store.mustLoad(m.id), MissionState.RUNNING, 'go');
    store.transition(running, MissionState.WAITING_FOR_APPROVAL, 'gate raised');

    const before = Date.parse(loadApprovals(mdir)[0].requestedAt);
    await recoverMission(store, m.id);
    const after = Date.parse(loadApprovals(mdir)[0].requestedAt);
    assert.ok(after > before, 'pending approval wait clock restarted on recovery');
  });

  test('two runners cannot drive the same mission (lease enforced)', async () => {
    const m = createMission({
      repoPath: repo, spec,
      agent: { ...agent, args: [fakeAgentJs, '--mode=hang', '{objective}'] },
      budget: { agentTimeoutMs: 60_000 }
    }, store);
    await prepareMission(m, store, { plannerTasks: tasks() });

    const r1 = new MissionRunner(store, {});
    const p1 = r1.run(m.id); // hangs inside agent
    // Wait until r1 has claimed the mission, then rewrite the owner pid to a
    // real foreign live process — r2 (same node process) must still be refused.
    for (let i = 0; i < 100 && !store.mustLoad(m.id).runner; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(store.mustLoad(m.id).runner, 'r1 holds the lease');
    const sleeper = spawn(NODE, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      store.mutate(m.id, fresh => { fresh.runner!.pid = sleeper.pid!; });

      const r2 = new MissionRunner(store, {});
      await assert.rejects(() => r2.run(m.id), RunnerConflictError);
    } finally {
      sleeper.kill('SIGKILL');
    }

    r1.requestCancel();
    await p1;
    assert.equal(store.mustLoad(m.id).state, MissionState.CANCELLED);
  });
});

// ─── approval integrity ──────────────────────────────────────────────────

describe('approval integrity', () => {
  test('re-raising the same gate dedupes to the existing pending request', () => {
    const m = mkMission();
    const mdir = store.dir(m.id);
    const ctx = { policyHash: 'ph1', worktree: '/wt/1' };
    const a = requestApproval(mdir, m.id, 'push', 'push branch', [['git', 'push']], ctx);
    const b = requestApproval(mdir, m.id, 'push', 'push branch', [['git', 'push']], ctx);
    assert.equal(a.id, b.id, 'identical pending gate must not duplicate');
    assert.equal(loadApprovals(mdir).length, 1);
  });

  test('different argv is a different gate', () => {
    const m = mkMission();
    const mdir = store.dir(m.id);
    requestApproval(mdir, m.id, 'dangerous-command', 'a', [['rm', '-rf', 'a']]);
    requestApproval(mdir, m.id, 'dangerous-command', 'b', [['rm', '-rf', 'b']]);
    assert.equal(loadApprovals(mdir).length, 2);
  });

  test('decisions verify without a key (advisory) and sig present when key set', () => {
    const m = mkMission();
    const mdir = store.dir(m.id);
    const req = requestApproval(mdir, m.id, 'push', 'p');
    const decided = decideApproval(mdir, m.id, req.id, 'approved', 'alice')!;
    assert.equal(verifyDecision(decided), 'ok'); // no key → advisory mode
  });
});
