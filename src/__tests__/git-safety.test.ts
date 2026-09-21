import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { inspectRepo, preflightRepo } from '../git/repo-inspector.js';
import { createMissionWorktree, removeMissionWorktree, listMissionWorktrees } from '../git/worktree-manager.js';
import { gitSep, gitStdout, GitError } from '../git/git-runner.js';

/**
 * Git safety tests against a real temporary repository.
 * Skips automatically if git is unavailable.
 */

let gitOk = true;
try { execFileSync('git', ['--version'], { stdio: 'pipe' }); } catch { gitOk = false; }

const describeGit = gitOk ? describe : describe.skip;

let repo: string;
let sha: string;

function git(args: string[], cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

before(() => {
  if (!gitOk) return;
  repo = mkdtempSync(join(tmpdir(), 'alr-git-'));
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@agentloop.dev']);
  git(['config', 'user.name', 'AgentLoop Test']);
  writeFileSync(join(repo, 'file.txt'), 'v1\n');
  git(['add', 'file.txt']);
  git(['commit', '-m', 'init']);
  sha = git(['rev-parse', 'HEAD']);
});
after(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

describeGit('repo inspection', () => {
  test('healthy repo: isRepo, branch, clean, has headSha', async () => {
    const s = await inspectRepo(repo);
    assert.equal(s.isRepo, true);
    assert.equal(s.branch, 'main');
    assert.equal(s.dirty, false);
    assert.equal(s.detached, false);
    assert.equal(s.unborn, false);
    assert.equal(s.headSha, sha);
  });

  test('non-repo directory reports isRepo=false, never throws', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'alr-plain-'));
    try {
      const s = await inspectRepo(plain);
      assert.equal(s.isRepo, false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test('dirty tree detected with bounded file list', async () => {
    writeFileSync(join(repo, 'dirty.txt'), 'x\n');
    const s = await inspectRepo(repo);
    assert.equal(s.dirty, true);
    assert.ok(s.dirtyFiles.includes('dirty.txt'));
    rmSync(join(repo, 'dirty.txt'));
  });

  test('detached HEAD detected', async () => {
    git(['checkout', '--detach', 'HEAD']);
    const s = await inspectRepo(repo);
    assert.equal(s.detached, true);
    git(['checkout', 'main']);
  });

  test('unborn repo (no commits) detected', async () => {
    const unborn = mkdtempSync(join(tmpdir(), 'alr-unborn-'));
    try {
      git(['init'], unborn);
      const s = await inspectRepo(unborn);
      assert.equal(s.isRepo, true);
      assert.equal(s.unborn, true);
    } finally {
      rmSync(unborn, { recursive: true, force: true });
    }
  });
});

describeGit('preflight', () => {
  test('branch collision is an error issue', async () => {
    git(['branch', 'agentloop/m-collision']);
    const { issues } = await preflightRepo(repo, { missionBranch: 'agentloop/m-collision' });
    assert.ok(issues.some(i => i.code === 'branch-collision' && i.severity === 'error'));
    git(['branch', '-D', 'agentloop/m-collision']);
  });

  test('dirty tree is error for in-place, warning for worktree mode', async () => {
    writeFileSync(join(repo, 'dirty.txt'), 'x\n');
    const wt = await preflightRepo(repo, { missionBranch: 'agentloop/m-x', worktreePath: join(repo, '.agentloop/worktrees/m-x') });
    const ip = await preflightRepo(repo, { inPlace: true });
    assert.ok(wt.issues.find(i => i.code === 'dirty-tree')?.severity === 'warning');
    assert.ok(ip.issues.find(i => i.code === 'dirty-tree')?.severity === 'error');
    rmSync(join(repo, 'dirty.txt'));
  });

  test('non-repo produces error issue', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'alr-plain2-'));
    try {
      const { issues } = await preflightRepo(plain);
      assert.ok(issues.some(i => i.code === 'not-a-repo' && i.severity === 'error'));
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describeGit('worktree lifecycle', () => {
  test('create → isolated branch + path → list → remove', async () => {
    const wt = await createMissionWorktree(repo, 'm-test1', sha);
    assert.ok(wt.path.includes('m-test1'));
    assert.equal(wt.branch, 'agentloop/m-test1');
    assert.equal(wt.headSha, sha);

    // worktree is a real checkout — file exists there
    const files = git(['ls-files'], wt.path);
    assert.ok(files.includes('file.txt'));

    const listed = await listMissionWorktrees(repo);
    assert.ok(listed.some(w => w.path === wt.path || w.branch === wt.branch));

    await removeMissionWorktree(repo, wt.path, { branch: wt.branch, keepBranch: false });
    const after = await listMissionWorktrees(repo);
    assert.ok(!after.some(w => w.branch === 'agentloop/m-test1'));
  });

  test('second worktree for different mission does not collide', async () => {
    const w1 = await createMissionWorktree(repo, 'm-a', sha);
    const w2 = await createMissionWorktree(repo, 'm-b', sha);
    assert.notEqual(w1.path, w2.path);
    assert.notEqual(w1.branch, w2.branch);
    await removeMissionWorktree(repo, w1.path, { branch: w1.branch, keepBranch: false });
    await removeMissionWorktree(repo, w2.path, { branch: w2.branch, keepBranch: false });
  });

  test('worktree isolation: writes in worktree do not dirty main checkout', async () => {
    const wt = await createMissionWorktree(repo, 'm-iso', sha);
    writeFileSync(join(wt.path, 'worktree-only.txt'), 'x\n');
    const main = await inspectRepo(repo);
    assert.equal(main.dirty, false, 'main checkout must stay clean');
    await removeMissionWorktree(repo, wt.path, { force: true, branch: wt.branch, keepBranch: false });
  });
});

describeGit('git runner', () => {
  test('singleton version diagnostic succeeds with installed Git', async () => {
    assert.match(await gitStdout(['--version'], repo), /^git version /);
  });

  test('version exception rejects appended arguments and other global flags', async () => {
    for (const args of [
      ['--version', 'status'], ['--version', '--help'],
      ['--version', '-c', 'alias.x=!echo'], ['--help'],
      ['-C', repo, 'status'], ['-c', 'alias.x=!echo', 'x']
    ]) {
      await assert.rejects(() => gitSep(args, repo), (error: unknown) =>
        error instanceof GitError && error.message.startsWith('Disallowed git subcommand:'));
    }
  });

  test('gitStdout returns trimmed stdout', async () => {
    assert.equal(await gitStdout(['rev-parse', 'HEAD'], repo), sha);
  });

  test('gitSep separates stdout/stderr', async () => {
    const { stdout } = await gitSep(['status', '--porcelain'], repo);
    assert.equal(stdout.trim(), '');
  });

  test('failing git raises GitError with stderr', async () => {
    await assert.rejects(
      () => gitSep(['rev-parse', '--verify', 'definitely-not-a-ref'], repo),
      GitError
    );
  });

  test('dangerous git subcommands are not in the allowed list', async () => {
    // git-runner filters subcommands — verify a dangerous one is rejected
    await assert.rejects(() => gitSep(['push', 'origin', 'main'], repo));
  });
});
