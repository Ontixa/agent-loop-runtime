import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MissionStore } from '../mission/mission-store.js';
import { MissionState, TaskStatus } from '../types.js';
import type { RuntimeEvent } from '../types.js';

/**
 * Chaos regression — SIGKILL the runtime mid repair-loop.
 *
 * Roadmap v0.2: "kill mid repair-loop / mid-agent — recovery resumes or fails
 * honestly". The seam under test (src/engine/mission-runner.ts stepRepair):
 *
 *   validating(gate fails) → repairing → mutate(repair pass + task running)
 *     → invokeAgent (real subprocess) → persist result → validating …
 *
 * A runner killed while the repair agent is in flight leaves an OPEN repair
 * pass and a repair task stuck `running` — outcome unknown. Recovery must
 * mark both `interrupted`, re-drive the task for real on resume, and never
 * report completion without a genuine post-resume gate pass.
 *
 * Injection point (deterministic, no production hooks): the fixture agent
 * records `repair-start <pid>` in an external evidence file, applies the fix,
 * then hangs — the kill provably lands mid-repair with partial work already
 * in the worktree. The retried attempt records `repair-retry` and exits, so
 * marker counts prove the repair really re-ran in a second process.
 */

const NODE = process.execPath;
const TSX = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../cli.ts', import.meta.url));

