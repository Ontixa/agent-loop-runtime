import { gitStdout, gitSep } from './git-runner.js';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { ensureDir, writeFileAtomic } from '../util/atomic-file.js';
import { logger } from '../logger.js';

/**
 * Worktree manager.
 *
 * Each mission gets an isolated git worktree under `<repo>/.agentloop/worktrees/<id>`
 * on a dedicated branch `agentloop/<id>`. The `.agentloop/` directory contains a
 * self-ignoring `.gitignore` so runtime state never pollutes `git status`.
 */

export const RUNTIME_DIR = '.agentloop';
export const WORKTREES_DIR = join(RUNTIME_DIR, 'worktrees');

/** Ensure .agentloop exists and is fully git-ignored via a nested .gitignore. */
export function ensureRuntimeDir(repoRoot: string): string {
  const dir = join(repoRoot, RUNTIME_DIR);
  ensureDir(dir);
  ensureDir(join(dir, 'worktrees'));
  ensureDir(join(dir, 'missions'));
  ensureDir(join(dir, 'logs'));
  // A .gitignore containing '*' inside .agentloop ignores the entire directory
  // (including itself) without touching the user's root .gitignore.
  const gitignorePath = join(dir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileAtomic(gitignorePath, '# Agent Loop Runtime state — never commit\n*\n');
  }
  return dir;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  headSha: string;
}

/**
 * Create a mission worktree branched from baseSha.
 * Throws on git failure; caller should have run preflightRepo first.
 */
export async function createMissionWorktree(
  repoRoot: string,
  missionId: string,
  baseSha: string
): Promise<WorktreeInfo> {
  const runtimeDir = ensureRuntimeDir(repoRoot);
  const worktreePath = join(runtimeDir, 'worktrees', missionId);
  const branch = `agentloop/${missionId}`;

  await gitSep(['worktree', 'add', '-b', branch, worktreePath, baseSha], repoRoot);

  const headSha = await gitStdout(['rev-parse', 'HEAD'], worktreePath);
  logger.debug('Mission worktree created', { mission: missionId, worktreePath, branch });

  return { path: resolve(worktreePath), branch, headSha };
}

/**
 * Remove a mission worktree. The mission branch is kept (it holds checkpoints)
 * unless keepBranch=false.
 */
export async function removeMissionWorktree(
  repoRoot: string,
  worktreePath: string,
  opts: { force?: boolean; keepBranch?: boolean; branch?: string } = {}
): Promise<void> {
  const args = ['worktree', 'remove'];
  if (opts.force) args.push('--force');
  args.push(worktreePath);

  try {
    await gitSep(args, repoRoot);
  } catch (err) {
    // If the worktree is already gone, treat as success
    if (existsSync(worktreePath)) throw err;
    logger.debug('Worktree already removed', { worktreePath });
  }

  if (opts.branch && opts.keepBranch === false) {
    try {
      await gitSep(['branch', '-D', opts.branch], repoRoot);
    } catch { /* branch may not exist */ }
  }
}

/** List existing agentloop worktrees for a repo. */
export async function listMissionWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  const out: WorktreeInfo[] = [];
  try {
    const { stdout } = await gitSep(['worktree', 'list', '--porcelain'], repoRoot);
    let current: Partial<WorktreeInfo> = {};
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        current.path = line.slice(9).trim();
      } else if (line.startsWith('HEAD ')) {
        current.headSha = line.slice(5).trim();
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
      } else if (line === '') {
        if (current.path && current.path.includes('.agentloop')) {
          out.push({
            path: current.path!,
            branch: current.branch ?? '',
            headSha: current.headSha ?? ''
          });
        }
        current = {};
      }
    }
  } catch { /* no worktrees */ }
  return out;
}

/** Create a checkpoint commit on the mission branch inside its worktree. */
export async function checkpointCommit(
  worktreePath: string,
  message: string,
  opts: { allowEmpty?: boolean } = {}
): Promise<string | null> {
  // Stage everything except ignored files; .agentloop is self-ignored
  await gitSep(['add', '-A'], worktreePath);

  const { stdout: status } = await gitSep(['status', '--porcelain'], worktreePath);
  const hasChanges = status.trim().length > 0;
  if (!hasChanges && !opts.allowEmpty) return null;

  const commitArgs = ['commit', '-m', message];
  if (!hasChanges) commitArgs.push('--allow-empty');
  await gitSep(commitArgs, worktreePath);

  return gitStdout(['rev-parse', 'HEAD'], worktreePath);
}
