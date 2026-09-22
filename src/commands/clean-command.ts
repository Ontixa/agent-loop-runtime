import { existsSync } from 'fs';
import { basename, join, resolve } from 'path';
import chalk from 'chalk';
import { MissionStore } from '../mission/mission-store.js';
import { isTerminal } from '../mission/state-machine.js';
import { listMissionWorktrees, removeMissionWorktree, WORKTREES_DIR } from '../git/worktree-manager.js';
import { gitSep, gitTry, GitOutputLimitError } from '../git/git-runner.js';
import { inspectRepo, isPathInside } from '../git/repo-inspector.js';
import type { Mission } from '../types.js';

/**
 * `agentloop clean` — garbage-collect mission workspaces.
 *
 * Missions run in `.agentloop/worktrees/<id>` on branch `agentloop/<id>` and
 * keep both after finishing so operators can inspect or merge the work. Over
 * time those accumulate; `clean` removes them — conservatively:
 *
 * - only missions in TERMINAL states (completed/failed/cancelled) are eligible;
 *   anything still resumable is never touched
 * - a recorded workspace path outside `.agentloop/worktrees/` is refused —
 *   mission records are data, not proof a path is safe to delete
 * - a worktree with uncommitted changes is skipped unless `--force`
 * - the `agentloop/<id>` branch is deleted only when its commits are already
 *   reachable from the base it was cut from (or HEAD) — unmerged work is kept
 *   unless `--force`; `--keep-branch` never deletes branches
 * - worktrees on disk with no mission record, or a corrupt/non-terminal one,
 *   are reported as skipped — never removed
 * - `--older-than <dur>` gates on when the mission reached its terminal state
 *
 * Mission history under `.agentloop/missions/<id>/` is never deleted — GC
 * reclaims checkouts and merged branches, not the audit record.
 */

export interface CleanItem {
  missionId: string;
  state: string;
  /** When the mission reached its terminal state (ISO), if known */
  terminalAt: string | null;
  worktreePath: string;
  /** Worktree was present and removed (or would be, in dry-run) */
  removedWorktree: boolean;
  branch?: string;
  /** Mission branch deleted (or would be, in dry-run) */
  deletedBranch: boolean;
  notes: string[];
}

export interface CleanSkipped {
  missionId?: string;
  worktreePath?: string;
  reason: string;
}

export interface CleanReport {
  repoRoot: string;
  dryRun: boolean;
  cleaned: CleanItem[];
  skipped: CleanSkipped[];
  errors: string[];
}

const DURATION_UNITS_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000
};

/**
 * Parse a duration like `500ms`, `90s`, `45m`, `24h`, `7d`, `2w` into
 * milliseconds. A bare number means days. Throws on malformed input.
 */
export function parseDurationMs(input: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/i.exec(input);
  if (!match) {
    throw new Error(`Invalid duration '${input}' — use e.g. 90m, 24h, 7d, 2w (a bare number means days)`);
  }
  const ms = Number(match[1]) * DURATION_UNITS_MS[(match[2] ?? 'd').toLowerCase()];
  if (!Number.isFinite(ms)) throw new Error(`Invalid duration '${input}'`);
  return ms;
}

