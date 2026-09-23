import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MissionStore } from '../mission/mission-store.js';
import { loadApprovals, decideApproval } from '../policy/approvals.js';
import { MissionState, TaskStatus } from '../types.js';
import type { RuntimeEvent } from '../types.js';

/**
 * Chaos regression — SIGKILL the runtime mid-push.
 *
 * Roadmap v0.2: "kill runtime mid-push/publish attempt — assert no false
 * completion". The runtime never pushes on its own; the only push surface is
 * an approval-gated validation command, so the seam under test is
 * src/engine/mission-runner.ts stepValidate running an approved
 * `git push origin HEAD:<ref>` gate:
 *
 *   waiting_for_approval → operator approves → validating → gate spawn →
 *   receive-pack → pre-receive hook (in-flight) → ref update
 *
 * A runner killed while the push subprocess is in flight must leave the
 * mission in `validating` with the gate result unrecorded and the remote ref
 * untouched — the only honest recovery is a real second push after resume.
 *
 * Injection point (deterministic, no production hooks): the remote itself.
 * A local bare `origin` carries a committed pre-receive hook that appends a
 * `push-start` marker to an external evidence file, sleeps ~4s (the push is
 * provably mid-flight), then rejects the first attempt and accepts later
 * ones. The kill lands only after the marker proves the hook is mid-body.
 * The orphaned push is rejected regardless of when it finishes, so the ref
 * can never appear from the killed attempt.
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

const PUSH_REF = 'refs/heads/chaos-push-target';
const PUSH_ARGV = ['git', 'push', 'origin', `HEAD:${PUSH_REF}`];
const HOOK_SLEEP_S = 4;

async function waitFor(desc: string, fn: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${desc}`);
    await sleep(75);
  }
}

function markerCounts(evidence: string): { start: number; reject: number; accept: number } {
  if (!existsSync(evidence)) return { start: 0, reject: 0, accept: 0 };
  const lines = readFileSync(evidence, 'utf8').split('\n').filter(Boolean);
  return {
    start: lines.filter(l => l.startsWith('push-start ')).length,
    reject: lines.filter(l => l.startsWith('push-reject ')).length,
    accept: lines.filter(l => l.startsWith('push-accept ')).length
  };
}

describeGit('chaos — kill runtime mid-push', () => {
  let dir = '';
  let repo = '';
  let remote = '';
  let evidence = '';
  let child: ReturnType<typeof spawn> | null = null;
  let store: MissionStore;

  const remoteHasRef = (): boolean =>
    spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', PUSH_REF],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true }).status === 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alr-chaos-push-'));
    repo = join(dir, 'repo');
    remote = join(dir, 'remote.git');
    evidence = join(dir, 'push-evidence.log'); // outside the repo entirely

    // A real local remote: the push is a true ref mutation, gated by a
    // pre-receive hook that records each attempt and holds the push in
    // flight long enough for the kill to land mid-body.
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
    const hookPath = join(remote, 'hooks', 'pre-receive');
    writeFileSync(hookPath, `#!/bin/sh
# Chaos fixture hook: prove every attempt ran, hold the push in flight, and
# accept only a re-executed push (attempt >= 2) — the killed attempt must
# never land a ref.
evidence="${evidence.replace(/\\/g, '/')}"
echo "push-start $$" >> "$evidence"
sleep ${HOOK_SLEEP_S}
attempts=$(grep -c '^push-start ' "$evidence")
if [ "$attempts" -ge 2 ]; then
  echo "push-accept $$" >> "$evidence"
  exit 0
fi
echo "push-reject $$" >> "$evidence"
exit 1
`);
    try { chmodSync(hookPath, 0o755); } catch { /* Windows: git runs hooks regardless of mode */ }

    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git(['config', 'user.email', 'chaos@test']);
    git(['config', 'user.name', 'chaos']);
    git(['remote', 'add', 'origin', remote]);

    // Fixture agent lives OUTSIDE the repo — never part of the mission diff.
    const agentScript = join(dir, 'fixture-agent.cjs');
    writeFileSync(agentScript,
      `require('node:fs').writeFileSync('result.txt', 'push-me\\n');\n`);

    writeFileSync(join(repo, 'agentloop.config.json'), JSON.stringify({
      agents: [{ name: 'fixer', type: 'custom', command: NODE, args: [agentScript, '{objective}'] }],
      defaultAgent: 'fixer',
      workingDirectory: '.',
      validationCommands: { publish: PUSH_ARGV }
    }, null, 2));
    // allowedCommands stays empty → the push gate classifies needs-approval.
    writeFileSync(join(repo, 'agentloop.policy.json'), JSON.stringify({
      agentTimeoutMs: 120_000,
      approvalTimeoutMs: 120_000,
      maxRepairPasses: 0
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
    // The orphaned push may still hold repo handles — let the hook finish so
    // cleanup doesn't mask the real assertion.
    await waitFor('orphaned push hook to settle',
      () => markerCounts(evidence).reject + markerCounts(evidence).accept >= 1, 15_000)
      .catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  });

  test('SIGKILL mid-push: no false completion, remote untouched, real re-push on resume', async () => {
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
    let mdir = '';
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
      // The evidence log is shared across attempts — let any orphaned prior
      // push settle at its terminal marker, then truncate so marker counts
      // belong solely to the attempt under test.
      await waitFor('prior push attempts to settle', () => {
        const c = markerCounts(evidence);
        return c.start === 0 || c.reject + c.accept >= c.start;
      }, 30_000).catch(() => {});
      writeFileSync(evidence, '');

      child = spawn(NODE, [TSX, CLI, 'run', 'produce result.txt', '--no-plan'], {
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

        // ── the push gate needs approval → operator approves at the file
        //    boundary (the same ledger write `agentloop approve` performs) ─
        //    Slow hosts: cold tsx + worktree + agent + gate can take minutes.
        mdir = store.dir(missionId);
        await waitBoundary('waiting_for_approval state', () =>
          store.mustLoad(missionId).state === MissionState.WAITING_FOR_APPROVAL, 600_000)
          .catch(e => { throw new Error(`${e.message}\nchild output:\n${out}`); });
        const pending = loadApprovals(mdir).find(a => a.status === 'pending');
        assert.ok(pending, 'push gate must raise a pending approval');
        assert.equal(pending.gate, 'dangerous-command');
        assert.deepEqual(pending.commands, [PUSH_ARGV], 'approval binds the exact push argv');
        decideApproval(mdir, missionId, pending.id, 'approved', 'chaos-operator');

        // ── reach the kill boundary: push subprocess provably mid-body ───
        await waitBoundary('pre-receive hook start marker', () =>
          markerCounts(evidence).start >= 1, 240_000);
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

    assert.ok(child, 'a live runner child exists at the kill point');
    assert.equal(child.exitCode, null, 'runner must still be alive at the kill point');
    assert.equal(markerCounts(evidence).accept + markerCounts(evidence).reject, 0,
      'hook must still be holding the push when we kill');

    // Kill the lease pid — the real runtime process (see chaos-mid-gate:
    // the tsx wrapper's child.pid is only the launcher).
    const runnerPid = store.mustLoad(missionId).runner?.pid;
    assert.ok(runnerPid && runnerPid !== process.pid, 'runner lease pid must be recorded');
    assert.ok(!pidDead(runnerPid), 'runtime process must be alive at the kill point');
    process.kill(runnerPid, 'SIGKILL');
    await waitFor('runner pid dead', () => pidDead(runnerPid), 30_000);
    await Promise.race([new Promise(r => child!.once('exit', r)), sleep(5_000)]);
    child = null;

    // ── (a) no false completion on disk or via the CLI ───────────────────
    const crashed = store.mustLoad(missionId);
    assert.equal(crashed.state, MissionState.VALIDATING,
      'killed mid-push mission must remain validating — never completed');
    assert.equal(crashed.outcome, undefined, 'no outcome may be recorded');
    // The only gate result on record is the pre-approval "requires approval"
    // placeholder — the executed push produced no persisted verdict.
    const gateAtKill = crashed.passes.at(-1)?.gates?.find(g => g.name === 'publish');
    assert.equal(gateAtKill?.passed, false);
    assert.equal(gateAtKill?.exitCode, null, 'no exit code may be recorded for the killed push');
    assert.match(gateAtKill?.note ?? '', /requires approval/);
    assert.ok(!existsSync(join(mdir, 'receipt.json')),
      'no receipt may exist for an unfinished mission');

    const atKill = readEvents(missionId);
    assert.equal(atKill.filter(e => e.type === 'mission_completed').length, 0);
    assert.equal(atKill.filter(e => e.type === 'validation_finished' && e.data?.passed === true).length, 0,
      'no passing validation may be recorded — the push never finished');
    assert.ok(atKill.some(e => e.type === 'approval_required'), 'gate request on record');
    assert.ok(atKill.some(e => e.type === 'approval_decided' && e.data?.status === 'approved'),
      'the operator decision is on record');

    // The orphaned push is deterministically rejected by the hook — the
    // remote ref must never appear from the killed attempt.
    await waitFor('orphaned push to be rejected', () => markerCounts(evidence).reject >= 1, 30_000);
    assert.equal(remoteHasRef(), false, 'killed push must not publish the ref');
    assert.equal(markerCounts(evidence).accept, 0);

    const status = spawnSync(NODE, [TSX, CLI, 'status', missionId, '--json'],
      { cwd: repo, encoding: 'utf8', timeout: 240_000, windowsHide: true });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).state, 'validating',
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
      assert.ok(!existsSync(join(mdir, 'receipt.json')), 'no receipt');
      assert.ok(!readEvents(missionId).some(e => e.type === 'mission_completed'),
        'a failed resume must not emit completion');

      const lockPath = join(mdir, 'mission.json.lock');
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

    // ── (c) recovery completes the mission with a REAL second push ───────
    const final = store.mustLoad(missionId);
    assert.equal(final.state, MissionState.COMPLETED);
    assert.equal(final.outcome?.result, 'completed');
    assert.equal(final.runner, undefined, 'runner lease released');
    assert.equal(final.usage.agentInvocations, 1,
      'the finished agent attempt must not be re-run — only the push repeats');
    assert.ok(final.tasks.every(t => t.status === TaskStatus.COMPLETED),
      'task completion was already recorded before the kill');
    assert.ok(existsSync(join(mdir, 'receipt.json')), 'receipt written at completion');

    const gate = final.passes.at(-1)?.gates?.find(g => g.name === 'publish');
    assert.equal(gate?.passed, true, 're-run push result persisted and passed');
    assert.equal(gate?.exitCode, 0);
    assert.ok((gate?.durationMs ?? 0) >= HOOK_SLEEP_S * 1000 - 750,
      'recorded gate duration proves a real push ran, not a cached verdict');

    // The push executed in at least TWO real hook invocations: the killed
    // attempt (rejected) and a post-resume attempt (accepted). No replayed
    // verdict. A resume that itself crashed mid-push may add further real
    // attempts — every started push must have reached a terminal verdict.
    await waitFor('all push attempts settled', () => {
      const c = markerCounts(evidence);
      return c.reject + c.accept >= c.start;
    }, 30_000);
    const markers = markerCounts(evidence);
    assert.ok(markers.start >= 2, 'push hook ran at least twice — once per run');
    assert.equal(markers.reject, markers.start - markers.accept,
      'every non-accepted push was rejected');
    assert.ok(markers.accept >= 1, 'a post-resume attempt was accepted');
    assert.equal(remoteHasRef(), true, 'the ref landed only via the post-resume push');

    // The approval was sticky across the crash: still exactly one request,
    // decided once — the resumed validation never re-asked.
    const ledger = loadApprovals(mdir);
    assert.equal(ledger.length, 1, 'no duplicate approval request after recovery');
    assert.equal(ledger[0].status, 'approved');
    assert.equal(ledger[0].decidedBy, 'chaos-operator');

    // ── (b) events + history reflect the interruption honestly ───────────
    const events = readEvents(missionId);
    const types = events.map(e => e.type);
    const count = (t: RuntimeEvent['type']) => types.filter(x => x === t).length;
    const firstIdx = (t: RuntimeEvent['type']) => types.indexOf(t);

    // At least three validations: needs-approval → approved-but-killed
    // mid-push → the real post-recovery run (a crashed-then-retried resume
    // may add more). A finished validation always follows a started one, and
    // the SIGKILLed validation never finished — so finished < started.
    assert.ok(count('validation_started') >= 3, 'gate re-entered after approval and after recovery');
    assert.equal(count('mission_completed'), 1);
    assert.ok(count('mission_stale') >= 1, 'crash marked stale');
    assert.ok(count('recovery_audit') >= 1, 'recovery audit emitted');
    assert.equal(count('approval_required'), 1, 'sticky approval — no second ask');
    assert.ok(count('validation_finished') >= 2, 'the killed validation never finished');
    assert.ok(count('validation_finished') < count('validation_started'),
      'at least the killed validation has no finished record');
    assert.ok(events.some(e => e.type === 'validation_finished' && e.data?.passed === true),
      'a real passing validation exists after resume');
    assert.ok(events.some(e => e.type === 'validation_finished' && e.data?.passed === false),
      'the pre-approval gate result is preserved, not rewritten');
    assert.ok(types.lastIndexOf('validation_started') > firstIdx('mission_stale'),
      'the post-recovery validation comes after the stale marking');
    assert.ok(firstIdx('mission_completed') > types.lastIndexOf('validation_finished'),
      'completion only after the final real gate pass');

    const states = final.stateHistory.map(h => h.state);
    const subseq = ['validating', 'waiting_for_approval', 'validating', 'stale', 'prepared', 'completed'];
    let at = -1;
    for (const want of subseq) {
      at = states.indexOf(want as MissionState, at + 1);
      assert.ok(at !== -1, `stateHistory must contain ${subseq.join(' → ')} (missing ${want})`);
    }

    // `from` is the state recovery found: 'stale' normally; 'prepared' or
    // 'blocked' when a first resume itself crashed mid-run and a second one
    // recovered.
    assert.ok(final.lastRecovery, 'recovery audit persisted on the mission');
    assert.ok([MissionState.STALE, MissionState.PREPARED, MissionState.BLOCKED]
      .includes(final.lastRecovery!.from));
  });
});
