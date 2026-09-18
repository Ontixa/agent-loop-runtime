import { MissionStore } from '../mission/mission-store.js';
import { MissionState } from '../types.js';
import { isActiveState } from '../mission/state-machine.js';
import type { Mission } from '../types.js';
import { logger } from '../logger.js';

/**
 * Crash recovery.
 *
 * A mission whose runner disappeared mid-flight is marked `stale` — never
 * silently resumed, because we can't know whether an in-flight action
 * (e.g. an agent edit) actually happened. Recovery re-prepares the mission
 * and re-drives from the last checkpointed state.
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
 * it. Reuses the existing worktree if it still exists — the mission branch and
 * checkpoints preserve all committed work.
 */
export async function recoverMission(store: MissionStore, missionId: string): Promise<Mission> {
  const mission = store.mustLoad(missionId);

  if (![MissionState.STALE, MissionState.BLOCKED, MissionState.PAUSED,
        MissionState.WAITING_FOR_APPROVAL, MissionState.PREPARED].includes(mission.state)) {
    throw new Error(`Mission ${missionId} is ${mission.state} — not recoverable`);
  }

  // Verify the worktree still exists; if gone, prepare will recreate it
  const { existsSync } = await import('fs');
  const worktreeGone = mission.workspace.mode === 'worktree' && !existsSync(mission.workspace.path);

  if (mission.state === MissionState.WAITING_FOR_APPROVAL) {
    // Approvals persist — recheck whether decisions were made while we were down
    const { loadApprovals } = await import('../policy/approvals.js');
    mission.approvals = loadApprovals(store.dir(mission.id));
  }

  if (mission.state !== MissionState.PREPARED) {
    store.transition(mission, MissionState.PREPARED,
      worktreeGone ? 'recovered: worktree missing, will recreate' : 'recovered for resume');
  }

  if (worktreeGone) {
    const { createMissionWorktree } = await import('../git/worktree-manager.js');
    // Recreate from last checkpoint (preserves committed work) or base
    const sha = mission.checkpoints.at(-1)?.sha ?? mission.repository.baseSha;
    const wt = await createMissionWorktree(mission.repository.path, mission.id, sha);
    mission.workspace.path = wt.path;
    mission.workspace.branch = wt.branch;
    store.save(mission);
  }

  return mission;
}
