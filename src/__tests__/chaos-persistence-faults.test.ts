import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { MissionStore } from '../mission/mission-store.js';
import { missionsRoot } from '../mission/mission-store.js';
import { createMission, prepareMission } from '../engine/mission-factory.js';
import { MissionRunner } from '../engine/mission-runner.js';
import { setWriteFaultInjector } from '../util/atomic-file.js';
import { loadPolicy } from '../policy/policy.js';
import { MissionState, AgentType, TaskStatus } from '../types.js';
import type { MissionSpec, AgentConfig, TaskNode } from '../types.js';

/**
 * Chaos regression — persistence/write failure during mission state
 * transitions (simulated disk-full). Roadmap v0.2: "disk-full — assert no
 * false completion".
 *
 * Seam: the existing `setWriteFaultInjector` test hook in
 * src/util/atomic-file.ts fires before the real syscall on every atomic
 * write/append/rename. Arming it on `rename` of `mission.json` simulates a
 * disk that refuses commits — the temp-file write happens, the atomic
 * rename never lands, and the pre-fault record is the only persisted truth.
 *
 * Asserted contract: a failed transition can NEVER produce a false
 * completion — the mission stays in its last committed (non-terminal) state,
 * carries no outcome and no receipt, and a healthy runner afterwards drives
 * it to a genuine COMPLETED.
 */

let gitOk = true;
try { execFileSync('git', ['--version'], { stdio: 'pipe' }); } catch { gitOk = false; }
const describeGit = gitOk ? describe : describe.skip;

let repo: string;
let store: MissionStore;
let fakeAgentJs: string;

const NODE = process.execPath;
const spec: MissionSpec = { objective: 'Make hello.txt', acceptanceCriteria: ['check passes'] };
const agent: AgentConfig = { name: 'fake', type: AgentType.CUSTOM, command: NODE, args: [] };
const task = (): TaskNode => ({ id: 't-1', title: 'create hello.txt', dependsOn: [], status: TaskStatus.PENDING });

