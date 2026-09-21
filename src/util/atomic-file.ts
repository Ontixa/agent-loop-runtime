import {
  writeFileSync, renameSync, mkdirSync, existsSync, readFileSync,
  unlinkSync, openSync, closeSync, writeSync, fsyncSync, statSync
} from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';

/**
 * Atomic file utilities.
 *
 * Mission state must survive crashes at any point — writes go to a temp file
 * in the same directory, are fsync'd, then renamed over the target, which is
 * atomic on both NTFS and POSIX filesystems.
 *
 * Cross-process mutation is serialized by a sibling lock file (created with
 * the exclusive 'wx' flag). A lock whose owner pid is dead — or that has
 * outlived a hard age bound — is treated as stale and broken. This gives the
 * store compare-and-swap semantics on plain filesystems, Windows included.
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

function pidLikelyAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Acquire an exclusive lock file. Retries on contention; breaks locks left
 * behind by dead owners (pid check) or absurdly old locks (age bound) so a
 * crashed writer cannot wedge a mission forever. On Windows an unlink of a
 * file still held open fails with EPERM, which incidentally prevents breaking
 * a live holder's lock.
 */
function acquireLock(lockPath: string, timeoutMs: number, staleMs: number): LockContent {
  ensureDir(dirname(lockPath));
  const me: LockContent = { pid: process.pid, nonce: randomBytes(8).toString('hex'), at: new Date().toISOString() };
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try { writeSync(fd, JSON.stringify(me)); } finally { closeSync(fd); }
      return me;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      // Contended — decide whether the holder is stale.
      try {
        const st = statSync(lockPath);
        const ageMs = Date.now() - st.mtimeMs;
        let holderDead = false;
        if (ageMs > staleMs) {
          try {
            const holder = JSON.parse(readFileSync(lockPath, 'utf-8')) as LockContent;
            holderDead = typeof holder.pid === 'number' && !pidLikelyAlive(holder.pid);
          } catch { holderDead = true; /* unreadable lock → treat as broken */ }
        }
        if (holderDead || ageMs > staleMs * 4) {
          try { unlinkSync(lockPath); } catch { /* live holder on Windows → EPERM → keep waiting */ }
          continue;
        }
      } catch { /* lock vanished between checks → retry immediately */ continue; }

      if (Date.now() > deadline) throw new LockTimeoutError(lockPath);
      const until = Date.now() + 25;
      while (Date.now() < until) { /* spin — locks are held for milliseconds */ }
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
  /** Lock older than this with a dead owner may be broken. Default 30s. */
  staleMs?: number;
}

/**
 * Run `fn` while holding the lock file at `lockPath`. Always releases.
 * Locks guard only the file mutation critical sections — never held across
 * agent invocations or sleeps.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const me = acquireLock(lockPath, opts.timeoutMs ?? 10_000, opts.staleMs ?? 30_000);
  try {
    return fn();
  } finally {
    releaseLock(lockPath, me);
  }
}
