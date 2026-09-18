import { writeFileSync, renameSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';

/**
 * Atomic file utilities.
 *
 * Mission state must survive crashes at any point — writes go to a temp file
 * in the same directory then are renamed over the target, which is atomic on
 * both NTFS and POSIX filesystems.
 */

/** Ensure a directory exists (recursive). */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Atomically write text to a file: write to a sibling temp file, fsync via
 * close, then rename over the destination.
 */
export function writeFileAtomic(filePath: string, data: string): void {
  ensureDir(dirname(filePath));
  const tmp = join(
    dirname(filePath),
    `.${randomBytes(6).toString('hex')}.tmp`
  );
  try {
    writeFileSync(tmp, data, 'utf-8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

/** Atomically write a JSON-serializable value. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));
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
 * Append a single line to a file, creating parent dirs as needed.
 * Used for JSONL event logs. Not atomic by design — appends are atomic
 * enough for line sizes we emit (< a few KB).
 */
export function appendLine(filePath: string, line: string): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, line + '\n', { encoding: 'utf-8', flag: 'a' });
}

