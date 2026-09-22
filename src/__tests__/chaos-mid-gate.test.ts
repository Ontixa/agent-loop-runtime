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
 * Chaos regression — SIGKILL the runtime mid-validation-gate.
 *
 * Roadmap v0.2: "kill runtime mid-gate — assert no false completion".
 *
 * The seam under test (src/engine/mission-runner.ts stepValidate):
 *
 *   emit validation_started → runValidationGates (real subprocess)
 *     → persist pass.gates → emit validation_finished
 *     → deterministicReview → checkpoint('final') → COMPLETED + receipt
 *
 * A runner killed while a gate subprocess is in flight must leave the
 * mission in `validating` with NO gate results persisted — the only honest
 * recovery is to re-run the gate for real after resume.
 *
 * Injection point (deterministic, no production hooks): the gate command
 * itself is the controllable delay. A committed fixture gate sleeps ~4s
 * and appends `start <pid>`/`done <pid>` markers to an evidence file
 * outside the repo. The test kills the runner only after the marker proves
 * the gate process is mid-body — never at a guessed time.
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

const GATE_SLEEP_MS = 4_000;
const EXPECTED = 'gate-verified bytes\n';

async function waitFor(desc: string, fn: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${desc}`);
    await sleep(75);
  }
}

function markerCounts(evidence: string): { start: number; done: number } {
  if (!existsSync(evidence)) return { start: 0, done: 0 };
  const lines = readFileSync(evidence, 'utf8').split('\n').filter(Boolean);
  return {
    start: lines.filter(l => l.startsWith('start ')).length,
    done: lines.filter(l => l.startsWith('done ')).length
  };
}

describeGit('chaos — kill runtime mid-validation-gate', () => {
  let dir = '';
  let repo = '';
  let evidence = '';
  let child: ReturnType<typeof spawn> | null = null;
  let store: MissionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alr-chaos-gate-'));
    repo = join(dir, 'repo');
    evidence = join(dir, 'gate-evidence.log'); // outside the repo entirely
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
    const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git(['config', 'user.email', 'chaos@test']);
    git(['config', 'user.name', 'chaos']);

    // Fixture agent lives OUTSIDE the repo — it never becomes part of the
    // mission diff. It writes the expected file and exits immediately, so
    // the run reaches the validation boundary fast.
    const agentScript = join(dir, 'fixture-agent.cjs');
    writeFileSync(agentScript,
      `require('node:fs').writeFileSync('result.txt', ${JSON.stringify(EXPECTED)});\n`);

    // The gate is committed (must exist inside the mission worktree). It is
    // deliberately slow so the kill provably lands mid-gate, and it records
    // each real process execution in the external evidence file.
    writeFileSync(join(repo, 'slow-gate.cjs'), `
const fs = require('node:fs');
const evidence = process.argv[2];
fs.appendFileSync(evidence, 'start ' + process.pid + '\\n');
setTimeout(() => {
  let ok = false;
  try { ok = fs.readFileSync('result.txt', 'utf8') === ${JSON.stringify(EXPECTED)}; } catch { ok = false; }
  if (ok) fs.appendFileSync(evidence, 'done ' + process.pid + '\\n');
  process.exit(ok ? 0 : 1);
}, ${GATE_SLEEP_MS});
`);

    writeFileSync(join(repo, 'agentloop.config.json'), JSON.stringify({
      agents: [{ name: 'fixer', type: 'custom', command: NODE, args: [agentScript, '{objective}'] }],
      defaultAgent: 'fixer',
      workingDirectory: '.',
      validationCommands: { test: [NODE, 'slow-gate.cjs', evidence] }
    }, null, 2));
    writeFileSync(join(repo, 'agentloop.policy.json'), JSON.stringify({
      allowedCommands: [[NODE, 'slow-gate.cjs', evidence]],
      agentTimeoutMs: 120_000,
      approvalTimeoutMs: 60_000,
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
    // The orphaned gate may still hold the worktree as cwd — give it time to
    // exit before deleting, so cleanup doesn't mask the real assertion.
    await waitFor('orphaned gate to exit', () => markerCounts(evidence).done >= 1, 10_000).catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  });

  test('SIGKILL mid-gate: no false completion, honest events, real gate re-run on resume', async () => {
    const eventsPathFor = (id: string) => join(repo, '.agentloop', 'missions', id, 'events.jsonl');
    const readEvents = (id: string): RuntimeEvent[] => {
      const path = eventsPathFor(id);
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l) as RuntimeEvent; } catch { return null; } })
        .filter((e): e is RuntimeEvent => e !== null);
    };

    // ── run the real CLI in a child process ──────────────────────────────
    child = spawn(NODE, [TSX, CLI, 'run', 'produce result.txt', '--no-plan'], {
      cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let out = '';
    child.stdout!.on('data', d => { out += d; });
    child.stderr!.on('data', d => { out += d; });

    // Slow hosts: a cold tsx start plus several git subprocesses per phase
    // means the boundary can take minutes to reach — margins are generous.
    let missionId = '';
    await waitFor('mission id in run output', () => {
      missionId = out.match(/Mission (msn-[\w-]+) created/)?.[1] ?? '';
      return missionId !== '';
    }, 180_000).catch(e => { throw new Error(`${e.message}\nchild output:\n${out}`); });

    // ── reach the kill boundary: agent exited, gate process mid-body ─────
    await waitFor('validation_started event', () =>
      readEvents(missionId).some(e => e.type === 'validation_started'), 300_000)
      .catch(e => { throw new Error(`${e.message}\nchild output:\n${out}`); });
    await waitFor('gate process start marker', () => markerCounts(evidence).start >= 1, 60_000);

    // Injection honesty: the runner must be alive and the gate unfinished —
    // otherwise this test is not exercising the claimed boundary.
    assert.equal(child.exitCode, null, 'runner must still be alive at the kill point');
    assert.equal(markerCounts(evidence).done, 0, 'gate must still be sleeping when we kill');

    // SIGKILL the pid recorded in the runner lease — the actual runtime
    // process. `node tsx ...` spawns a WRAPPER that re-executes node for
    // cli.ts, so child.pid is only the wrapper: on POSIX killing it orphans
    // the real runtime (CI proved this — recoverMission rightly refused a
    // live runner pid). The lease pid is the honest "runtime process" on
    // every platform. The wrapper exits on its own when its child dies.
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
      'killed mid-gate mission must remain validating — never completed');
    assert.equal(crashed.outcome, undefined, 'no outcome may be recorded');
    assert.equal(crashed.passes.at(-1)?.agentExit, 'success', 'agent exit was recorded honestly');
    assert.equal(crashed.passes.at(-1)?.gates, undefined,
      'gate results must NOT be persisted — the gate never finished');
    assert.ok(!existsSync(join(store.dir(missionId), 'receipt.json')),
      'no receipt may exist for an unfinished mission');

    const atKill = readEvents(missionId);
    assert.ok(atKill.some(e => e.type === 'agent_finished'), 'agent exit is on record');
    assert.ok(atKill.some(e => e.type === 'task_finished'), 'task completion is on record');
    assert.equal(atKill.filter(e => e.type === 'validation_started').length, 1);
    assert.equal(atKill.filter(e => e.type === 'validation_finished').length, 0,
      'validation_finished must not exist — the gate was killed mid-run');
    assert.equal(atKill.filter(e => e.type === 'mission_completed').length, 0);

    const status = spawnSync(NODE, [TSX, CLI, 'status', missionId, '--json'],
      { cwd: repo, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).state, 'validating',
      'status must report the honest non-terminal state');

    // ── resume: recover + re-drive ───────────────────────────────────────
    const resume = spawnSync(NODE, [TSX, CLI, 'resume', missionId],
      { cwd: repo, encoding: 'utf8', timeout: 300_000, windowsHide: true });
    assert.equal(resume.status, 0, resume.stderr);
    assert.match(resume.stdout, /finished:\s*completed/, resume.stdout);

    // ── (c) recovery completes the mission for real ──────────────────────
    const final = store.mustLoad(missionId);
    assert.equal(final.state, MissionState.COMPLETED);
    assert.equal(final.outcome?.result, 'completed');
    assert.equal(final.runner, undefined, 'runner lease released');
    assert.equal(final.usage.agentInvocations, 1,
      'the finished agent attempt must not be re-run — only the gate repeats');
    assert.ok(final.tasks.every(t => t.status === TaskStatus.COMPLETED));
    assert.ok(existsSync(join(store.dir(missionId), 'receipt.json')), 'receipt written at completion');

    const gate = final.passes.at(-1)?.gates?.find(g => g.name === 'test');
    assert.equal(gate?.passed, true, 're-run gate result persisted and passed');
    assert.equal(gate?.exitCode, 0);
    assert.ok((gate?.durationMs ?? 0) >= GATE_SLEEP_MS - 750,
      'recorded gate duration proves a real process ran, not a cached result');

    // The gate body ran in TWO distinct processes: the one killed with the
    // runner, and the resumed run — no replayed/cached verdict. 'start'
    // markers prove both spawned. The killed gate's 'done' is platform
    // dependent: POSIX children are detached (survive, finish, append) while
    // Windows children die with the runner — both are honest containment
    // outcomes. What is guaranteed: the post-resume gate ran to completion
    // before resume returned, so at least one 'done' exists.
    const markers = markerCounts(evidence);
    assert.equal(markers.start, 2, 'gate spawned twice — once per run');
    assert.ok(markers.done >= 1 && markers.done <= 2,
      `expected 1 (orphan reaped) or 2 (orphan survived) done markers, got ${markers.done}`);

    // ── (b) events + history reflect the interruption honestly ───────────
    const events = readEvents(missionId);
    const types = events.map(e => e.type);
    const count = (t: RuntimeEvent['type']) => types.filter(x => x === t).length;
    const firstIdx = (t: RuntimeEvent['type']) => types.indexOf(t);

    assert.equal(count('validation_started'), 2, 'gate re-entered after recovery');
    assert.equal(count('validation_finished'), 1, 'finished only on the post-resume run');
    assert.equal(count('mission_completed'), 1);
    assert.equal(count('mission_stale'), 1, 'crash marked stale');
    assert.equal(count('recovery_audit'), 1, 'recovery audit emitted');

    // Ordering: start → (crash: validating→stale) → start again → finish → done
    assert.ok(firstIdx('mission_stale') > firstIdx('validation_started'),
      'crash recorded after the gate had started');
    assert.ok(types.lastIndexOf('validation_started') > firstIdx('mission_stale'),
      'second validation_started comes after the stale marking');
    assert.ok(firstIdx('validation_finished') > types.lastIndexOf('validation_started'),
      'validation_finished only after the re-run');
    assert.ok(firstIdx('mission_completed') > firstIdx('validation_finished'));

    const staleTransition = events.find(e =>
      e.type === 'state_changed' && e.data?.from === 'validating' && e.data?.to === 'stale');
    assert.ok(staleTransition, 'persisted history shows the mid-gate crash explicitly');
    assert.ok(events.some(e => e.type === 'mission_stale' && e.data?.pidDead === true),
      'dead-runner evidence recorded');

    const states = final.stateHistory.map(h => h.state);
    const subseq = ['validating', 'stale', 'prepared', 'running', 'validating', 'completed'];
    let at = -1;
    for (const want of subseq) {
      at = states.indexOf(want as MissionState, at + 1);
      assert.ok(at !== -1, `stateHistory must contain ${subseq.join(' → ')} (missing ${want})`);
    }

    assert.ok(final.lastRecovery, 'recovery audit persisted on the mission');
    assert.equal(final.lastRecovery!.from, MissionState.STALE);

    // No remote side effects anywhere in the record.
    assert.ok(!events.some(e => /push|merge/i.test(e.type)), 'no push/merge events');

    // Isolation: the work landed in the worktree, the main checkout is clean.
    assert.equal(readFileSync(join(final.workspace.path, 'result.txt'), 'utf8'), EXPECTED);
    assert.ok(!existsSync(join(repo, 'result.txt')), 'main checkout untouched');
  });
});