/** When the mission reached its terminal state (ms since epoch); 0 = unknown. */
function terminalAtMs(m: Mission): number {
  const terminalEntry = m.stateHistory?.filter(h => isTerminal(h.state)).at(-1)?.at;
  const parsed = Date.parse(terminalEntry ?? m.outcome?.at ?? m.updatedAt ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The only branch name a mission workspace may legitimately own. */
function missionBranch(missionId: string): string {
  return `agentloop/${missionId}`;
}

async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  return (await gitTry(['rev-parse', '--verify', '--quiet', ref], repoRoot)) !== null;
}

/**
 * Return the first base ref that already contains the branch, i.e. deleting
 * the branch loses no commits. Unknown/failed checks mean "not merged" —
 * keeping a branch is always the safe direction.
 */
async function mergedInto(repoRoot: string, branch: string, bases: Array<string | undefined>): Promise<string | null> {
  for (const base of bases) {
    if (!base) continue;
    try {
      await gitSep(['merge-base', '--is-ancestor', branch, base], repoRoot);
      return base;
    } catch (err) {
      if (err instanceof GitOutputLimitError) throw err;
      // exit 1 = not an ancestor of this base; ref errors = try the next base
    }
  }
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Inspect one repository and remove (or, in dry-run, only report) the
 * worktrees/branches of terminal missions. Per-mission failures are recorded
 * in the report and never stop the sweep; structural problems (not a repo,
 * incomplete inspection) throw before anything is touched.
 */
export async function cleanRepo(repoRootInput: string, opts: {
  dryRun?: boolean;
  force?: boolean;
  keepBranch?: boolean;
  olderThanMs?: number;
} = {}): Promise<CleanReport> {
  const repoRoot = resolve(repoRootInput);
  const report: CleanReport = {
    repoRoot, dryRun: opts.dryRun === true, cleaned: [], skipped: [], errors: []
  };

  // Fail closed: GC needs complete repository evidence before deleting.
  const status = await inspectRepo(repoRoot);
  if (!status.inspectionComplete) {
    throw new Error(`Repository inspection incomplete (${status.inspectionError?.stage}): ${status.inspectionError?.message} — refusing to clean`);
  }
  if (!status.isRepo) {
    throw new Error(`Not a git repository: ${repoRoot}`);
  }

  const store = new MissionStore(repoRoot);
  const worktreesRoot = join(repoRoot, WORKTREES_DIR);
  const cutoffMs = opts.olderThanMs !== undefined ? Date.now() - opts.olderThanMs : undefined;

  const all = store.list();
  const byId = new Map(all.map(m => [m.id, m]));
  const corruptIds = new Set(store.listCorrupt().map(c => c.id));
  const handledPaths = new Set<string>();

  for (const m of all) {
    if (!isTerminal(m.state) || m.workspace.mode !== 'worktree') continue;

    const wtPath = m.workspace.path;
    if (!wtPath) {
      report.skipped.push({ missionId: m.id, reason: 'no workspace path recorded' });
      continue;
    }
    const wtResolved = resolve(wtPath);
    handledPaths.add(wtResolved);

    const terminalMs = terminalAtMs(m);
    if (cutoffMs !== undefined && (terminalMs === 0 || terminalMs > cutoffMs)) {
      report.skipped.push({
        missionId: m.id, worktreePath: wtResolved,
        reason: terminalMs === 0
          ? 'terminal time unknown — does not satisfy --older-than'
          : 'terminal more recently than --older-than'
      });
      continue;
    }

    // Containment: the recorded path must live under .agentloop/worktrees/.
    if (!isPathInside(worktreesRoot, wtResolved) || wtResolved === resolve(worktreesRoot)) {
      report.skipped.push({
        missionId: m.id, worktreePath: wtResolved,
        reason: 'workspace path is outside .agentloop/worktrees — refusing to remove'
      });
      continue;
    }

    const wtExists = existsSync(wtResolved);
    const expectedBranch = missionBranch(m.id);
    const notes: string[] = [];

    // Only the canonical mission branch may be deleted; a record naming any
    // other ref (tampered or hand-edited) leaves that ref untouched.
    const branch = m.workspace.branch === expectedBranch ? m.workspace.branch : undefined;
    if (m.workspace.branch && !branch) {
      notes.push(`recorded branch '${m.workspace.branch}' is not ${expectedBranch} — left untouched`);
    }
    const branchExists = branch !== undefined && await refExists(repoRoot, `refs/heads/${branch}`);

    if (!wtExists && !branchExists) {
      report.skipped.push({
        missionId: m.id, worktreePath: wtResolved,
        reason: 'no worktree or mission branch remains'
      });
      continue;
    }

    // Dirty check — a worktree that cannot be inspected is skipped, not removed.
    if (wtExists) {
      let dirty: boolean;
      try {
        const { stdout } = await gitSep(['status', '--porcelain'], wtResolved);
        dirty = stdout.trim().length > 0;
      } catch (err) {
        report.skipped.push({
          missionId: m.id, worktreePath: wtResolved,
          reason: `could not inspect worktree (${errMsg(err)}) — refusing to remove`
        });
        continue;
      }
      if (dirty && opts.force !== true) {
        report.skipped.push({
          missionId: m.id, worktreePath: wtResolved,
          reason: 'worktree has uncommitted changes — rerun with --force to discard'
        });
        continue;
      }
    }

    let deleteBranch = false;
    if (branchExists && opts.keepBranch === true) {
      notes.push(`branch ${branch} kept (--keep-branch)`);
    } else if (branchExists && opts.force === true) {
      deleteBranch = true;
    } else if (branchExists) {
      const mergedIntoRef = await mergedInto(repoRoot, branch!, [m.repository.baseBranch, m.repository.baseSha, 'HEAD']);
      if (mergedIntoRef) {
        deleteBranch = true;
      } else {
        notes.push(`branch ${branch} has unmerged commits — kept (use --force to delete)`);
      }
    }

    if (report.dryRun) {
      report.cleaned.push({
        missionId: m.id, state: m.state,
        terminalAt: terminalMs ? new Date(terminalMs).toISOString() : null,
        worktreePath: wtResolved, removedWorktree: wtExists,
        branch, deletedBranch: deleteBranch, notes
      });
      continue;
    }

    try {
      await removeMissionWorktree(repoRoot, wtResolved, {
        force: opts.force === true,
        branch: branchExists ? branch : undefined,
        keepBranch: !deleteBranch
      });
    } catch (err) {
      report.errors.push(`${m.id}: ${errMsg(err)}`);
      report.skipped.push({
        missionId: m.id, worktreePath: wtResolved,
        reason: `removal failed: ${errMsg(err)}`
      });
      continue;
    }
    store.emit(m.id, 'workspace_cleaned', {
      worktree: wtResolved,
      branch: deleteBranch ? branch : undefined,
      forced: opts.force === true || undefined
    });
    report.cleaned.push({
      missionId: m.id, state: m.state,
      terminalAt: terminalMs ? new Date(terminalMs).toISOString() : null,
      worktreePath: wtResolved, removedWorktree: wtExists,
      branch, deletedBranch: deleteBranch, notes
    });
  }

  // Orphan sweep: mission worktrees on disk that no terminal mission claimed.
  for (const wt of await listMissionWorktrees(repoRoot)) {
    const p = resolve(wt.path);
    if (handledPaths.has(p)) continue;
    if (!isPathInside(worktreesRoot, p)) {
      report.skipped.push({ worktreePath: p, reason: 'worktree outside .agentloop/worktrees — not managed by clean' });
      continue;
    }
    const id = basename(p);
    const mission = byId.get(id);
    if (mission && !isTerminal(mission.state)) {
      report.skipped.push({ missionId: id, worktreePath: p, reason: `mission is ${mission.state} — not terminal` });
    } else if (mission) {
      report.skipped.push({ missionId: id, worktreePath: p, reason: 'mission is terminal but recorded a different workspace path — inspect manually' });
    } else if (corruptIds.has(id)) {
      report.skipped.push({ missionId: id, worktreePath: p, reason: 'mission record is corrupt — inspect manually, refusing to remove' });
    } else {
      report.skipped.push({ missionId: id, worktreePath: p, reason: 'no mission record — refusing to remove (inspect manually)' });
    }
  }

  // Drop git administrative entries for worktrees that no longer exist.
  if (!report.dryRun) {
    try {
      await gitSep(['worktree', 'prune'], repoRoot);
    } catch (err) {
      if (err instanceof GitOutputLimitError) throw err;
      report.errors.push(`worktree prune: ${errMsg(err)}`);
    }
  }

  return report;
}

export async function cmdClean(opts: {
  repo?: string;
  dryRun?: boolean;
  force?: boolean;
  keepBranch?: boolean;
  olderThan?: string;
  json?: boolean;
}): Promise<void> {
  let olderThanMs: number | undefined;
  if (opts.olderThan !== undefined) {
    try {
      olderThanMs = parseDurationMs(opts.olderThan);
    } catch (err) {
      console.error(chalk.red(errMsg(err)));
      process.exitCode = 2;
      return;
    }
  }

  let report: CleanReport;
  try {
    report = await cleanRepo(opts.repo ?? process.cwd(), {
      dryRun: opts.dryRun,
      force: opts.force,
      keepBranch: opts.keepBranch,
      olderThanMs
    });
  } catch (err) {
    console.error(chalk.red(`Clean failed: ${errMsg(err)}`));
    process.exitCode = 2;
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const item of report.cleaned) {
      const verb = report.dryRun ? 'would remove' : 'removed';
      const parts = [
        item.removedWorktree ? item.worktreePath : null,
        item.deletedBranch ? `branch ${item.branch}` : null
      ].filter(Boolean).join(' + ');
      console.log(`${chalk.cyan(item.missionId)}  ${item.state.padEnd(10)}  ${verb} ${parts}`);
      for (const n of item.notes) console.log(`    ${chalk.gray(n)}`);
    }
    for (const s of report.skipped) {
      const who = s.missionId ? `${chalk.cyan(s.missionId)}  ` : '';
      console.log(`${who}${chalk.yellow('skipped')}  ${s.worktreePath ? `${s.worktreePath}  ` : ''}${s.reason}`);
    }
    const wt = report.cleaned.filter(i => i.removedWorktree).length;
    const br = report.cleaned.filter(i => i.deletedBranch).length;
    if (report.cleaned.length === 0 && report.skipped.length === 0) {
      console.log('Nothing to clean — no terminal-mission worktrees or branches.');
    } else if (report.dryRun) {
      console.log(`Dry run — would remove ${wt} worktree(s) and ${br} branch(es); ${report.skipped.length} skipped.`);
    } else {
      console.log(`Removed ${wt} worktree(s) and ${br} branch(es); ${report.skipped.length} skipped.`);
    }
  }

  if (report.errors.length > 0) {
    for (const e of report.errors) console.error(chalk.red(`  error: ${e}`));
    process.exitCode = 1;
  }
}
