import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { MissionStore } from '../mission/mission-store.js';
import { MissionState, TaskStatus } from '../types.js';
import { isActiveState } from '../mission/state-machine.js';
import type { Mission } from '../types.js';
import { loadApprovals, saveApprovals } from '../policy/approvals.js';
import { logger } from '../logger.js';

/**
 * Crash recovery.
 *
 * A mission whose runner disappeared mid-flight is marked `stale` — never
 * silently resumed, because we can't know whether an in-flight action
 * (e.g. an agent edit) actually happened. Recovery performs an AUDIT:
 *
 * - tasks left `running` are returned to `pending` with `interrupted: true`
 *   — their outcome is UNKNOWN; the workspace may hold partial edits
 * - open passes (no finishedAt) are marked `interrupted`
 * - recorded agent pids that are still alive are orphan processes we spawned
 *   → they are reaped (with a start-time sanity check so a reused pid owned
 *   by someone else is never killed)
 * - a missing worktree with checkpointed work → recreated from the last
 *   checkpoint; a missing worktree where work may never have been committed
 *   → `lostWorkSuspected` — the operator is told, not lied to
 * - pending approvals get a fresh wait window (the dead runner was not
 *   "waiting" while it was gone)
 *
 * The audit result is persisted on `mission.lastRecovery` and emitted as a
 * `recovery_audit` event.
 */

const STALE_AFTER_MS = 45_000; // 3+ missed heartbeats (heartbeat is 10s)

/** Check if a pid is alive on this machine. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort process start time (ms since epoch) — used to guard against
 * pid reuse: we only kill a recorded pid if the process started around the
 * same time as our recorded agent spawn. Returns null when unknown.
 */
