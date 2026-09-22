import {
  writeFileSync, renameSync, mkdirSync, existsSync, readFileSync,
  unlinkSync, openSync, closeSync, writeSync, fsyncSync, statSync
} from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import { performance } from 'node:perf_hooks';

/**
 * Atomic file utilities.
 *
 * Mission state must survive crashes at any point — writes go to a temp file
 * in the same directory, are fsync'd, then renamed over the target, which is
 * atomic on both NTFS and POSIX filesystems.
 *
 * Cross-process mutation is serialized by a sibling lock file (created with
 * the exclusive 'wx' flag). A lock whose owner record carries a PID that is
 * confirmed absent is reclaimed immediately — a dead process cannot still be
 * mid-write, so lock age never delays recovery of a provably dead owner.
 * Unknown or malformed ownership fails closed at any age. Reclamation still
 * has a filesystem check/unlink race; see the threat model.
 */

/** Ensure a directory exists (recursive). */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fault injection (test-only hook)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optional fault injector for persistence-failure tests. When set, it is
 * invoked with ('write' | 'append' | 'rename', path) before the real syscall;
 * throwing from the injector simulates e.g. ENOSPC/disk-full. Production code
 * never sets this — tests do, and must reset it in a finally block.
 */
let writeFaultInjector: ((op: 'write' | 'append' | 'rename', path: string) => void) | null = null;
export function setWriteFaultInjector(fn: typeof writeFaultInjector): void {
  writeFaultInjector = fn;
}
function maybeInjectFault(op: 'write' | 'append' | 'rename', path: string): void {
  if (writeFaultInjector) writeFaultInjector(op, path);
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic writes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically write text to a file: write to a sibling temp file, fsync it,
 * then rename over the destination.
 */
export function writeFileAtomic(filePath: string, data: string, mode?: number): void {
  ensureDir(dirname(filePath));
  const tmp = join(
    dirname(filePath),
    `.${randomBytes(6).toString('hex')}.tmp`
  );
  let fd: number | undefined;
  try {
    maybeInjectFault('write', filePath);
    fd = openSync(tmp, 'w', mode);
    writeSync(fd, data, 0, 'utf-8');
    try { fsyncSync(fd); } catch { /* fsync unsupported (e.g. some virtual fs) — best effort */ }
    closeSync(fd);
    fd = undefined;
    maybeInjectFault('rename', filePath);
    renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

/** Atomically write a JSON-serializable value. */
export function writeJsonAtomic(filePath: string, value: unknown, mode?: number): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2), mode);
}

/** Read + parse JSON; returns undefined if missing or unparseable. */
export function readJsonFile<T = unknown>(filePath: string): T | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

/**
 * Read + parse JSON with error discrimination.
 * 'missing' → file absent; 'corrupt' → present but unparseable (bytes kept
 * verbatim for diagnosis); 'ok' → parsed value.
 */
