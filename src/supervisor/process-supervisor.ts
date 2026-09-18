import { spawn, ChildProcess, execFile } from 'child_process';
import { createWriteStream, WriteStream } from 'fs';
import { ensureDir } from '../util/atomic-file.js';
import { dirname } from 'path';
import { redactSecrets, boundTail } from '../util/redact.js';
import { logger } from '../logger.js';
import type { AgentExitKind } from '../types.js';

/**
 * Process supervisor.
 *
 * Every child process in the runtime (agents, validation gates, git helpers
 * that can't use the fast path) goes through here. Guarantees:
 *
 * - argv execution only — `shell: false` always, so no shell injection
 * - bounded in-memory output (ring tail), full output streamed to a size-
 *   limited log file instead of RAM
 * - timeouts enforced with process-tree kill (Windows taskkill /T, POSIX
 *   process-group kill)
 * - cooperative cancellation via AbortSignal
 * - no zombie processes: 'close' awaited, stdio destroyed
 */

export interface SupervisedProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** Bytes of combined output kept in memory for the result tail */
  maxOutputBytes?: number;
  /** Optional file to stream full output into (size-limited) */
  logFile?: string;
  /** Max bytes written to logFile before truncation note */
  maxLogBytes?: number;
  signal?: AbortSignal;
  /** Grace period between SIGTERM and forced kill */
  killGraceMs?: number;
}

export interface SupervisedResult {
  exitKind: AgentExitKind;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outputTail: string;
  outputTruncated: boolean;
  logFile?: string;
  pid?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024; // 64 KiB tail in memory
const DEFAULT_MAX_LOG_BYTES = 16 * 1024 * 1024; // 16 MiB on disk
const DEFAULT_KILL_GRACE_MS = 5000;

/** Kill a process and its whole tree. Never throws. */
export async function killProcessTree(proc: ChildProcess, graceMs = 0): Promise<void> {
  const pid = proc.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    // taskkill /T kills the whole tree; /F forces
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
    return;
  }

  try {
    // Try killing the process group first (we spawn detached on POSIX)
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
  }

  if (graceMs > 0) {
    await new Promise((r) => setTimeout(r, graceMs));
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }
}

/**
 * Run a process under supervision. Resolves with a classified result —
 * never rejects for ordinary process failures (nonzero exit, timeout,
 * cancellation); only rejects for programming errors in options.
 */
export function supervise(opts: SupervisedProcessOptions): Promise<SupervisedResult> {
  if (!opts.command || typeof opts.command !== 'string') {
    return Promise.reject(new Error('supervise: command must be a non-empty string'));
  }
  if (!Array.isArray(opts.args)) {
    return Promise.reject(new Error('supervise: args must be an array'));
  }

  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxLogBytes = opts.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let spawnFailed = false;
    let spawnErrorMessage = '';

    let child: ChildProcess;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        shell: false, // hard rule: argv only, never a shell
        windowsHide: true,
        detached: process.platform !== 'win32' // process group for POSIX kill
      });
    } catch (err) {
      resolve({
        exitKind: 'spawn-error',
        exitCode: null,
        signal: null,
        durationMs: 0,
        outputTail: err instanceof Error ? err.message : String(err),
        outputTruncated: false
      });
      return;
    }

    // ── bounded output capture ──────────────────────────────────────────
    let tail = '';
    let truncated = false;
    let logStream: WriteStream | null = null;
    let logBytesWritten = 0;
    let logTruncated = false;

    if (opts.logFile) {
      try {
        ensureDir(dirname(opts.logFile));
        logStream = createWriteStream(opts.logFile, { flags: 'a' });
      } catch (err) {
        logger.warn('Could not open agent log file', {
          mission: opts.logFile,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const ingest = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      tail += text;
      if (Buffer.byteLength(tail, 'utf-8') > maxOutputBytes) {
        truncated = true;
        tail = boundTail(tail, maxOutputBytes).text;
      }
      if (logStream && !logTruncated) {
        logBytesWritten += chunk.length;
        if (logBytesWritten > maxLogBytes) {
          logTruncated = true;
          logStream.write('\n[agentloop] output truncated: log size limit reached\n');
          logStream.end();
          logStream = null;
        } else {
          logStream.write(chunk);
        }
      }
    };

    child.stdout?.on('data', ingest);
    child.stderr?.on('data', ingest);

    // ── timeout ─────────────────────────────────────────────────────────
    const timeoutId = opts.timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          timedOut = true;
          void killProcessTree(child, killGraceMs);
        }, opts.timeoutMs)
      : null;

    // ── external cancellation ───────────────────────────────────────────
    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      void killProcessTree(child, killGraceMs);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (result: SupervisedResult) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      const done = () => {
        result.outputTail = redactSecrets(result.outputTail);
        result.logFile = opts.logFile;
        result.pid = child.pid;
        resolve(result);
      };
      if (logStream) {
        // Resolve only after the log stream has flushed to disk — callers read
        // the log immediately after supervise() returns.
        const stream = logStream;
        logStream = null;
        let flushed = false;
        const flushTimeout = setTimeout(done, 3000);
        stream.end(() => {
          if (flushed) return;
          flushed = true;
          clearTimeout(flushTimeout);
          done();
        });
      } else {
        done();
      }
    };

    child.on('error', (err) => {
      spawnFailed = true;
      spawnErrorMessage = err.message;
      // 'close' still fires after 'error' — final classification there
    });

    child.on('close', (code, signal) => {
      const durationMs = Date.now() - startedAt;
      let exitKind: AgentExitKind;
      if (spawnFailed) exitKind = 'spawn-error';
      else if (timedOut) exitKind = 'timeout';
      else if (cancelled) exitKind = 'cancelled';
      else exitKind = code === 0 ? 'success' : 'failed';

      finish({
        exitKind,
        exitCode: code,
        signal: signal ?? null,
        durationMs,
        outputTail: spawnFailed ? `spawn error: ${spawnErrorMessage}\n${tail}` : tail,
        outputTruncated: truncated
      });
    });
  });
}
