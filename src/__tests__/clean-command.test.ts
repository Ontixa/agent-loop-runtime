import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { MissionStore } from '../mission/mission-store.js';
import { createMission } from '../engine/mission-factory.js';
import { createMissionWorktree, listMissionWorktrees } from '../git/worktree-manager.js';
import { cleanRepo, parseDurationMs } from '../commands/clean-command.js';
import { isPathInside, canonicalPath } from '../git/repo-inspector.js';
import { isTerminal } from '../mission/state-machine.js';
import { MissionState, AgentType } from '../types.js';
import type { Mission, MissionSpec, AgentConfig } from '../types.js';

/**
 * `agentloop clean` GC tests against a real temporary repository.
 * Skips automatically if git is unavailable.
 */

let gitOk = true;
try { execFileSync('git', ['--version'], { stdio: 'pipe' }); } catch { gitOk = false; }

const describeGit = gitOk ? describe : describe.skip;

let repo: string;
let sha: string;
let store: MissionStore;

function git(args: string[], cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

const spec: MissionSpec = { objective: 'gc test mission', acceptanceCriteria: ['test passes'] };
const agent: AgentConfig = { name: 'fake', type: AgentType.QWEN };

function branchExists(branch: string): boolean {
  try { git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; }
  catch { return false; }
}

/** Create a persisted mission with a real worktree + agentloop/<id> branch. */
async function missionWithWorktree(): Promise<Mission> {
  const m = createMission({ repoPath: repo, spec, agent }, store);
  const wt = await createMissionWorktree(repo, m.id, sha);
  store.mutate(m.id, fresh => {
    fresh.workspace.path = wt.path;
    fresh.workspace.branch = wt.branch;
    fresh.repository.baseSha = sha;
    fresh.repository.baseBranch = 'main';
  });
  return store.mustLoad(m.id);
}

/** Drive a mission through legal transitions to a terminal state. */
function terminate(m: Mission, to: MissionState.COMPLETED | MissionState.FAILED | MissionState.CANCELLED): Mission {
  const path: MissionState[] = to === MissionState.COMPLETED
    ? [MissionState.PREPARED, MissionState.RUNNING, MissionState.VALIDATING, MissionState.COMPLETED]
    : [MissionState.PREPARED, to];
  for (const s of path) store.transition(m, s, 'test');
  return m;
}

/** Backdate the terminal stateHistory entry so --older-than can match. */
function backdateTerminal(m: Mission, ageMs: number): void {
  store.mutate(m.id, fresh => {
    for (const h of fresh.stateHistory) {
      if (isTerminal(h.state)) h.at = new Date(Date.now() - ageMs).toISOString();
    }
  });
}

before(async () => {
  if (!gitOk) return;
  repo = mkdtempSync(join(tmpdir(), 'alr-clean-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@agentloop.dev']);
  git(['config', 'user.name', 'AgentLoop Test']);
  writeFileSync(join(repo, 'file.txt'), 'v1\n');
  git(['add', 'file.txt']);
  git(['commit', '-m', 'init']);
  sha = git(['rev-parse', 'HEAD']);
  store = new MissionStore(repo);
});
after(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

describe('parseDurationMs', () => {
  test('parses units and bare-number days', () => {
    assert.equal(parseDurationMs('500ms'), 500);
    assert.equal(parseDurationMs('30s'), 30_000);
    assert.equal(parseDurationMs('90m'), 90 * 60_000);
    assert.equal(parseDurationMs('24h'), 24 * 3_600_000);
    assert.equal(parseDurationMs('7d'), 7 * 86_400_000);
    assert.equal(parseDurationMs('2w'), 2 * 604_800_000);
    assert.equal(parseDurationMs('3'), 3 * 86_400_000);
    assert.equal(parseDurationMs('1.5h'), 1.5 * 3_600_000);
  });

  test('rejects malformed durations', () => {
    for (const bad of ['', 'abc', '10x', '-5d', 'd', '1..5h', 'NaN']) {
      assert.throws(() => parseDurationMs(bad), /Invalid duration/, bad);
    }
  });
});

describe('isPathInside', () => {
  test('compares canonical forms — separators, case, and non-existent tails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alr-inside-'));
    try {
      const child = join(dir, 'a', 'b');
      assert.equal(isPathInside(dir, child), true);
      assert.equal(isPathInside(dir, join(dir, 'a', '..', 'a', 'b')), true);
      assert.equal(isPathInside(dir, join(dir, '..', 'sibling')), false);
      assert.equal(isPathInside(dir, dir), true);
      // canonicalPath resolves a non-existent leaf through its existing ancestor
      assert.equal(canonicalPath(child), join(canonicalPath(dir), 'a', 'b'));
      if (process.platform === 'win32') {
        // NTFS is case-insensitive: drive-letter and component case must not
        // change containment (git and Node may disagree on lexical case)
        assert.equal(isPathInside(dir.toUpperCase(), child.toLowerCase()), true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describeGit('cleanRepo', () => {
  test('removes worktree and merged branch of a terminal mission', async () => {
    const m = terminate(await missionWithWorktree(), MissionState.COMPLETED);
    const report = await cleanRepo(repo);
    assert.equal(report.errors.length, 0);
    assert.ok(report.cleaned.some(i => i.missionId === m.id && i.removedWorktree && i.deletedBranch));
    assert.equal(existsSync(m.workspace.path), false);
    assert.equal(branchExists(`agentloop/${m.id}`), false);
    // mission record is preserved — GC is about workspaces, not history
    assert.equal(store.mustLoad(m.id).state, MissionState.COMPLETED);
    assert.ok(store.events(m.id).some(e => e.type === 'workspace_cleaned'));
  });

  test('never touches a non-terminal mission', async () => {
    const m = await missionWithWorktree();
    store.transition(m, MissionState.PREPARED, 'test');
    store.transition(m, MissionState.RUNNING, 'test');
    const report = await cleanRepo(repo);
    assert.equal(existsSync(m.workspace.path), true);
    assert.equal(branchExists(`agentloop/${m.id}`), true);
    assert.ok(report.skipped.some(s => s.missionId === m.id && s.reason.includes('not terminal')));
    await rmSync(m.workspace.path, { recursive: true, force: true });
    git(['worktree', 'prune']);
    git(['branch', '-D', `agentloop/${m.id}`]);
    store.transition(m, MissionState.CANCELLED, 'cleanup');
  });

  test('dry-run reports but does not delete', async () => {
    const m = terminate(await missionWithWorktree(), MissionState.FAILED);
    const report = await cleanRepo(repo, { dryRun: true });
    assert.equal(report.dryRun, true);
    assert.ok(report.cleaned.some(i => i.missionId === m.id));
    assert.equal(existsSync(m.workspace.path), true);
    assert.equal(branchExists(`agentloop/${m.id}`), true);
    const real = await cleanRepo(repo);
    assert.ok(real.cleaned.some(i => i.missionId === m.id));
    assert.equal(existsSync(m.workspace.path), false);
  });

  test('dirty worktree is skipped unless --force', async () => {
    const m = terminate(await missionWithWorktree(), MissionState.CANCELLED);
    writeFileSync(join(m.workspace.path, 'uncommitted.txt'), 'x\n');
    const skipped = await cleanRepo(repo);
    assert.ok(skipped.skipped.some(s => s.missionId === m.id && s.reason.includes('uncommitted')));
    assert.equal(existsSync(m.workspace.path), true);
    const forced = await cleanRepo(repo, { force: true });
    assert.ok(forced.cleaned.some(i => i.missionId === m.id));
    assert.equal(existsSync(m.workspace.path), false);
  });

  test('branch with unmerged commits is kept unless --force', async () => {
    const m = terminate(await missionWithWorktree(), MissionState.COMPLETED);
    writeFileSync(join(m.workspace.path, 'work.txt'), 'payload\n');
    git(['add', 'work.txt'], m.workspace.path);
    git(['commit', '-m', 'mission work'], m.workspace.path);

    const report = await cleanRepo(repo);
    const item = report.cleaned.find(i => i.missionId === m.id);
    assert.ok(item, 'worktree removed');
    assert.equal(item!.removedWorktree, true);
    assert.equal(item!.deletedBranch, false);
    assert.ok(item!.notes.some(n => n.includes('unmerged')));
    assert.equal(branchExists(`agentloop/${m.id}`), true);

    const forced = await cleanRepo(repo, { force: true });
    assert.ok(forced.cleaned.some(i => i.missionId === m.id && i.deletedBranch));
    assert.equal(branchExists(`agentloop/${m.id}`), false);
  });

  test('--keep-branch removes the worktree but keeps a merged branch', async () => {
    const m = terminate(await missionWithWorktree(), MissionState.COMPLETED);
    const report = await cleanRepo(repo, { keepBranch: true });
    const item = report.cleaned.find(i => i.missionId === m.id);
    assert.ok(item);
    assert.equal(item!.deletedBranch, false);
    assert.equal(existsSync(m.workspace.path), false);
    assert.equal(branchExists(`agentloop/${m.id}`), true);
    git(['branch', '-D', `agentloop/${m.id}`]);
  });

  test('--older-than skips recently terminal missions', async () => {
    const old = terminate(await missionWithWorktree(), MissionState.COMPLETED);
    backdateTerminal(old, 30 * 86_400_000);
    const fresh = terminate(await missionWithWorktree(), MissionState.FAILED);

    const report = await cleanRepo(repo, { olderThanMs: parseDurationMs('7d') });
    assert.ok(report.cleaned.some(i => i.missionId === old.id));
    assert.ok(report.skipped.some(s => s.missionId === fresh.id && s.reason.includes('older-than')));
    assert.equal(existsSync(fresh.workspace.path), true);
    await cleanRepo(repo, { force: true });
  });

  test('workspace path outside .agentloop/worktrees is refused', async () => {
    const m = await missionWithWorktree();
    const elsewhere = join(repo, 'elsewhere', m.id);
    mkdirSync(join(repo, 'elsewhere'), { recursive: true });
    store.mutate(m.id, fresh => { fresh.workspace.path = elsewhere; });
    terminate(store.mustLoad(m.id), MissionState.FAILED);

    const report = await cleanRepo(repo);
    assert.ok(report.skipped.some(s => s.missionId === m.id && s.reason.includes('outside .agentloop/worktrees')));
    // the real worktree recorded nowhere is still not ours to delete blindly;
    // it is reported by the orphan sweep (different-path note) and left in place
    assert.ok(report.skipped.some(s => s.missionId === m.id && s.reason.includes('different workspace path')));
    git(['worktree', 'remove', '--force', join(repo, '.agentloop', 'worktrees', m.id)]);
    git(['branch', '-D', `agentloop/${m.id}`]);
    rmSync(join(repo, 'elsewhere'), { recursive: true, force: true });
  });

  test('worktree without a mission record is reported, not removed', async () => {
    const orphan = await createMissionWorktree(repo, 'msn-orphan-test', sha);
    const report = await cleanRepo(repo);
    // git reports the canonical path (long form on Windows) — the sweep emits canonical too
    assert.ok(report.skipped.some(s => s.worktreePath === canonicalPath(orphan.path) && s.reason.includes('no mission record')));
    assert.equal(existsSync(orphan.path), true);
    git(['worktree', 'remove', '--force', orphan.path]);
    git(['branch', '-D', 'agentloop/msn-orphan-test']);
  });

  test('corrupt mission record protects its worktree', async () => {
    const m = await missionWithWorktree();
    terminate(store.mustLoad(m.id), MissionState.COMPLETED);
    writeFileSync(join(store.dir(m.id), 'mission.json'), '{corrupt', 'utf8');
    const report = await cleanRepo(repo);
    assert.ok(report.skipped.some(s => s.missionId === m.id && s.reason.includes('corrupt')));
    assert.equal(existsSync(m.workspace.path), true);
    git(['worktree', 'remove', '--force', m.workspace.path]);
    git(['branch', '-D', `agentloop/${m.id}`]);
  });

  test('nothing to clean on an empty repo of missions', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'alr-clean-empty-'));
    try {
      git(['init', '-b', 'main'], empty);
      git(['config', 'user.email', 't@t'], empty);
      git(['config', 'user.name', 't'], empty);
      writeFileSync(join(empty, 'f'), 'x');
      git(['add', 'f'], empty);
      git(['commit', '-m', 'init'], empty);
      const report = await cleanRepo(empty);
      assert.equal(report.cleaned.length, 0);
      assert.equal(report.errors.length, 0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('refuses a non-git directory', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'alr-clean-plain-'));
    try {
      await assert.rejects(() => cleanRepo(plain), /Not a git repository/);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
