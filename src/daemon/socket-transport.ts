import { existsSync, unlinkSync } from 'fs';
import { isAbsolute } from 'path';
import { connect } from 'net';

/**
 * Socket transport for the control API — a Unix domain socket (POSIX) or a
 * Windows named pipe instead of a TCP host:port bind.
 *
 * Why it exists: a socket endpoint removes the API from the network surface
 * entirely (no port scan, no DNS rebinding path). It does NOT replace the
 * bearer token — every route still requires it — because a socket/pipe is
 * reachable by any process running as a local user. The token remains the
 * documented boundary (docs/threat-model.md); the socket narrows exposure.
 *
 * Platform shapes:
 * - POSIX: an absolute filesystem path, e.g. `/run/agentloop/control.sock`.
 *   Bounded by sun_path (~104–108 bytes); validated conservatively below.
 * - Windows: a named-pipe path `\\.\pipe\<name>` (or `\\?\pipe\<name>`).
 *   Pipe names are not filesystem objects.
 */

/** Conservative cross-platform POSIX socket-path bound (sun_path is 104–108). */
const MAX_POSIX_SOCKET_PATH = 103;
const WINDOWS_PIPE_PREFIXES = ['\\\\.\\pipe\\', '\\\\?\\pipe\\'];

/**
 * Validate a configured socket endpoint. Returns an error string, or null
 * when the path is usable on `platform` (defaults to the current platform).
 */
export function socketPathError(socketPath: unknown, platform: NodeJS.Platform = process.platform): string | null {
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    return 'daemon.socketPath must be a non-empty string';
  }
  for (const ch of socketPath) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      return 'daemon.socketPath must not contain control characters';
    }
  }
  if (platform === 'win32') {
    const lower = socketPath.toLowerCase();
    if (!WINDOWS_PIPE_PREFIXES.some(p => lower.startsWith(p))) {
      return 'daemon.socketPath on Windows must be a named pipe (\\\\.\\pipe\\<name>)';
    }
    if (socketPath.length === WINDOWS_PIPE_PREFIXES[0].length) {
      return 'daemon.socketPath pipe name must not be empty';
    }
    return null;
  }
  if (!isAbsolute(socketPath)) {
    return 'daemon.socketPath must be an absolute path on this platform';
  }
  if (socketPath.length > MAX_POSIX_SOCKET_PATH) {
    return `daemon.socketPath exceeds ${MAX_POSIX_SOCKET_PATH} characters (sun_path limit)`;
  }
  return null;
}

/**
 * True when a client can connect — i.e. a live server already holds the
 * endpoint. A probe that neither connects nor errors within PROBE_MS is
 * treated as REACHABLE (fail closed): on Windows a saturated pipe can stall
 * connect() while the endpoint is still owned, and guessing "free" there
 * would silently multi-instance the control surface.
 */
const PROBE_MS = 2000;

function probeReachable(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const done = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      probe.destroy();
      resolve(reachable);
    };
    const probe = connect({ path: socketPath }, () => done(true));
    probe.setTimeout(PROBE_MS, () => done(true));
    probe.once('error', () => done(false));
  });
}

/**
 * Claim a socket endpoint before binding.
 *
 * - A live peer (another daemon, or any process owning the endpoint) is a
 *   hard error — never steal or multi-instance the control surface. This
 *   matters most on Windows, where named pipes silently allow multiple
 *   server instances on one name; the probe is the only "already serving"
 *   signal there.
 * - A stale POSIX socket file left by a crashed daemon is removed so the
 *   bind succeeds — connect() to it fails (ECONNREFUSED), proving no live
 *   owner.
 */
export async function claimSocketPath(socketPath: string): Promise<void> {
  if (await probeReachable(socketPath)) {
    throw new Error(`control API socket already in use: ${socketPath}`);
  }
  if (process.platform !== 'win32' && existsSync(socketPath)) {
    unlinkSync(socketPath); // stale socket file from a dead daemon
  }
}

/** Best-effort removal of a socket file we created (POSIX; no-op on Windows). */
export function releaseSocketPath(socketPath: string): void {
  if (process.platform === 'win32') return;
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch { /* best effort — the path is inside operator-owned state */ }
}
