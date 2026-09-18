import { gitStdout, gitSep } from './git-runner.js';
import { existsSync } from 'fs';
import { resolve, sep } from 'path';

/**
 * Repository inspection and pre-flight safety checks.
 *
 * Detects: not-a-repo, unborn HEAD (no commits), detached HEAD, dirty tree,
 * missing remote, branch collisions. Missions call this before allocating
 * worktrees.
 */

export interface RepoStatus {
  isRepo: boolean;
  root?: string;
  headSha?: string;
  branch?: string;       // undefined if detached or unborn
  detached: boolean;
  unborn: boolean;
  dirty: boolean;
  dirtyFiles: string[];  // bounded list
  remote?: string;
  hasRemote: boolean;
}

const MAX_DIRTY_LISTED = 50;

/** Inspect a path's git state. Never throws — isRepo=false covers failures. */
export async function inspectRepo(path: string): Promise<RepoStatus> {
  const status: RepoStatus = {
    isRepo: false,
    detached: false,
    unborn: false,
    dirty: false,
    dirtyFiles: [],
    hasRemote: false
  };

  const abs = resolve(path);
  if (!existsSync(abs)) return status;

  try {
    const root = await gitStdout(['rev-parse', '--show-toplevel'], abs);
    status.isRepo = true;
    status.root = root;
  } catch {
    return status;
  }

  const repoRoot = status.root!;

  // Unborn HEAD: rev-parse --verify HEAD fails when there are no commits
  try {
    status.headSha = await gitStdout(['rev-parse', '--verify', 'HEAD'], repoRoot);
  } catch {
    status.unborn = true;
  }

  // Branch vs detached
  if (!status.unborn) {
    try {
      status.branch = await gitStdout(['symbolic-ref', '--short', 'HEAD'], repoRoot);
    } catch {
      status.detached = true;
      status.branch = 'HEAD';
    }
  } else {
    // unborn branch name (what the first commit would land on)
    status.branch = (await gitStdout(['symbolic-ref', '--short', 'HEAD'], repoRoot).catch(() => 'main')) || 'main';
  }

  // Dirty state
  try {
    const { stdout } = await gitSep(['status', '--porcelain'], repoRoot);
    const lines = stdout.split('\n').filter(l => l.trim().length > 0);
    status.dirty = lines.length > 0;
    status.dirtyFiles = lines.slice(0, MAX_DIRTY_LISTED).map(l => l.slice(3).trim());
  } catch { /* leave defaults */ }

  // Remote (prefer 'origin')
  try {
    const remotes = (await gitStdout(['remote'], repoRoot)).split('\n').filter(Boolean);
    if (remotes.length > 0) {
      status.hasRemote = true;
      status.remote = remotes.includes('origin') ? 'origin' : remotes[0];
    }
  } catch { /* no remotes */ }

  return status;
}

export interface PreflightIssue {
  severity: 'error' | 'warning';
  code:
    | 'not-a-repo'
    | 'unborn-head'
    | 'detached-head'
    | 'dirty-tree'
    | 'branch-collision'
    | 'worktree-path-exists'
    | 'protected-path-present';
  message: string;
}

/**
 * Pre-flight checks for starting a mission in a repository.
 * Errors block preparation; warnings are surfaced but don't stop.
 */
export async function preflightRepo(
  repoPath: string,
  opts: { missionBranch?: string; worktreePath?: string; inPlace?: boolean } = {}
): Promise<{ status: RepoStatus; issues: PreflightIssue[] }> {
  const issues: PreflightIssue[] = [];
  const status = await inspectRepo(repoPath);

  if (!status.isRepo) {
    issues.push({
      severity: 'error',
      code: 'not-a-repo',
      message: `Not a git repository: ${repoPath}. Run 'git init' or choose another path.`
    });
    return { status, issues };
  }

  if (status.unborn) {
    issues.push({
      severity: 'error',
      code: 'unborn-head',
      message: 'Repository has no commits (unborn HEAD). Create an initial commit first.'
    });
  }

  if (status.detached) {
    issues.push({
      severity: 'warning',
      code: 'detached-head',
      message: `Repository is on a detached HEAD at ${status.headSha?.slice(0, 8)}.`
    });
  }

  if (status.dirty) {
    const severity = opts.inPlace ? 'error' : 'warning';
    issues.push({
      severity,
      code: 'dirty-tree',
      message: `Working tree has ${status.dirtyFiles.length}${status.dirtyFiles.length >= MAX_DIRTY_LISTED ? '+' : ''} uncommitted change(s).` +
        (opts.inPlace ? ' In-place missions require a clean tree.' : ' Worktree mode isolates the mission from these changes.')
    });
  }

  if (opts.missionBranch) {
    try {
      await gitStdout(['rev-parse', '--verify', `refs/heads/${opts.missionBranch}`], status.root!);
      issues.push({
        severity: 'error',
        code: 'branch-collision',
        message: `Branch '${opts.missionBranch}' already exists. Choose another mission id or delete it.`
      });
    } catch { /* branch doesn't exist — good */ }
  }

  if (opts.worktreePath && existsSync(opts.worktreePath)) {
    issues.push({
      severity: 'error',
      code: 'worktree-path-exists',
      message: `Worktree path already exists: ${opts.worktreePath}`
    });
  }

  return { status, issues };
}

/** True if `path` is contained inside `root` (lexical check). */
export function isPathInside(root: string, path: string): boolean {
  const r = resolve(root);
  const p = resolve(path);
  if (p === r) return true;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return p.startsWith(prefix);
}

/** Get a short diffstat between baseSha and worktree HEAD. */
export async function diffSummary(repoRoot: string, baseSha: string, ref = 'HEAD'): Promise<string> {
  try {
    const out = await gitStdout(['diff', '--shortstat', baseSha, ref], repoRoot);
    return out.trim() || 'no changes';
  } catch {
    return 'diff unavailable';
  }
}

/** List files changed between baseSha and ref (bounded). */
export async function changedFiles(repoRoot: string, baseSha: string, ref = 'HEAD', max = 500): Promise<string[]> {
  try {
    const out = await gitStdout(['diff', '--name-only', baseSha, ref], repoRoot);
    return out.split('\n').filter(Boolean).slice(0, max);
  } catch {
    return [];
  }
}
