import { logger } from '../logger.js';

/**
 * Git execution layer.
 *
 * All git operations run through argv execution (no shell), a fixed timeout,
 * and a whitelist of allowed subcommands. Output is bounded.
 */

export class GitError extends Error {
  public readonly args: string[];
  public readonly exitCode: number | null;
  public readonly stderr: string;

  constructor(message: string, args: string[], exitCode: number | null = null, stderr = '') {
    super(message);
    this.name = 'GitError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
    Object.setPrototypeOf(this, GitError.prototype);
  }
}

/**
 * Git subcommands the runtime is allowed to execute. Mutation of remote state
 * (push) goes through this list too — callers must enforce policy/approvals
 * before invoking it.
 */
const ALLOWED_SUBCOMMANDS = new Set([
  'add', 'branch', 'cat-file', 'check-ignore', 'checkout', 'commit',
  'config', 'diff', 'diff-tree', 'fetch', 'for-each-ref', 'init', 'log',
  'ls-files', 'ls-remote', 'merge-base', 'mv', 'push', 'remote', 'rev-list',
  'rev-parse', 'rm', 'show', 'status', 'symbolic-ref', 'tag', 'worktree'
]);

const DEFAULT_TIMEOUT_MS = 60_000;

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

/** Run a git command. Throws GitError on failure or disallowed subcommand. */
export async function git(
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<GitRunResult> {
  return gitSep(args, cwd, timeoutMs);
}

/** Run git and return stdout trimmed; throws GitError. */
export async function gitStdout(args: string[], cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await gitSep(args, cwd, timeoutMs);
  return stdout.trim();
}

/**
 * Git execution with separated stdout/stderr streams.
 * Uses argv spawn directly (no shell) with a hard timeout.
 */
export async function gitSep(
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<GitRunResult> {
  const subcommand = args[0];
  if (!subcommand || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new GitError(
      `Disallowed git subcommand: "${subcommand ?? ''}". Allowed: ${[...ALLOWED_SUBCOMMANDS].join(', ')}`,
      args
    );
  }

  const { spawn } = await import('child_process');
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('git', args, { cwd, shell: false, windowsHide: true });
    } catch (err) {
      reject(new GitError(`git spawn failed: ${err instanceof Error ? err.message : String(err)}`, args));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      reject(new GitError(`git ${args.join(' ')} timed out after ${timeoutMs}ms`, args));
    }, timeoutMs);

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GitError(`git spawn failed: ${err.message}`, args));
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new GitError(
          `git ${args.join(' ')} failed (exit ${code}): ${stderr.trim().slice(0, 500)}`,
          args, code, stderr
        ));
      }
    });
  });
}

/** Convenience: run git, return trimmed stdout, or null on failure. */
export async function gitTry(args: string[], cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  try {
    return await gitStdout(args, cwd, timeoutMs);
  } catch (err) {
    logger.debug(`git ${args[0]} failed (non-fatal)`, {
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
