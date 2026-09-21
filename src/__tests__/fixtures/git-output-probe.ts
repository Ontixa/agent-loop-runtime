import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitOutputLimitError, MAX_GIT_OUTPUT_BYTES, gitSep } from '../../git/git-runner.js';
import { inspectRepo, preflightRepo, changedFiles, diffSummary } from '../../git/repo-inspector.js';
import { listMissionWorktrees, removeMissionWorktree } from '../../git/worktree-manager.js';
import { deterministicReview } from '../../engine/reviewer.js';
import { createMission, prepareMission } from '../../engine/mission-factory.js';
import { MissionRunner } from '../../engine/mission-runner.js';
import { MissionStore } from '../../mission/mission-store.js';
import { resolvePolicy } from '../../policy/policy.js';
import { AgentType, MissionState, TaskStatus } from '../../types.js';
import { cmdDoctor, cmdInit } from '../../commands/setup-commands.js';
import { collectHealth } from '../../health/health.js';

// Isolated subprocess only: no production injection API, provider, or large
// Git fixture. One shared synthetic buffer tests the fixed transport ceiling.
const dir = mkdtempSync(join(tmpdir(), 'alr-git-output-'));
const repo = join(dir, 'repo');
const hooks = join(dir, 'hooks');
mkdirSync(repo); mkdirSync(hooks);
const originalCwd = process.cwd();
const originalSpawn = childProcess.spawn;
const mutable = childProcess as { -readonly [K in keyof typeof childProcess]: (typeof childProcess)[K] };
const overflow = Buffer.alloc(MAX_GIT_OUTPUT_BYTES + 1, 120);
let target: (args: string[]) => boolean = () => false;
let kills = 0;
let killThrows = false;
let streamMode: 'overflow' | 'mixed' | 'utf8' | 'timeout' = 'overflow';
const checks: string[] = [];
let succeeded = false;
const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
async function injected<T>(match: typeof target, fn: () => Promise<T>): Promise<T> {
  target = match;
  try { return await fn(); } finally { target = () => false; streamMode = 'overflow'; killThrows = false; }
}
try {
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'core.hooksPath', hooks]);
  writeFileSync(join(repo, '.gitignore'), '.agentloop/\nlogs/\n');
  writeFileSync(join(repo, 'small.txt'), 'base\n');
  git(['add', '.']); git(['-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture']);
  const base = git(['rev-parse', 'HEAD']).trim();
  const store = new MissionStore(repo);
  const agent = { name: 'fixture', type: AgentType.CUSTOM, command: process.execPath,
    args: ['-e', "require('node:fs').writeFileSync('small.txt','changed')"] };
  const make = () => createMission({ repoPath: repo, agent,
    spec: { objective: 'small edit', acceptanceCriteria: ['fixture'] },
    policy: resolvePolicy({ allowLocalCommit: true, maxAgentInvocations: 1 }) }, store);
  const mission = make();
  mutable.spawn = ((command: string, args: string[], ...rest: any[]) => {
    if (command !== 'git' || !target(args)) return (originalSpawn as any)(command, args, ...rest);
    const child = new EventEmitter() as any;
    const mode = streamMode;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { kills++; if (killThrows) throw new Error('fixture kill failure'); return true; };
    setImmediate(() => {
      if (mode === 'timeout') {
        setTimeout(() => { child.stdout.emit('data', Buffer.from('late-timeout-content')); child.emit('close', 0); }, 25);
        return;
      }
      if (mode === 'mixed') {
        child.stdout.emit('data', Buffer.from('abc'));
        child.stderr.emit('data', Buffer.from('def'));
      } else if (mode === 'utf8') {
        child.stdout.emit('data', Buffer.from([0xe2]));
        child.stdout.emit('data', Buffer.from([0x82, 0xac]));
      } else child.stdout.emit('data', overflow);
      // Late output/close must never override overflow with success.
      if (mode === 'overflow') child.stderr.emit('data', Buffer.from('late-overflow-content'));
      child.emit('close', 0);
    });
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();

  await injected(() => true, async () => {
    streamMode = 'mixed';
    await assert.rejects(() => gitSep(['--version'], repo, 1000, { maxOutputBytes: 5 }), GitOutputLimitError);
    assert.deepEqual(await gitSep(['--version'], repo, 1000, { maxOutputBytes: 6 }), { stdout: 'abc', stderr: 'def' });
    streamMode = 'utf8';
    assert.equal((await gitSep(['--version'], repo, 1000, { maxOutputBytes: 3 })).stdout, '€');
    await assert.rejects(() => gitSep(['--version'], repo, 1000, { maxOutputBytes: 2 }), GitOutputLimitError);
    streamMode = 'timeout'; killThrows = true;
    let rejections = 0;
    await assert.rejects(() => gitSep(['--version'], repo, 10).catch(error => {
      rejections++; assert.equal(error.stderr, ''); assert.doesNotMatch(error.message, /late-timeout-content/); throw error;
    }), /timed out/);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(rejections, 1);
    streamMode = 'overflow';
    await assert.rejects(() => gitSep(['--version'], repo), (error: unknown) =>
      error instanceof GitOutputLimitError && error.stderr === '' && !error.message.includes('late-overflow-content'));
  });
  checks.push('aggregate byte boundary, split UTF8, timeout kill failure');

  for (const [stage, match, unknown] of [
    ['root', (a: string[]) => a.includes('--show-toplevel'), ['isRepo','unborn','detached','dirty','hasRemote']],
    ['head', (a: string[]) => a.includes('--verify'), ['unborn','detached','dirty','hasRemote']],
    ['branch', (a: string[]) => a[0] === 'symbolic-ref', ['detached','dirty','hasRemote']],
    ['status', (a: string[]) => a[0] === 'status', ['dirty','hasRemote']],
    ['remote', (a: string[]) => a[0] === 'remote', ['hasRemote']]
  ] as const) {
    await injected(match, async () => {
      const inspected = await inspectRepo(repo);
      assert.equal(inspected.inspectionComplete, false);
      assert.equal(inspected.inspectionError?.stage, stage);
      for (const key of unknown) assert.equal((inspected as any)[key], null, `${stage}:${key}`);
      if (stage !== 'root') assert.equal(inspected.isRepo, true);
      const preflight = await preflightRepo(repo);
      assert.ok(preflight.issues.some(i => i.code === 'inspection-incomplete' && i.severity === 'error'));
    });
  }
  checks.push('all inspection stages preserve known facts and null unknown facts');

  await injected(a => a.some(x => x.startsWith('refs/heads/')), async () => {
    assert.ok((await preflightRepo(repo, { missionBranch: 'candidate' })).issues.some(i => i.code === 'inspection-incomplete'));
  });
  for (const match of [(a: string[]) => a.includes('--name-only'), (a: string[]) => a.includes('--shortstat'),
    (a: string[]) => a[0] === 'diff' && !a[1]?.startsWith('--')]) {
    await injected(match, async () => {
      assert.equal((await deterministicReview({ worktreePath: repo, baseSha: base, mission })).verdict, 'request-changes');
    });
  }
  await injected(a => a[0] === 'diff', async () => {
    await assert.rejects(() => changedFiles(repo, base), GitOutputLimitError);
    await assert.rejects(() => diffSummary(repo, base), GitOutputLimitError);
  });
  await injected(a => a[0] === 'worktree', async () => {
    await assert.rejects(() => listMissionWorktrees(repo), GitOutputLimitError);
    await assert.rejects(() => removeMissionWorktree(repo, join(dir, 'absent')), GitOutputLimitError);
  });
  await injected(a => a[0] === 'branch' && a[1] === '-D', async () => {
    await assert.rejects(() => removeMissionWorktree(repo, join(dir, 'absent'), { branch: 'absent', keepBranch: false }), GitOutputLimitError);
  });
  checks.push('branch collision, reviewer and helper catches propagate incomplete output');

  process.chdir(repo);
  writeFileSync(join(repo, 'agentloop.config.json'), JSON.stringify({ agents: [{ name: 'node', type: 'custom', command: process.execPath }] }));
  await injected(a => a[0] === 'status', async () => {
    const lines: string[] = []; const log = console.log;
    try { console.log = (...args) => lines.push(args.join(' ')); await cmdDoctor({ json: true }); }
    finally { console.log = log; }
    const check = JSON.parse(lines.join('\n')).checks.find((c: any) => c.name === 'repository');
    assert.equal(check.ok, false); assert.match(check.detail, /inspection incomplete/);
    assert.doesNotMatch(check.detail, /not a git repository/);
    const health = await collectHealth({ repos: [repo], agents: [], version: 'fixture' });
    assert.equal(health.status, 'error'); assert.equal(health.repos[0].git.ok, false);
    assert.equal(health.repos[0].git.dirty, undefined);
    await assert.rejects(() => cmdInit({}), /inspection incomplete/);
    assert.equal(existsSync(join(repo, 'agentloop.policy.json')), false);
    await assert.rejects(() => prepareMission(mission, store), /inspection incomplete/);
    assert.equal(store.mustLoad(mission.id).usage.agentInvocations, 0);
    assert.equal(existsSync(join(repo, '.agentloop/worktrees', mission.id)), false);
  });
  checks.push('doctor/health/init and preflight fail closed without provider launches');

  // Config is a deliberate fixture file, commit before preparing a mission.
  git(['add', '.']); git(['-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture config']);
  const runnable = make();
  await prepareMission(runnable, store, { plannerTasks: [{ id: 't1', title: 'small edit', status: TaskStatus.PENDING, dependsOn: [] }] });
  await injected(a => a[0] === 'add', async () => {
    const result = await new MissionRunner(store).run(runnable.id);
    assert.equal(result.state, MissionState.BLOCKED);
    assert.notEqual(result.outcome?.result, 'completed');
  });
  checks.push('checkpoint overflow blocks runner completion');
  const postCommit = make();
  await prepareMission(postCommit, store, { plannerTasks: [{ id: 't1', title: 'small edit', status: TaskStatus.PENDING, dependsOn: [] }] });
  await injected(a => a.includes('--shortstat'), async () => {
    const result = await new MissionRunner(store).run(postCommit.id);
    assert.equal(result.state, MissionState.BLOCKED);
    assert.notEqual(result.outcome?.result, 'completed');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: result.workspace.path, encoding: 'utf8', timeout: 30_000 }).trim();
    assert.notEqual(head, result.repository.baseSha, 'commit may already exist; no rollback guarantee');
  });
  checks.push('post-commit summary overflow blocks without undoing the commit');
  assert.ok(kills > 0);
  succeeded = true;
  console.log(JSON.stringify({ checks, directChildKillRequests: kills }));
} finally {
  mutable.spawn = originalSpawn; syncBuiltinESMExports();
  process.chdir(originalCwd);
  if (succeeded) rmSync(dir, { recursive: true, force: true });
  else console.error(`Retained Git output fixture: ${dir}`);
}
