import { gitStdout, gitSep, GitError, GitOutputLimitError, type GitOutputOptions } from './git-runner.js';
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
  isRepo: boolean | null;
  inspectionComplete: boolean;
  inspectionError?: { stage: string; message: string };
  root?: string;
  headSha?: string;
  branch?: string;       // undefined if detached or unborn
  detached: boolean | null;
  unborn: boolean | null;
  dirty: boolean | null;
  dirtyFiles: string[];  // bounded list
  remote?: string;
  hasRemote: boolean | null;
}

const MAX_DIRTY_LISTED = 50;

/** Inspect git state. Output overflow is explicit incomplete evidence, not a negative fact. */
export async function inspectRepo(path: string, output: GitOutputOptions = {}): Promise<RepoStatus> {
  const status: RepoStatus = {
    isRepo: false,
    inspectionComplete: true,
    detached: false,
    unborn: false,
    dirty: false,
    dirtyFiles: [],
    hasRemote: false
  };

  const abs = resolve(path);
  if (!existsSync(abs)) return status;
  const incomplete = (error: unknown, stage: string, key: 'isRepo' | 'unborn' | 'detached' | 'dirty' | 'hasRemote') => {
    if (!(error instanceof GitOutputLimitError)) return false;
    status.inspectionComplete = false;
    status.inspectionError = { stage, message: error.message };
    const fields = ['isRepo', 'unborn', 'detached', 'dirty', 'hasRemote'] as const;
    for (const field of fields.slice(fields.indexOf(key))) status[field] = null;
    return true;
  };

  try {
    const root = await gitStdout(['rev-parse', '--show-toplevel'], abs, undefined, output);
    status.isRepo = true;
    status.root = root;
  } catch (error) {
    incomplete(error, 'root', 'isRepo');
    return status;
  }

  const repoRoot = status.root!;

  // Unborn HEAD: rev-parse --verify HEAD fails when there are no commits
  try {
    status.headSha = await gitStdout(['rev-parse', '--verify', 'HEAD'], repoRoot, undefined, output);
  } catch (error) {
    if (incomplete(error, 'head', 'unborn')) return status;
    status.unborn = true;
  }

  // Branch vs detached
  if (!status.unborn) {
    try {
      status.branch = await gitStdout(['symbolic-ref', '--short', 'HEAD'], repoRoot, undefined, output);
    } catch (error) {
      if (incomplete(error, 'branch', 'detached')) return status;
      status.detached = true;
      status.branch = 'HEAD';
    }
  } else {
    // unborn branch name (what the first commit would land on)
    try {
      status.branch = (await gitStdout(['symbolic-ref', '--short', 'HEAD'], repoRoot, undefined, output)) || 'main';
    } catch (error) {
      if (incomplete(error, 'branch', 'detached')) return status;
      status.branch = 'main';
    }
  }

  // Dirty state
  try {
    const { stdout } = await gitSep(['status', '--porcelain'], repoRoot, undefined, output);
    const lines = stdout.split('\n').filter(l => l.trim().length > 0);
    status.dirty = lines.length > 0;
    status.dirtyFiles = lines.slice(0, MAX_DIRTY_LISTED).map(l => l.slice(3).trim());
  } catch (error) {
    if (incomplete(error, 'status', 'dirty')) return status;
  }

  // Remote (prefer 'origin')
  try {
    const remotes = (await gitStdout(['remote'], repoRoot, undefined, output)).split('\n').filter(Boolean);
    if (remotes.length > 0) {
      status.hasRemote = true;
      status.remote = remotes.includes('origin') ? 'origin' : remotes[0];
    }
  } catch (error) {
    incomplete(error, 'remote', 'hasRemote');
  }

  return status;
}

export interface PreflightIssue {
  severity: 'error' | 'warning';
  code:
    | 'not-a-repo'
    | 'inspection-incomplete'
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
  opts: { missionBranch?: string; worktreePath?: string; inPlace?: boolean } = {},
  output: GitOutputOptions = {}
): Promise<{ status: RepoStatus; issues: PreflightIssue[] }> {
  const issues: PreflightIssue[] = [];
  const status = await inspectRepo(repoPath, output);

  if (!status.inspectionComplete) {
    issues.push({ severity: 'error', code: 'inspection-incomplete', message: `Repository inspection incomplete (${status.inspectionError?.stage}): ${status.inspectionError?.message}` });
    return { status, issues };
  }

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
      await gitStdout(['rev-parse', '--verify', `refs/heads/${opts.missionBranch}`], status.root!, undefined, output);
      issues.push({
        severity: 'error',
        code: 'branch-collision',
        message: `Branch '${opts.missionBranch}' already exists. Choose another mission id or delete it.`
      });
    } catch (error) {
      if (error instanceof GitOutputLimitError) {
        status.inspectionComplete = false;
        status.inspectionError = { stage: 'branch-collision', message: error.message };
        issues.push({ severity: 'error', code: 'inspection-incomplete', message: error.message });
      }
    }
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
  } catch (error) {
    if (error instanceof GitOutputLimitError) throw error;
    return 'diff unavailable';
  }
}

/** Complete textual path list for hard review; failures are never an empty success. */
export async function changedFilesStrict(repoRoot: string, baseSha: string, ref = 'HEAD'): Promise<string[]> {
  const args = ['diff', '--name-only', '-z', '--no-renames', baseSha, ref, '--'];
  const { stdout } = await gitSep(args, repoRoot);
  if (stdout === '') return [];
  if (!stdout.endsWith('\0')) throw new GitError('Incomplete Git path-list framing', args);
  const paths = stdout.slice(0, -1).split('\0');
  if (paths.some(path => path === '')) throw new GitError('Invalid empty Git path record', args);
  return paths;
}

/** Display-oriented bounded list. Do not use for hard review or authorization. */
export async function changedFiles(repoRoot: string, baseSha: string, ref = 'HEAD', max = 500): Promise<string[]> {
  try {
    const out = await gitStdout(['diff', '--name-only', baseSha, ref], repoRoot);
    return out.split('\n').filter(Boolean).slice(0, max);
  } catch (error) {
    if (error instanceof GitOutputLimitError) throw error;
    return [];
  }
}
