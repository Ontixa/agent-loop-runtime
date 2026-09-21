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
export const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
export interface GitOutputOptions { maxOutputBytes?: number }

/** Incomplete output must never be interpreted as a successful inspection. */
export class GitOutputLimitError extends GitError {
  constructor(args: string[], public readonly limitBytes: number, public readonly observedBytes: number) {
    super(`Git output exceeded aggregate limit of ${limitBytes} bytes; inspection incomplete`, args);
    this.name = 'GitOutputLimitError';
    Object.setPrototypeOf(this, GitOutputLimitError.prototype);
  }
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

/** Run a git command. Throws GitError on failure or disallowed subcommand. */
export async function git(
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  output: GitOutputOptions = {}
): Promise<GitRunResult> {
  return gitSep(args, cwd, timeoutMs, output);
}

/** Run git and return stdout trimmed; throws GitError. */
export async function gitStdout(args: string[], cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS, output: GitOutputOptions = {}): Promise<string> {
  const { stdout } = await gitSep(args, cwd, timeoutMs, output);
  return stdout.trim();
}

/**
 * Git execution with separated stdout/stderr streams.
 * Uses argv spawn directly (no shell) with a hard timeout.
 */
export async function gitSep(
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  output: GitOutputOptions = {}
): Promise<GitRunResult> {
  const limit = output.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_GIT_OUTPUT_BYTES) {
    throw new RangeError(`maxOutputBytes must be a positive safe integer <= ${MAX_GIT_OUTPUT_BYTES}`);
  }
  const subcommand = args[0];
  // Doctor's read-only version probe is an exact exception, not permission
  // to forward arbitrary global options or appended commands.
  const versionProbe = args.length === 1 && subcommand === '--version';
  if (!versionProbe && (!subcommand || !ALLOWED_SUBCOMMANDS.has(subcommand))) {
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

    let stdout: Buffer[] = [];
    let stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stdout = []; stderr = [];
      try { proc.kill('SIGTERM'); } catch { /* promise still rejects and retention stays stopped */ }
      reject(new GitError(`git ${args.join(' ')} timed out after ${timeoutMs}ms`, args));
    }, timeoutMs);

    const retain = (stream: 'stdout' | 'stderr', d: Buffer) => {
      if (settled) return;
      bytes += d.length;
      if (bytes > limit) {
        settled = true;
        clearTimeout(timer);
        stdout = []; stderr = [];
        // Only the direct Git child is signalled; no process-tree guarantee.
        try { proc.kill('SIGTERM'); } catch { /* retention is already stopped */ }
        reject(new GitOutputLimitError(args, limit, bytes));
        return;
      }
      (stream === 'stdout' ? stdout : stderr).push(d);
    };
    proc.stdout?.on('data', (d: Buffer) => retain('stdout', d));
    proc.stderr?.on('data', (d: Buffer) => retain('stderr', d));

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout = []; stderr = [];
      reject(new GitError(`git spawn failed: ${err.message}`, args));
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      stdout = []; stderr = [];
      if (code === 0) {
        resolve({ stdout: stdoutText, stderr: stderrText });
      } else {
        reject(new GitError(
          `git ${args.join(' ')} failed (exit ${code}): ${stderrText.trim().slice(0, 500)}`,
          args, code, stderrText
        ));
      }
    });
  });
}

/** Convenience: run git, return trimmed stdout, or null on failure. */
export async function gitTry(args: string[], cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS, output: GitOutputOptions = {}): Promise<string | null> {
  try {
    return await gitStdout(args, cwd, timeoutMs, output);
  } catch (err) {
    if (err instanceof GitOutputLimitError) throw err;
    logger.debug(`git ${args[0]} failed (non-fatal)`, {
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