export function readJsonFileChecked<T = unknown>(
  filePath: string
): { status: 'ok'; value: T } | { status: 'missing'; error?: string } | { status: 'corrupt'; error?: string } {
  if (!existsSync(filePath)) return { status: 'missing' };
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { status: 'corrupt', error: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) as T };
  } catch (err) {
    return { status: 'corrupt', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Append a single line to a file, creating parent dirs as needed.
 * Used for JSONL event logs. Appends of our small bounded lines are atomic
 * enough for the record; a torn final line is detected and skipped on read.
 */
export function appendLine(filePath: string, line: string): void {
  ensureDir(dirname(filePath));
  maybeInjectFault('append', filePath);
  const fd = openSync(filePath, 'a');
  try {
    writeSync(fd, line + '\n', 0, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-process file lock
// ─────────────────────────────────────────────────────────────────────────────

export class LockTimeoutError extends Error {
  constructor(public readonly lockPath: string) {
    super(`Timed out acquiring lock: ${lockPath}`);
    this.name = 'LockTimeoutError';
    Object.setPrototypeOf(this, LockTimeoutError.prototype);
  }
}

interface LockContent { pid: number; nonce: string; at: string }

function deadOwner(raw: string): boolean {
  try {
    const holder = JSON.parse(raw) as Partial<LockContent> | null;
    if (!holder || !Number.isSafeInteger(holder.pid) || holder.pid! <= 0 ||
        typeof holder.nonce !== 'string' || !/^[a-f0-9]{16}$/i.test(holder.nonce)) return false;
    try { process.kill(holder.pid!, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  } catch { return false; }
}

/**
 * Acquire with exclusive creation. A recorded owner pid that is confirmed
 * dead authorizes reclamation at any age; a live or unverifiable owner never
 * does. Descriptors are closed before the callback; exclusion does not rely
 * on Windows open-handle deletion behavior. Identity rereads reduce (but
 * cannot eliminate) concurrent reclamation's unlink race.
 */
function acquireLock(lockPath: string, timeoutMs: number): LockContent {
  ensureDir(dirname(lockPath));
  const me: LockContent = { pid: process.pid, nonce: randomBytes(8).toString('hex'), at: new Date().toISOString() };
  const deadline = performance.now() + timeoutMs;
  let firstAttempt = true;

  for (;;) {
    if (!firstAttempt && performance.now() >= deadline) throw new LockTimeoutError(lockPath);
    firstAttempt = false;
    try {
      const fd = openSync(lockPath, 'wx');
      try { writeSync(fd, JSON.stringify(me)); } finally { closeSync(fd); }
      return me;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      // Contended: a lock whose recorded owner pid is confirmed dead is
      // reclaimed regardless of age — the writer is gone, so waiting staleMs
      // would only stall crash recovery after a mid-section SIGKILL.
      // Malformed records and permission/probe uncertainty never authorize
      // deletion. Every retry reaches the common bounded backoff.
      try {
        const st = statSync(lockPath);
        const raw = readFileSync(lockPath, 'utf-8');
        if (deadOwner(raw)) {
          const latest = readFileSync(lockPath, 'utf-8');
          const current = statSync(lockPath);
          if (latest === raw && st.dev === current.dev && st.ino === current.ino &&
              st.size === current.size && st.mtimeMs === current.mtimeMs && st.ctimeMs === current.ctimeMs &&
              performance.now() < deadline) {
            unlinkSync(lockPath);
          }
        }
      } catch (error) {
        // A vanished candidate is normal contention; persistent filesystem
        // failures surface immediately instead of silently retrying forever.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      if (performance.now() >= deadline) throw new LockTimeoutError(lockPath);
      const until = Math.min(deadline, performance.now() + 25);
      while (performance.now() < until) { /* synchronous short critical-section contention */ }
    }
  }
}

function releaseLock(lockPath: string, me: LockContent): void {
  try {
    const current = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockContent;
    if (current.nonce === me.nonce) unlinkSync(lockPath);
  } catch { /* already gone or replaced — nothing safe to do */ }
}

export interface FileLockOptions {
  /** Max wait to acquire the lock. Default 10s. */
  timeoutMs?: number;
  /**
   * Accepted for compatibility and bounds-validated, but no longer consulted:
   * a lock whose recorded owner pid is confirmed dead is reclaimed
   * immediately — lock age never delays recovery of a provably dead owner.
   * Live or unverifiable owners are never overridden at any age.
   */
  staleMs?: number;
}

/**
 * Run `fn` while holding the lock file at `lockPath`. Always releases.
 * Locks guard only the file mutation critical sections — never held across
 * agent invocations or sleeps.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  if (![timeoutMs, staleMs].every(value => Number.isFinite(value) && value >= 0)) {
    throw new RangeError('Lock timeoutMs and staleMs must be finite nonnegative numbers');
  }
  const me = acquireLock(lockPath, timeoutMs);
  try {
    return fn();
  } finally {
    releaseLock(lockPath, me);
  }
}