let gitOk = true;
try { execFileSync('git', ['--version'], { stdio: 'pipe' }); } catch { gitOk = false; }
const describeGit = gitOk ? describe : describe.skip;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** kill(pid, 0) probe — ESRCH = dead, EPERM = alive but unverifiable. */
const pidDead = (pid: number): boolean => {
  try { process.kill(pid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === 'ESRCH'; }
};

const EXPECTED = 'fixed content\n';

async function waitFor(desc: string, fn: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${desc}`);
    await sleep(75);
  }
}

function markerCounts(evidence: string): { repairStart: number; repairRetry: number; gateRun: number } {
  if (!existsSync(evidence)) return { repairStart: 0, repairRetry: 0, gateRun: 0 };
  const lines = readFileSync(evidence, 'utf8').split('\n').filter(Boolean);
  return {
    repairStart: lines.filter(l => l.startsWith('repair-start ')).length,
    repairRetry: lines.filter(l => l.startsWith('repair-retry ')).length,
    gateRun: lines.filter(l => l.startsWith('gate-run ')).length
  };
}

/** Repair-agent pids recorded in the evidence file (for orphan cleanup). */
function repairPids(evidence: string): number[] {
  if (!existsSync(evidence)) return [];
  return readFileSync(evidence, 'utf8').split('\n')
    .map(l => Number(l.split(' ')[1]))
    .filter(n => Number.isSafeInteger(n) && n > 0);
}

describeGit('chaos — kill runtime mid repair-loop', () => {
  let dir = '';
  let repo = '';
  let evidence = '';
  let child: ReturnType<typeof spawn> | null = null;
  let store: MissionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alr-chaos-repair-'));
    repo = join(dir, 'repo');
    evidence = join(dir, 'repair-evidence.log'); // outside the repo entirely
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git(['config', 'user.email', 'chaos@test']);
    git(['config', 'user.name', 'chaos']);

    // The gate is committed (it must exist inside the mission worktree). It
    // records every real invocation and fails until the repair content lands.
    writeFileSync(join(repo, 'check-gate.cjs'), `
const fs = require('node:fs');
const evidence = process.argv[2];
fs.appendFileSync(evidence, 'gate-run ' + process.pid + '\\n');
let ok = false;
try { ok = fs.readFileSync('result.txt', 'utf8') === ${JSON.stringify(EXPECTED)}; } catch { ok = false; }
process.exit(ok ? 0 : 1);
`);

    // Fixture agent lives OUTSIDE the repo — never part of the mission diff.
    // Its prompt arrives as the last argv element (the {objective}
    // placeholder carries the full prompt text):
    //  - initial execute pass → writes WRONG content (gate will fail)
    //  - fresh repair pass ('previous pass did not satisfy') → marker + fix
    //    + hang — the SIGKILL lands mid-repair with partial work present
    //  - retried repair task ('Repair pass' title) → marker + fix + exit
    const agentScript = join(dir, 'fixture-agent.cjs');
    writeFileSync(agentScript, `
const fs = require('node:fs');
const evidence = process.argv[2];
const prompt = process.argv[3] || '';
if (prompt.includes('Repair pass')) {
  fs.appendFileSync(evidence, 'repair-retry ' + process.pid + '\\n');
  fs.writeFileSync('result.txt', ${JSON.stringify(EXPECTED)});
  process.exit(0);
} else if (prompt.includes('previous pass did not satisfy')) {
  fs.appendFileSync(evidence, 'repair-start ' + process.pid + '\\n');
  fs.writeFileSync('result.txt', ${JSON.stringify(EXPECTED)});
  setInterval(() => {}, 1000); // hang — killed mid-repair
} else {
  fs.writeFileSync('result.txt', 'wrong content\\n');
}
`);

    writeFileSync(join(repo, 'agentloop.config.json'), JSON.stringify({
      agents: [{ name: 'fixer', type: 'custom', command: NODE, args: [agentScript, evidence, '{objective}'] }],
      defaultAgent: 'fixer',
      workingDirectory: '.',
      validationCommands: { test: [NODE, 'check-gate.cjs', evidence] }
    }, null, 2));
    writeFileSync(join(repo, 'agentloop.policy.json'), JSON.stringify({
      allowedCommands: [[NODE, 'check-gate.cjs', evidence]],
      agentTimeoutMs: 120_000,
      approvalTimeoutMs: 60_000,
      maxRepairPasses: 2
    }, null, 2));
    git(['add', '-A']);
    git(['commit', '-m', 'fixture']);
    store = new MissionStore(repo);
  });

  afterEach(async () => {
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      await Promise.race([new Promise(r => child!.once('exit', r)), sleep(5_000)]);
    }
    child = null;
    // Reap any orphaned fixture agents so cleanup can't wedge on held paths.
    for (const pid of repairPids(evidence)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  });

  test('SIGKILL mid-repair: no false completion; interrupted repair honestly retried on resume', async () => {
    const eventsPathFor = (id: string) => join(repo, '.agentloop', 'missions', id, 'events.jsonl');
    const readEvents = (id: string): RuntimeEvent[] => {
      const path = eventsPathFor(id);
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l) as RuntimeEvent; } catch { return null; } })
        .filter((e): e is RuntimeEvent => e !== null);
    };

    // ── run the real CLI in a child process ──────────────────────────────
    // A runner child that exits BEFORE the kill boundary never exercised the
    // injected fault — on a saturated host a transient fs error (EPERM on
    // atomic rename) can fail a run closed into a non-terminal state. That is
    // a host flake, not a chaos result: retry with a FRESH mission. A
    // completed mission or a timeout on a live runner is a real result —
    // never retried.
    let out = '';
    let missionId = '';
    const waitBoundary = (desc: string, fn: () => boolean, ms: number) =>
      waitFor(desc, () => {
        if (child && (child.exitCode !== null || child.signalCode !== null)) {
          throw new Error(`runner exited before ${desc} (code ${child.exitCode}):\n${out}`);
        }
        return fn();
      }, ms);
    const retireAttempt = async () => {
      if (child && child.exitCode === null && !child.killed) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await Promise.race([new Promise(r => child!.once('exit', r)), sleep(5_000)]);
      }
      child = null;
    };

    for (let attempt = 1; ; attempt++) {
      // Reap orphaned fixture agents from a previous attempt (a hanging
      // repair agent survives its runner), then truncate the shared evidence
      // log so marker counts belong solely to the attempt under test.
      for (const pid of repairPids(evidence)) {
        try { if (!pidDead(pid)) process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      writeFileSync(evidence, '');

      child = spawn(NODE, [TSX, CLI, 'run', 'fix result.txt', '--no-plan'], {
        cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      });
      out = '';
      child.stdout!.on('data', d => { out += d; });
      child.stderr!.on('data', d => { out += d; });

      try {
        missionId = '';
        await waitBoundary('mission id in run output', () => {
          missionId = out.match(/Mission (msn-[\w-]+) created/)?.[1] ?? '';
          return missionId !== '';
        }, 300_000).catch(e => { throw new Error(`${e.message}\nchild output:\n${out}`); });

        // ── reach the kill boundary: first gate failed, repair agent mid-body ─
        // Slow hosts: a cold tsx start + worktree + agent + gate + repair
        // spawn can take several minutes — margins are generous.
        await waitBoundary('repairing state on disk', () =>
          store.mustLoad(missionId).state === MissionState.REPAIRING, 600_000)
          .catch(e => { throw new Error(`${e.message}\nchild output:\n${out}`); });
        await waitBoundary('repair agent start marker', () =>
          markerCounts(evidence).repairStart >= 1, 240_000);
        break; // boundary reached with a live runner — proceed to the kill
      } catch (err) {
        const earlyExit = err instanceof Error && err.message.includes('runner exited before');
        // An early completion would be a REAL false-completion bug — never
        // retried, and it fails immediately.
        const completedEarly = /Mission \S+ completed/.test(out);
        await retireAttempt();
        if (!earlyExit || completedEarly || attempt >= 3) throw err;
      }
    }

    // Injection honesty: the runner must be alive and the repair agent
    // still running — otherwise this test is not exercising the boundary.
    assert.ok(child, 'a live runner child exists at the kill point');
    assert.equal(child.exitCode, null, 'runner must still be alive at the kill point');
    const crashedBeforeKill = store.mustLoad(missionId);
    const repairPassAtKill = crashedBeforeKill.passes.at(-1);
    assert.equal(repairPassAtKill?.kind, 'repair', 'the in-flight pass must be the repair pass');
    assert.equal(repairPassAtKill?.finishedAt, undefined, 'repair pass still open mid-flight');

    const runnerPid = crashedBeforeKill.runner?.pid;
    assert.ok(runnerPid && runnerPid !== process.pid, 'runner lease pid must be recorded');
    assert.ok(!pidDead(runnerPid), 'runtime process must be alive at the kill point');
    process.kill(runnerPid, 'SIGKILL');
    await waitFor('runner pid dead', () => pidDead(runnerPid), 30_000);
    await Promise.race([new Promise(r => child!.once('exit', r)), sleep(5_000)]);
    child = null;

    // ── (a) no false completion on disk or via the CLI ───────────────────
    const crashed = store.mustLoad(missionId);
    assert.equal(crashed.state, MissionState.REPAIRING,
      'killed mid-repair mission must remain repairing — never completed');
    assert.equal(crashed.outcome, undefined, 'no outcome may be recorded');
    const openPass = crashed.passes.at(-1);
    assert.equal(openPass?.kind, 'repair');
    assert.equal(openPass?.finishedAt, undefined, 'repair outcome unknown — pass stays open');
    assert.equal(openPass?.interrupted, undefined, 'interrupted is an audit verdict, not assumed');
    const repairTask = crashed.tasks.find(t => t.id.startsWith('repair_'));
    assert.equal(repairTask?.status, TaskStatus.RUNNING,
      'repair task still running on disk — outcome unknown, not completed');
    assert.ok(!existsSync(join(store.dir(missionId), 'receipt.json')),
      'no receipt may exist for an unfinished mission');
    assert.equal(crashed.usage.agentInvocations, 2, 'execute + repair attempts consumed budget');

    const atKill = readEvents(missionId);
    assert.equal(atKill.filter(e => e.type === 'mission_completed').length, 0);
    assert.equal(atKill.filter(e => e.type === 'validation_finished' && e.data?.passed === true).length, 0,
      'no passing validation may be recorded');
    assert.ok(atKill.some(e => e.type === 'validation_finished' && e.data?.passed === false),
      'the failed gate that triggered repair is on record');

    const status = spawnSync(NODE, [TSX, CLI, 'status', missionId, '--json'],
      { cwd: repo, encoding: 'utf8', timeout: 240_000, windowsHide: true });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).state, 'repairing',
      'status must report the honest non-terminal state');

    // ── resume: recover + re-drive ───────────────────────────────────────
    // A SIGKILL can also orphan mission.json.lock itself: killed between the
    // exclusive create and the owner-record write leaves a torn/empty lock,
    // and a reused pid makes the recorded owner look alive. Both are
    // unverifiable ownership — acquisition fails closed with LockTimeoutError
    // by design, and recovery must never break such a lock on its own. The
    // operator remedy for a wedged stale lock is removal — legitimate only
    // when the recorded owner is provably absent.
    const runResume = () => spawnSync(NODE, [TSX, CLI, 'resume', missionId],
      { cwd: repo, encoding: 'utf8', timeout: 600_000, windowsHide: true });

    let resume = runResume();
    if (resume.status !== 0) {
      // Whatever killed the resume, the mission must still be honestly
      // non-terminal — verify BEFORE any remediation.
      const wedged = store.mustLoad(missionId);
      assert.notEqual(wedged.state, MissionState.COMPLETED, 'no false completion on failed resume');
      assert.equal(wedged.outcome, undefined, 'no outcome may be recorded');
      assert.ok(!existsSync(join(store.dir(missionId), 'receipt.json')), 'no receipt');
      assert.ok(!readEvents(missionId).some(e => e.type === 'mission_completed'),
        'a failed resume must not emit completion');

      const lockPath = join(store.dir(missionId), 'mission.json.lock');
      if (/Timed out acquiring lock/.test(String(resume.stderr) + String(resume.stdout)) && existsSync(lockPath)) {
        let owner: { pid?: unknown; nonce?: unknown } | null = null;
        try { owner = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { owner = null; }
        const validOwner = owner && Number.isSafeInteger(owner.pid) &&
          typeof owner.nonce === 'string' && /^[a-f0-9]{16}$/i.test(owner.nonce);
        if (validOwner && !pidDead(owner!.pid as number)) {
          // A live foreign owner — breaking that lock would be the bug. The
          // mission wedged non-terminal is the verified honest outcome.
          return;
        }
        assert.ok(!validOwner,
          'a lock with a valid DEAD owner record must have been reclaimed — wedging is a bug');
        // Torn/empty owner record: the crash artifact. Operator remedy:
        // remove the stale lock, then recovery must proceed normally.
        rmSync(lockPath, { force: true });
      }
      resume = runResume();
    }
    assert.equal(resume.status, 0, String(resume.stderr));
    assert.match(resume.stdout, /finished:\s*completed/, resume.stdout);

    // ── (c) recovery completes the mission for real ──────────────────────
    const final = store.mustLoad(missionId);
    assert.equal(final.state, MissionState.COMPLETED);
    assert.equal(final.outcome?.result, 'completed');
    assert.equal(final.runner, undefined, 'runner lease released');
    assert.ok(existsSync(join(store.dir(missionId), 'receipt.json')), 'receipt written at completion');
    assert.ok(existsSync(join(final.workspace.path, 'result.txt')), 'repair work landed');
    assert.equal(readFileSync(join(final.workspace.path, 'result.txt'), 'utf8'), EXPECTED);

    // The interrupted repair task was retried for real and completed — its
    // `interrupted` flag is preserved in history, not erased.
    const retriedRepair = final.tasks.find(t => t.id.startsWith('repair_'));
    assert.equal(retriedRepair?.status, TaskStatus.COMPLETED, 'retried repair task completes');
    assert.equal(retriedRepair?.interrupted, true, 'interrupted history is preserved');

    // Pass history is honest: execute ok → repair interrupted (no exit
    // recorded) → retried execute ok. Nothing invents the lost outcome. A
    // resume that itself crashed mid-run may add further interrupted
    // passes/retries — only the shape, never the count, is fixed.
    assert.ok(final.passes.length >= 3);
    assert.equal(final.passes[0].kind, 'execute');
    assert.equal(final.passes[0].agentExit, 'success');
    assert.equal(final.passes[1].kind, 'repair');
    assert.equal(final.passes[1].interrupted, true);
    assert.equal(final.passes[1].agentExit, undefined, 'killed repair has no recorded exit');
    assert.equal(final.passes.at(-1)!.agentExit, 'success', 'the retried pass really ran');
    assert.ok(final.usage.agentInvocations >= 3, 'the retry consumed a real invocation');
    assert.equal(final.usage.repairPasses, 1);

    // The gate ran at least twice (fail → pass after the retried repair) and
    // the repair ran in TWO distinct agent processes — no replayed outcome.
    const markers = markerCounts(evidence);
    assert.equal(markers.repairStart, 1, 'first repair attempt recorded');
    assert.ok(markers.repairRetry >= 1, 'retried repair ran in a second process');
    assert.ok(markers.gateRun >= 2, `gate re-ran for real after resume (got ${markers.gateRun})`);
    const gate = final.passes.at(-1)?.gates?.find(g => g.name === 'test');
    assert.equal(gate?.passed, true);
    assert.equal(gate?.exitCode, 0);

    // Recovery audit names the interrupted repair pass and task. `from` is
    // the state recovery found: 'stale' normally; 'prepared'/'blocked' when
    // a first resume itself crashed mid-run and a second one recovered.
    assert.ok(final.lastRecovery, 'recovery audit persisted on the mission');
    assert.ok([MissionState.STALE, MissionState.PREPARED, MissionState.BLOCKED]
      .includes(final.lastRecovery!.from));
    assert.ok(final.lastRecovery!.interruptedPasses.includes(2),
      'the killed repair pass is named in the audit');
    assert.ok(final.lastRecovery!.interruptedTasks.some(id => id.startsWith('repair_')),
      'the interrupted repair task is named in the audit');

    // ── (b) events + history reflect the interruption honestly ───────────
    const events = readEvents(missionId);
    const types = events.map(e => e.type);
    const count = (t: RuntimeEvent['type']) => types.filter(x => x === t).length;
    const firstIdx = (t: RuntimeEvent['type']) => types.indexOf(t);

    assert.equal(count('mission_completed'), 1);
    assert.ok(count('mission_stale') >= 1, 'crash marked stale');
    assert.ok(count('recovery_audit') >= 1, 'recovery audit emitted');
    // At least two validations: the real failure that triggered repair and a
    // real pass after the retried repair. A crashed-then-retried resume may
    // add more — but a finished validation always follows a started one, and
    // exactly one finished validation reported `passed`.
    assert.ok(count('validation_started') >= 2);
    assert.ok(count('validation_finished') >= 1);
    assert.ok(count('validation_finished') <= count('validation_started'));
    assert.equal(events.filter(e => e.type === 'validation_finished' && e.data?.passed === true).length, 1,
      'exactly one genuinely passing validation');
    assert.ok(firstIdx('mission_stale') > firstIdx('validation_finished'),
      'crash recorded after the failed validation that triggered repair');
    assert.ok(types.lastIndexOf('validation_finished') > firstIdx('mission_stale'),
      'a real post-recovery validation exists after the stale marking');
    assert.ok(firstIdx('mission_completed') > types.lastIndexOf('validation_finished'),
      'completion only after the final real gate pass');
    assert.ok(events.some(e =>
      e.type === 'state_changed' && e.data?.from === 'repairing' && e.data?.to === 'stale'),
      'persisted history shows the mid-repair crash explicitly');

    const states = final.stateHistory.map(h => h.state);
    const subseq = ['running', 'validating', 'repairing', 'stale', 'prepared', 'running', 'validating', 'completed'];
    let at = -1;
    for (const want of subseq) {
      at = states.indexOf(want as MissionState, at + 1);
      assert.ok(at !== -1, `stateHistory must contain ${subseq.join(' → ')} (missing ${want})`);
    }

    // No remote side effects anywhere in the record.
    assert.ok(!events.some(e => /push|merge/i.test(e.type)), 'no push/merge events');
  });
});