export function processStartTimeMs(pid: number): number | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString("o")`],
        { windowsHide: true, timeout: 10_000 }
      ).toString().trim();
      const t = Date.parse(out);
      return Number.isFinite(t) ? t : null;
    }
    // POSIX: /proc/<pid>/stat field 22 = starttime in jiffies after boot
    const stat = readFileSyncSafe(`/proc/${pid}/stat`);
    if (!stat) return null;
    const fields = stat.split(' ');
    const startJiffies = Number(fields[21]);
    if (!Number.isFinite(startJiffies)) return null;
    const hz = 100; // USER_HZ is 100 on Linux/standard configs
    const btimeLine = readFileSyncSafe('/proc/stat')
      ?.split('\n').find(l => l.startsWith('btime '));
    const btime = btimeLine ? Number(btimeLine.split(/\s+/)[1]) : null;
    if (!btime) return null;
    return (btime + startJiffies / hz) * 1000;
  } catch {
    return null;
  }
}

function readFileSyncSafe(path: string): string | null {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}

/**
 * Kill a recorded agent pid only if we can prove it is the process we
 * spawned: the pid is alive AND its start time is at-or-after the recorded
 * spawn time (±clock skew). If the start time is unavailable we do NOT kill —
 * a reused pid may belong to an unrelated process, and killing strangers is
 * worse than leaking an orphan the operator can inspect.
 */
export function reapIfOurs(pid: number, spawnedAtMs: number, skewMs = 60_000): 'killed' | 'not-ours' | 'unknown' {
  if (!pidAlive(pid)) return 'not-ours';
  const start = processStartTimeMs(pid);
  if (start === null) return 'unknown';
  if (start < spawnedAtMs - skewMs) return 'not-ours';
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 30_000 });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
    return 'killed';
  } catch {
    try { process.kill(pid, 'SIGKILL'); return 'killed'; } catch { return 'unknown'; }
  }
}

/**
 * Detect stale missions in a repo: runner dead or heartbeat expired while in
 * an active state. Marks them STALE (persisted) and returns them.
 */
export async function detectStaleMissions(store: MissionStore, now = Date.now()): Promise<Mission[]> {
  const stale: Mission[] = [];
  for (const m of store.listActive()) {
    if (!isActiveState(m.state) && m.state !== MissionState.WAITING_FOR_APPROVAL) continue;
    const hb = m.runner?.heartbeatAt ? Date.parse(m.runner.heartbeatAt) : undefined;
    const pidDead = m.runner?.pid ? !pidAlive(m.runner.pid) : true;
    const heartbeatExpired = hb ? now - hb > STALE_AFTER_MS : true;

    // If our own pid owns it and we're scanning from the same process, skip
    if (m.runner?.pid === process.pid) continue;

    if (pidDead || heartbeatExpired) {
      try {
        store.transition(m, MissionState.STALE,
          `runner lost: pid ${m.runner?.pid ?? '?'} ${pidDead ? 'dead' : 'heartbeat expired'}`);
        store.emit(m.id, 'mission_stale', {
          runnerPid: m.runner?.pid, pidDead, heartbeatExpired
        });
        stale.push(m);
      } catch (err) {
        logger.warn('Failed to mark mission stale', {
          mission: m.id,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }
  return stale;
}

/**
 * Recover a stale/blocked/paused mission to PREPARED so a runner can re-drive
 * it. Performs the recovery audit described above and persists it.
 */
export async function recoverMission(store: MissionStore, missionId: string): Promise<Mission> {
  let mission = store.mustLoad(missionId);

  // A crashed runner leaves the mission in an ACTIVE state on disk. Before
  // refusing, check the owner: dead pid or expired heartbeat → mark STALE and
  // recover; a LIVE owner means a real runner still drives it — never recover
  // underneath it.
  if (isActiveState(mission.state) || mission.state === MissionState.WAITING_FOR_APPROVAL) {
    const hb = mission.runner?.heartbeatAt ? Date.parse(mission.runner.heartbeatAt) : undefined;
    const pidDead = mission.runner?.pid ? !pidAlive(mission.runner.pid) : true;
    const heartbeatExpired = hb ? Date.now() - hb > STALE_AFTER_MS : true;
    if (mission.runner?.pid === process.pid && !heartbeatExpired) {
      throw new Error(`Mission ${missionId} is owned by this live process — cannot recover underneath it`);
    }
    if (!pidDead && !heartbeatExpired) {
      throw new Error(`Mission ${missionId} has a live runner (pid ${mission.runner?.pid}) — not recoverable`);
    }
    mission = store.transition(mission, MissionState.STALE,
      `runner lost: pid ${mission.runner?.pid ?? '?'} ${pidDead ? 'dead' : 'heartbeat expired'}`);
    store.emit(mission.id, 'mission_stale', {
      runnerPid: mission.runner?.pid, pidDead, heartbeatExpired
    });
  }

  if (![MissionState.STALE, MissionState.BLOCKED, MissionState.PAUSED,
        MissionState.WAITING_FOR_APPROVAL, MissionState.PREPARED].includes(mission.state)) {
    throw new Error(`Mission ${missionId} is ${mission.state} — not recoverable`);
  }

  const from = mission.state;
  const interruptedTasks: string[] = [];
  const interruptedPasses: number[] = [];
  const orphanedPids: number[] = [];

  // ── audit: tasks stuck 'running' had unknown outcomes ─────────────────
  store.mutate(missionId, fresh => {
    for (const t of fresh.tasks) {
      if (t.status === TaskStatus.RUNNING) {
        t.status = TaskStatus.PENDING;
        t.interrupted = true;
        t.result = 'interrupted: runner lost before outcome was recorded';
        t.startedAt = undefined;
        interruptedTasks.push(t.id);
      }
    }
    for (const p of fresh.passes) {
      if (!p.finishedAt) {
        p.interrupted = true;
        p.note = p.note ?? 'runner lost before outcome was recorded';
        interruptedPasses.push(p.n);
      }
    }
  });

  // ── audit: reap orphaned agent processes we recorded ──────────────────
  for (const p of mission.passes) {
    if (p.agentPid && p.startedAt) {
      const spawnedAt = Date.parse(p.startedAt);
      const outcome = reapIfOurs(p.agentPid, Number.isFinite(spawnedAt) ? spawnedAt : 0);
      if (outcome === 'killed') {
        orphanedPids.push(p.agentPid);
        store.emit(missionId, 'orphan_process_killed', { pid: p.agentPid, pass: p.n });
      }
      // 'unknown'/'not-ours' → left alone deliberately; logged in the audit
    }
  }

  // ── worktree check + lost-work honesty ────────────────────────────────
  const worktreeGone = mission.workspace.mode === 'worktree' && !existsSync(mission.workspace.path);
  // Work may have existed that was never checkpointed if the newest
  // interrupted pass has no checkpointSha.
  const lastInterruptedPass = mission.passes.filter(p => interruptedPasses.includes(p.n)).at(-1);
  const lostWorkSuspected = worktreeGone &&
    lastInterruptedPass !== undefined && !lastInterruptedPass.checkpointSha;

  // ── approval ledger: pending approvals get a fresh wait window ────────
  // The dead runner was not "waiting" while it was gone — restarting the
  // clock is honest and prevents instant re-timeout on resume.
  const approvals = loadApprovals(store.dir(mission.id));
  const nowIso = new Date().toISOString();
  let approvalsReset = 0;
  for (const a of approvals) {
    if (a.status === 'pending') {
      a.requestedAt = nowIso;
      approvalsReset++;
    }
  }
  if (approvalsReset > 0) saveApprovals(store.dir(mission.id), mission.id, approvals);

  // ── persist audit + transition ────────────────────────────────────────
  store.mutate(missionId, fresh => {
    fresh.lastRecovery = {
      at: nowIso,
      from,
      interruptedTasks,
      interruptedPasses,
      orphanedPids,
      worktreeRecreated: false,
      lostWorkSuspected
    };
    fresh.approvals = loadApprovals(store.dir(mission.id));
  });

  store.emit(missionId, 'recovery_audit', {
    from,
    interruptedTasks,
    interruptedPasses,
    orphanedPids,
    worktreeGone,
    lostWorkSuspected
  });

  if (mission.state !== MissionState.PREPARED) {
    store.transition(mission, MissionState.PREPARED,
      worktreeGone
        ? (lostWorkSuspected
            ? 'recovered: worktree missing and uncommitted work may be lost — recreated from last checkpoint'
            : 'recovered: worktree missing, will recreate')
        : 'recovered for resume');
  }

  if (worktreeGone) {
    const { createMissionWorktree } = await import('../git/worktree-manager.js');
    // Recreate from last checkpoint (preserves committed work) or base
    const sha = mission.checkpoints.at(-1)?.sha ?? mission.repository.baseSha;
    const wt = await createMissionWorktree(mission.repository.path, mission.id, sha);
    store.mutate(missionId, fresh => {
      fresh.workspace.path = wt.path;
      fresh.workspace.branch = wt.branch;
      if (fresh.lastRecovery) fresh.lastRecovery.worktreeRecreated = true;
    });
  }

  return store.mustLoad(missionId);
}