/** Fail only the atomic RENAME of mission.json — the commit point itself. */
function armMissionWriteFault(): void {
  setWriteFaultInjector((op, path) => {
    if (op === 'rename' && path.endsWith('mission.json')) {
      throw new Error('simulated ENOSPC: no space left on device');
    }
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(desc: string, fn: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${desc}`);
    await sleep(50);
  }
}

function initRepo() {
  repo = mkdtempSync(join(tmpdir(), 'alr-chaos-persist-'));
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
  setWriteFaultInjector(null);
  if (repo) rmSync(repo, { recursive: true, force: true });
});

function mkMission(extra: Partial<Parameters<typeof createMission>[0]> = {}) {
  return createMission({
    repoPath: repo, spec,
    agent: { ...agent, args: [fakeAgentJs, '{objective}'] },
    workspaceMode: 'worktree', ...extra
  }, store);
}

describeGit('persistence faults — fail closed, never false-complete', () => {
  test('disk-full at mission creation: throws, leaves no phantom record', () => {
    armMissionWriteFault();
    assert.throws(() => mkMission(), /ENOSPC/);
    // Nothing may appear on the mission list — a failed save is an absent
    // record, never a half-written or blank mission.
    assert.equal(store.list().length, 0);
    assert.equal(store.listCorrupt().length, 0);
    for (const entry of readdirSync(missionsRoot(repo))) {
      assert.equal(existsSync(join(missionsRoot(repo), entry, 'mission.json')), false,
        `leftover mission dir ${entry} must not contain a record`);
    }

    // Fault cleared → creation works normally.
    setWriteFaultInjector(null);
    const m = mkMission();
    assert.equal(store.list().length, 1);
    assert.equal(store.mustLoad(m.id).state, MissionState.CREATED);
  });

  test('disk-full during run: claim never commits, mission stays prepared, healthy retry completes', async () => {
    const m = mkMission();
    await prepareMission(m, store, { plannerTasks: [task()] });
    const revBefore = store.mustLoad(m.id).revision;

    armMissionWriteFault();
    // The claim is the first mutation — with the disk refusing commits it
    // can never be recorded, so no runner lease ever exists on disk.
    const outcome = await new MissionRunner(store, {}).run(m.id)
      .then(res => `returned:${res.state}`)
      .catch(e => `threw:${e instanceof Error ? e.message : e}`);

    const crashed = store.mustLoad(m.id);
    assert.equal(crashed.state, MissionState.PREPARED,
      'every transition failed → last committed state is still prepared');
    assert.equal(crashed.revision, revBefore, 'no revision was ever committed');
    assert.equal(crashed.runner, undefined, 'no lease was ever persisted');
    assert.equal(crashed.outcome, undefined);
    assert.equal(crashed.usage.agentInvocations, 0, 'no agent ran — no spend recorded');
    assert.ok(!existsSync(join(store.dir(m.id), 'receipt.json')), 'no receipt');
    // The honest shapes: run() reports the un-prepared record, or surfaces
    // the write error — it never reports a terminal/complete state.
    assert.ok(
      outcome === `returned:${MissionState.PREPARED}` || outcome.includes('ENOSPC'),
      `run must surface the failure honestly, got: ${outcome}`);
    assert.notEqual(crashed.state, MissionState.COMPLETED);

    // Disk healthy again → the same mission runs to a genuine completion.
    setWriteFaultInjector(null);
    const result = await new MissionRunner(store, {}).run(m.id);
    assert.equal(result.state, MissionState.COMPLETED);
    assert.equal(result.usage.agentInvocations, 1, 'the work ran exactly once');
    assert.ok(existsSync(join(result.workspace.path, 'hello.txt')));
  });

  test('disk-full at gate-result persistence: stays validating, gates re-run for real on resume', async () => {
    // The gate parks until a release file appears — the test arms the fault
    // only after the gate is provably mid-flight, so the injected failure
    // lands exactly on the results-persist mutation.
    const dir = mkdtempSync(join(tmpdir(), 'alr-chaos-gatefault-'));
    const gateScript = join(dir, 'release-gate.cjs');
    const release = join(dir, 'release');
    const evidence = join(dir, 'gate-evidence.log');
    writeFileSync(gateScript, `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(evidence)}, 'gate-start ' + process.pid + '\\n');
const t = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) {
    clearInterval(t);
    fs.appendFileSync(${JSON.stringify(evidence)}, 'gate-done ' + process.pid + '\\n');
    process.exit(0);
  }
}, 25);
`);
    const gateArgv = [NODE, gateScript, release, evidence];
    const policy = loadPolicy(repo).policy;
    const m = mkMission({
      policy: { ...policy, allowedCommands: [...policy.allowedCommands, gateArgv] }
    });
    await prepareMission(m, store, { plannerTasks: [task()] });

    const runner = new MissionRunner(store, {
      extraGates: [{ name: 'release-gate', argv: gateArgv }]
    });
    const running = runner.run(m.id).then(res => `returned:${res.state}`)
      .catch(e => `threw:${e instanceof Error ? e.message : e}`);

    // Wait until the gate process is provably mid-body, then cut the disk.
    await waitFor('gate process mid-flight', () =>
      existsSync(evidence) && readFileSync(evidence, 'utf8').includes('gate-start'), 300_000);
    armMissionWriteFault();
    writeFileSync(release, 'go'); // let the gate finish — its results can never persist

    const outcome = await running;
    setWriteFaultInjector(null);

    // (a) No false completion: the last committed state is `validating`
    //     with the gate results unrecorded — outcome unknown on disk.
    const crashed = store.mustLoad(m.id);
    assert.equal(crashed.state, MissionState.VALIDATING,
      'failed persist must leave the honest pre-commit state');
    assert.equal(crashed.passes.at(-1)?.gates, undefined,
      'gate results must NOT be persisted — the commit never landed');
    assert.equal(crashed.outcome, undefined);
    assert.ok(!existsSync(join(store.dir(m.id), 'receipt.json')), 'no receipt');
    assert.ok(
      outcome === `returned:${MissionState.VALIDATING}` || outcome.includes('ENOSPC'),
      `run must surface the failure honestly, got: ${outcome}`);
    assert.notEqual(crashed.state, MissionState.COMPLETED);
    assert.ok(
      !store.events(m.id).some(e => e.type === 'mission_completed'),
      'no completion event may be emitted');

    // (b) Disk healthy → a fresh runner re-drives validation; the gate runs
    //     a SECOND time for real (no cached verdict) and the mission
    //     completes truthfully.
    const result = await new MissionRunner(store, {
      extraGates: [{ name: 'release-gate', argv: gateArgv }]
    }).run(m.id);
    assert.equal(result.state, MissionState.COMPLETED);
    const gate = result.passes.at(-1)?.gates?.find(g => g.name === 'release-gate');
    assert.equal(gate?.passed, true);
    assert.equal(gate?.exitCode, 0);
    const starts = readFileSync(evidence, 'utf8').split('\n')
      .filter(l => l.startsWith('gate-start ')).length;
    assert.equal(starts, 2, 'the gate really re-ran — no replayed result');
    assert.ok(existsSync(join(store.dir(m.id), 'receipt.json')),
      'receipt written only after real completion');
    rmSync(dir, { recursive: true, force: true });
  });

  test('event-log write failure is non-fatal but never fabricates a result', async () => {
    // A disk that refuses ONLY the events.jsonl append: the audit stream is
    // degraded (emit() warns + synthesizes in-memory events) yet the mission
    // record itself still commits — so completion must rest entirely on the
    // real work + real gate, never on the (absent) event lines.
    const dir = mkdtempSync(join(tmpdir(), 'alr-chaos-evlog-'));
    const gateScript = join(dir, 'check-gate.cjs');
    const evidence = join(dir, 'gate-evidence.log');
    writeFileSync(gateScript, `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(evidence)}, 'gate-ran ' + process.pid + '\\n');
process.exit(fs.existsSync('hello.txt') ? 0 : 1);
`);
    const gateArgv = [NODE, gateScript, evidence];
    const policy = loadPolicy(repo).policy;
    const m = mkMission({
      policy: { ...policy, allowedCommands: [...policy.allowedCommands, gateArgv] }
    });
    await prepareMission(m, store, { plannerTasks: [task()] });

    setWriteFaultInjector((op, path) => {
      if (op === 'append' && path.endsWith('events.jsonl')) {
        throw new Error('simulated ENOSPC: no space left on device');
      }
    });
    try {
      const result = await new MissionRunner(store, {
        extraGates: [{ name: 'check-gate', argv: gateArgv }]
      }).run(m.id);

      // The completion is genuine: the agent ran and the gate passed for
      // real — persisted on the mission record itself, not on the event log.
      assert.equal(result.state, MissionState.COMPLETED);
      assert.equal(result.outcome?.result, 'completed');
      assert.equal(result.passes.at(-1)?.gates?.[0]?.passed, true);
      assert.ok(readFileSync(evidence, 'utf8').includes('gate-ran'),
        'the gate really executed');
      // The audit trail took the loss: events written before the fault
      // survive, but the faulted-appended 'mission_completed' line is
      // absent — degraded, never fabricated.
      assert.ok(store.events(m.id).some(e => e.type === 'mission_created'),
        'pre-fault events are still on disk');
      assert.equal(store.events(m.id).some(e => e.type === 'mission_completed'), false,
        'the completion event was lost to the fault — the record stays honest');
    } finally {
      setWriteFaultInjector(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
