import { hostname } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { MissionStore, RunnerConflictError } from '../mission/mission-store.js';
import { isTerminal, canTransition } from '../mission/state-machine.js';
import { MissionState, TaskStatus } from '../types.js';
import type { Mission, AgentAdapter, TaskNode, MissionPass, AgentInvocationResult } from '../types.js';
import { supervise } from '../supervisor/process-supervisor.js';
import { toSpawnInvocation } from '../agents/cli-adapter-base.js';
import { getAdapter } from '../agents/registry.js';
import { readyTasks, blockedTasks } from './task-graph.js';
import { runValidationGates, resolveGates } from './validation-gates.js';
import { deterministicReview, reviewToPrompt } from './reviewer.js';
import { checkpointCommit } from '../git/worktree-manager.js';
import { diffSummary } from '../git/repo-inspector.js';
import {
  requestApproval, loadApprovals, policyHash as computePolicyHash, verifyDecision
} from '../policy/approvals.js';
import { writeReceipt } from '../mission/receipt.js';
import { boundTail } from '../util/redact.js';
import { pidAlive } from './recovery.js';
import { logger } from '../logger.js';

/**
 * Mission runner — drives one mission through its lifecycle:
 *
 *   prepared → running → validating → (completed | repairing ↻)
 *      ↑ pause/resume/cancel handled between steps
 *      → waiting_for_approval when a gate requires it
 *      → blocked/failed when budgets or limits expire
 *
 * Ownership & crash safety:
 * - A runner must CLAIM the mission (pid + random nonce) under the store lock
 *   before driving it. A second runner claiming a live mission is refused —
 *   two processes can never execute the same mission.
 * - Every persisted write goes through store.mutate()/transition(), which
 *   operates on the freshly loaded record under the mission lock. The
 *   in-memory Mission object is a cache for reads, never the write source.
 * - Each agent attempt is recorded (invocationId, intent, pid) BEFORE spawn;
 *   a runner that dies mid-attempt leaves an open pass that recovery marks
 *   interrupted — outcome unknown — instead of silently redoing the work.
 * - A heartbeat written under CAS keeps the lease alive; a heartbeat that
 *   finds the nonce changed means the lease was lost → the runner aborts.
 */

const HEARTBEAT_INTERVAL_MS = 10_000;
const APPROVAL_POLL_MS = 5_000;
const AGENT_LOG_TAIL = 64 * 1024;
const STALE_AFTER_MS = 45_000;

/**
 * Combine abort signals without relying on AbortSignal.any (Node ≥18.17).
 * Fires when ANY input fires.
 */
function combinedSignal(signals: AbortSignal[]): AbortSignal {
  const c = new AbortController();
  const fire = () => c.abort();
  for (const s of signals) {
    if (s.aborted) { fire(); break; }
    s.addEventListener('abort', fire, { once: true });
  }
  return c.signal;
}

export interface RunnerOptions {
  /** Additional validation gate commands (argv) merged with mission spec gates */
  extraGates?: Array<{ name: string; argv: string[] }>;
  /** Repo-configured named validation commands (agentloop.config.json validationCommands) */
  validationCommands?: Record<string, string[]>;
  /** Optional reviewer adapter for a second-opinion review pass */
  reviewerAdapter?: AgentAdapter;
  /** Test hook: skip the actual agent invocation */
  dryRun?: boolean;
}

export class MissionRunner {
  private heartbeat: NodeJS.Timeout | null = null;
  private abort = new AbortController();
  private pauseAbort = new AbortController();
  private pauseRequested = false;
  private pauseReason = 'operator';
  private cancelRequested = false;
  private leaseLost = false;
  private readonly nonce = randomBytes(8).toString('hex');
  private hbSeq = 0;

  constructor(
    private readonly store: MissionStore,
    private readonly opts: RunnerOptions = {}
  ) {}

  /**
   * Request cooperative pause (checked between steps; aborts in-flight agent).
   * `reason` is recorded in state history — recovery distinguishes a shutdown
   * pause (auto-resumable) from an operator pause (never auto-resumed).
   */
  requestPause(reason: 'operator' | 'shutdown' = 'operator'): void {
    this.pauseRequested = true;
    this.pauseReason = reason;
    this.pauseAbort.abort();
  }
  /** Request cooperative cancel. */
  requestCancel(): void { this.cancelRequested = true; this.abort.abort(); this.pauseAbort.abort(); }

  /**
   * Drive a prepared/resumable mission to a terminal or waiting state.
   * Returns the final mission record. Throws RunnerConflictError if another
   * live runner owns the mission.
   */
  async run(missionId: string): Promise<Mission> {
    const initial = this.store.mustLoad(missionId);
    if (isTerminal(initial.state)) return initial;

    // Claim ownership: pid + nonce under the mission lock. Refused if a
    // different live runner holds it — two executors, one mission = never.
    this.store.claimForRun(missionId, {
      pid: process.pid,
      nonce: this.nonce,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      hbSeq: 0,
      host: `${hostname()}/${process.platform}`
    }, { staleAfterMs: STALE_AFTER_MS, pidAlive });

    this.store.mutate(missionId, m => {
      m.usage.startedAt = m.usage.startedAt ?? new Date().toISOString();
    });
    this.startHeartbeat(missionId);

    try {
      let mission = this.store.mustLoad(missionId);
      // Resume path honors the state machine: stale/blocked missions re-enter
      // through PREPARED (recovery audited them), paused/prepared go straight.
      if (mission.state === MissionState.STALE || mission.state === MissionState.BLOCKED) {
        mission = this.store.transition(mission, MissionState.PREPARED, 'resume: re-entering pipeline');
      }
      if (mission.state === MissionState.PREPARED || mission.state === MissionState.PAUSED) {
        this.store.transition(mission, MissionState.RUNNING, 'runner started');
      }

      await this.executeLoop(missionId);
      return this.store.mustLoad(missionId);
    } catch (err) {
      // A runner-level failure must not masquerade as mission success, and a
      // crashed runner must not leave the mission looking actively-driven.
      if (err instanceof RunnerConflictError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      try {
        const m = this.store.mustLoad(missionId);
        if (!isTerminal(m.state)) {
          this.store.transition(m, MissionState.BLOCKED, `runner error: ${reason.slice(0, 300)}`);
          this.store.emit(missionId, 'mission_blocked', { reason: `runner error: ${reason.slice(0, 200)}` });
        }
      } catch { /* state may be corrupt — stale detection is the backstop */ }
      return this.store.mustLoad(missionId);
    } finally {
      this.stopHeartbeat();
      this.store.releaseRunner(missionId, this.nonce);
    }
  }

  // ── main loop ─────────────────────────────────────────────────────────

  private async executeLoop(missionId: string): Promise<void> {
    for (;;) {
      const mission = this.store.mustLoad(missionId);
      if (isTerminal(mission.state)) return;
      if (this.checkInterrupts(mission)) return;
      if (this.checkBudget(mission)) return;

      switch (mission.state) {
        case MissionState.RUNNING:
          await this.stepExecute(mission);
          break;
        case MissionState.VALIDATING:
          await this.stepValidate(mission);
          break;
        case MissionState.REPAIRING:
          await this.stepRepair(mission);
          break;
        case MissionState.WAITING_FOR_APPROVAL:
          await this.stepApproval(mission);
          break;
        default:
          return; // paused/blocked handled by interrupts or external actors
      }
    }
  }

  /**
   * Check pause/cancel requests and external state changes (control API, CLI).
   * Returns true if the loop should exit.
   */
  private checkInterrupts(mission: Mission): boolean {
    const fresh = this.store.mustLoad(mission.id);
    // External operators can set state via the store (control API / CLI)
    if (fresh.state === MissionState.PAUSED || fresh.state === MissionState.CANCELLED ||
        fresh.state === MissionState.BLOCKED || isTerminal(fresh.state)) {
      mission.state = fresh.state;
      return true;
    }
    if (this.leaseLost) {
      logger.error('Runner lease lost — another owner or a stale marking won', { mission: mission.id });
      this.abort.abort();
      return true;
    }
    if (this.cancelRequested) {
      this.store.transition(mission, MissionState.CANCELLED, 'cancel requested');
      this.finalizeOutcome(mission.id, 'cancelled', 'Mission cancelled by operator');
      return true;
    }
    if (this.pauseRequested) {
      if (canTransition(fresh.state, MissionState.PAUSED)) {
        this.store.transition(mission, MissionState.PAUSED, `${this.pauseReason} pause requested`);
      }
      // If the state can't accept PAUSED (e.g. already waiting/blocked), the
      // loop still exits — the mission is not doing agent work.
      return true;
    }
    return false;
  }

  /** Enforce wall-time and invocation budgets (persisted, cumulative across resumes). */
  private checkBudget(mission: Mission): boolean {
    const elapsedMin = mission.usage.startedAt
      ? (Date.now() - Date.parse(mission.usage.startedAt)) / 60_000
      : 0;
    const wallTimeMs = mission.usage.startedAt
      ? Date.now() - Date.parse(mission.usage.startedAt) : 0;

    if (elapsedMin > mission.budget.maxMissionMinutes) {
      this.fail(mission, `budget exceeded: mission ran ${elapsedMin.toFixed(1)}m > max ${mission.budget.maxMissionMinutes}m`);
      return true;
    }
    if (mission.usage.agentInvocations >= mission.budget.maxAgentInvocations) {
      this.fail(mission, `budget exceeded: ${mission.usage.agentInvocations} agent invocations ≥ max ${mission.budget.maxAgentInvocations}`);
      return true;
    }
    if (wallTimeMs !== mission.usage.wallTimeMs) {
      this.store.mutate(mission.id, m => { m.usage.wallTimeMs = wallTimeMs; });
      mission.usage.wallTimeMs = wallTimeMs;
    }
    return false;
  }

  // ── steps ─────────────────────────────────────────────────────────────

  /** RUNNING: execute ready tasks via the agent, then → VALIDATING. */
  private async stepExecute(mission: Mission): Promise<void> {
    const ready = readyTasks(mission.tasks);

    if (ready.length === 0) {
      if (mission.tasks.length === 0) {
        // Never vacuously complete: an empty graph means planning produced no
        // executable work — that's a failure, not success.
        this.store.transition(mission, MissionState.FAILED, 'no executable tasks in plan');
        this.finalizeOutcome(mission.id, 'failed', 'Planner produced no executable tasks');
        return;
      }
      const blocked = blockedTasks(mission.tasks);
      if (blocked.length > 0) {
        this.store.transition(mission, MissionState.VALIDATING, 'task set exhausted');
        return;
      }
      if (mission.tasks.every(t =>
        t.status === TaskStatus.COMPLETED || t.status === TaskStatus.FAILED || t.status === TaskStatus.CANCELLED)) {
        this.store.transition(mission, MissionState.VALIDATING, 'all tasks finished');
        return;
      }
      // Anything else pending-but-not-ready (shouldn't happen post-audit):
      // do not spin — hand the workspace to validation to judge real state.
      this.store.transition(mission, MissionState.VALIDATING, 'no ready tasks; validating actual state');
      return;
    }

    for (const task of ready) {
      if (this.checkInterrupts(mission) || this.checkBudget(mission)) return;

      // Record the ATTEMPT before spawning: invocation id, intent, task→running.
      // The attempt consumes budget even if the runner dies mid-flight.
      const invocationId = `inv_${randomBytes(6).toString('hex')}`;
      const isResumeRetry = task.interrupted === true;
      this.store.mutate(mission.id, m => {
        const t = m.tasks.find(x => x.id === task.id);
        if (!t) return;
        t.status = TaskStatus.RUNNING;
        t.startedAt = new Date().toISOString();
        m.usage.agentInvocations++;
        const pass: MissionPass = {
          n: m.passes.length + 1,
          kind: 'execute',
          agentInvocationId: invocationId,
          intent: { taskId: task.id, kind: 'execute' },
          startedAt: new Date().toISOString()
        };
        m.passes.push(pass);
      });
      Object.assign(mission, this.store.mustLoad(mission.id));
      this.store.emit(mission.id, 'task_started', {
        taskId: task.id, title: task.title.slice(0, 120),
        interrupted: isResumeRetry || undefined
      });

      const result = await this.invokeAgent(mission, task, 'execute');

      // Pause vs cancel: supervise reports 'cancelled' for both signals —
      // distinguish by which flag was raised.
      if (result.exitKind === 'cancelled' && this.pauseRequested && !this.cancelRequested) {
        this.store.mutate(mission.id, m => {
          const t = m.tasks.find(x => x.id === task.id);
          if (t) {
            t.status = TaskStatus.PENDING;
            t.interrupted = true;
            t.result = 'interrupted: paused mid-execution, outcome unknown';
          }
          const p = m.passes.at(-1);
          if (p && p.agentInvocationId === invocationId) {
            p.finishedAt = new Date().toISOString();
            p.interrupted = true;
            p.note = 'paused mid-execution';
          }
        });
        this.store.emit(mission.id, 'work_interrupted', { taskId: task.id, reason: 'pause' });
        this.store.transition(mission, MissionState.PAUSED, `${this.pauseReason} pause requested`);
        return;
      }

      if (result.exitKind === 'cancelled') {
        this.store.mutate(mission.id, m => {
          const t = m.tasks.find(x => x.id === task.id);
          if (t) { t.status = TaskStatus.CANCELLED; t.completedAt = new Date().toISOString(); }
          const p = m.passes.at(-1);
          if (p && p.agentInvocationId === invocationId) {
            p.finishedAt = new Date().toISOString();
            p.note = 'cancelled';
          }
        });
        this.store.transition(mission, MissionState.CANCELLED, 'agent cancelled');
        this.finalizeOutcome(mission.id, 'cancelled', 'Agent invocation cancelled');
        return;
      }

      // Honest task record: only a clean exit completes the task. A nonzero
      // exit doesn't end the mission — repair/validation decide — but the
      // record must never claim failed work succeeded.
      this.store.mutate(mission.id, m => {
        const t = m.tasks.find(x => x.id === task.id);
        const p = m.passes.at(-1);
        if (t) {
          t.status = result.exitKind === 'success' ? TaskStatus.COMPLETED : TaskStatus.FAILED;
          t.completedAt = new Date().toISOString();
          t.outputSummary = boundTail(result.outputTail, 2 * 1024).text;
          t.result = result.exitKind;
          if (result.exitKind === 'spawn-error') t.error = result.outputTail.slice(0, 500);
        }
        if (p && p.agentInvocationId === invocationId) {
          p.finishedAt = new Date().toISOString();
          p.agentExit = result.exitKind;
        }
      });
      this.store.emit(mission.id, 'task_finished', {
        taskId: task.id,
        status: result.exitKind === 'success' ? 'completed' : 'failed',
        exit: result.exitKind
      });
      this.store.emit(mission.id, 'agent_finished', {
        exit: result.exitKind, exitCode: result.exitCode, durationMs: result.durationMs,
        truncated: result.outputTruncated, invocationId
      });

      await this.checkpoint(mission.id, 'pass');
      Object.assign(mission, this.store.mustLoad(mission.id));
    }

    this.store.transition(mission, MissionState.VALIDATING, 'execute pass complete');
  }

  /** VALIDATING: run deterministic gates + review. */
  private async stepValidate(mission: Mission): Promise<void> {
    const { gates, unknown } = resolveGates(mission.spec, this.opts.validationCommands);
    const extra = this.opts.extraGates ?? [];
    const allGates = [
      ...gates,
      ...extra.map(g => ({ name: g.name, argv: g.argv }))
    ];

    this.store.emit(mission.id, 'validation_started', {
      gates: allGates.map(g => g.name),
      ...(unknown.length > 0 ? { note: `ignored unconfigured commands: ${unknown.join(', ')}` } : {})
    });

    // Approvals decided for this mission and bound to its policy snapshot.
    const approved = loadApprovals(this.store.dir(mission.id))
      .filter(a => a.status === 'approved');

    const { results, allPassed, needsApproval } = await runValidationGates(
      allGates, mission.workspace.path, mission.policy, { approved }
    );

    const passN = mission.passes.at(-1)?.n;
    this.store.mutate(mission.id, m => {
      const p = m.passes.at(-1);
      if (p) p.gates = results;
      // Keep in-file approvals mirror in sync with the ledger
      m.approvals = loadApprovals(this.store.dir(m.id));
    });
    Object.assign(mission, this.store.mustLoad(mission.id));

    this.store.emit(mission.id, 'validation_finished', {
      passed: allPassed,
      pass: passN,
      gates: results.map(r => ({ name: r.name, passed: r.passed, note: r.note }))
    });

    // Gates needing approval → raise approval gate
    if (needsApproval.length > 0) {
      const detail = `Validation commands require approval: ${needsApproval.map(g => `${g.name} (${g.command.join(' ')})`).join(', ')}`;
      this.raiseApproval(mission, 'dangerous-command', detail, needsApproval.map(g => g.command));
      return;
    }

    // Review phase
    const review = await deterministicReview({
      worktreePath: mission.workspace.path,
      baseSha: mission.repository.baseSha,
      mission
    });
    this.store.mutate(mission.id, m => {
      const p = m.passes.at(-1);
      if (p) p.review = review;
    });
    this.store.emit(mission.id, 'review_finished', {
      verdict: review.verdict, findings: review.findings.length
    });

    // Outcome decision. With configured gates: all must pass. With zero gates:
    // nothing verifies failed work — require every task to have succeeded
    // and let the reviewer decide the diff.
    const failedTasks = mission.tasks.filter(t => t.status === TaskStatus.FAILED);
    const criteriaSatisfied = allGates.length > 0 ? allPassed : failedTasks.length === 0;
    if (review.verdict === 'reject') {
      this.raiseApproval(mission, 'scope-expansion',
        `Reviewer rejected the diff: ${review.findings.join('; ')}`);
      return;
    }

    if (criteriaSatisfied && review.verdict === 'approve') {
      await this.checkpoint(mission.id, 'final');
      const fresh = this.store.mustLoad(mission.id);
      this.store.transition(fresh, MissionState.COMPLETED, 'acceptance criteria satisfied');
      this.finalizeOutcome(mission.id, 'completed', 'Validation gates passed and review approved');
      this.store.emit(mission.id, 'mission_completed', { summary: 'acceptance criteria satisfied' });
      return;
    }

    // Failed validation or review → bounded repair
    if (mission.usage.repairPasses >= mission.budget.maxRepairPasses) {
      this.fail(mission,
        `repair budget exhausted (${mission.budget.maxRepairPasses} passes); ` +
        `last gates: ${results.map(r => `${r.name}=${r.passed ? 'pass' : 'fail'}`).join(', ')}`);
      return;
    }

    this.store.transition(mission, MissionState.REPAIRING,
      !allPassed ? 'validation failed' : 'review requested changes');
  }

  /** REPAIRING: run one repair pass with feedback, then re-validate. */
  private async stepRepair(mission: Mission): Promise<void> {
    const lastPass = mission.passes.at(-1);
    const feedback = this.buildRepairPrompt(mission, lastPass);
    const invocationId = `inv_${randomBytes(6).toString('hex')}`;

    const repairTaskId = `repair_${mission.passes.length + 1}`;
    this.store.mutate(mission.id, m => {
      m.usage.repairPasses++;
      m.usage.agentInvocations++;
      const pass: MissionPass = {
        n: m.passes.length + 1,
        kind: 'repair',
        agentInvocationId: invocationId,
        intent: { taskId: repairTaskId, kind: 'repair' },
        startedAt: new Date().toISOString()
      };
      m.passes.push(pass);
      const task: TaskNode = {
        id: repairTaskId,
        title: `Repair pass ${m.usage.repairPasses}`,
        dependsOn: [],
        status: TaskStatus.RUNNING,
        pass: pass.n,
        startedAt: new Date().toISOString()
      };
      m.tasks.push(task);
    });
    Object.assign(mission, this.store.mustLoad(mission.id));

    const repairTask = mission.tasks.find(t => t.id === repairTaskId)!;
    const result = await this.invokeAgent(mission, repairTask, 'repair', feedback);

    if (result.exitKind === 'cancelled' && this.pauseRequested && !this.cancelRequested) {
      this.store.mutate(mission.id, m => {
        const t = m.tasks.find(x => x.id === repairTaskId);
        if (t) { t.status = TaskStatus.PENDING; t.interrupted = true; t.result = 'interrupted: paused mid-repair'; }
        const p = m.passes.at(-1);
        if (p && p.agentInvocationId === invocationId) { p.finishedAt = new Date().toISOString(); p.interrupted = true; p.note = 'paused mid-repair'; }
        m.usage.repairPasses--; // the interrupted pass did not complete — don't consume the budget for it
      });
      this.store.emit(mission.id, 'work_interrupted', { taskId: repairTaskId, reason: 'pause' });
      this.store.transition(mission, MissionState.PAUSED, `${this.pauseReason} pause requested`);
      return;
    }

    if (result.exitKind === 'cancelled') {
      this.store.mutate(mission.id, m => {
        const p = m.passes.at(-1);
        if (p && p.agentInvocationId === invocationId) { p.finishedAt = new Date().toISOString(); p.note = 'cancelled'; }
      });
      this.store.transition(mission, MissionState.CANCELLED, 'repair cancelled');
      this.finalizeOutcome(mission.id, 'cancelled', 'Repair pass cancelled');
      return;
    }

    this.store.mutate(mission.id, m => {
      const t = m.tasks.find(x => x.id === repairTaskId);
      if (t) {
        t.status = result.exitKind === 'spawn-error' ? TaskStatus.FAILED : TaskStatus.COMPLETED;
        t.completedAt = new Date().toISOString();
        t.result = result.exitKind;
      }
      const p = m.passes.at(-1);
      if (p && p.agentInvocationId === invocationId) {
        p.finishedAt = new Date().toISOString();
        p.agentExit = result.exitKind;
      }
    });
    this.store.emit(mission.id, 'agent_finished', {
      exit: result.exitKind, exitCode: result.exitCode, durationMs: result.durationMs,
      truncated: result.outputTruncated, invocationId
    });
    await this.checkpoint(mission.id, 'repair');

    this.store.transition(mission, MissionState.VALIDATING, `repair pass ${mission.usage.repairPasses} done`);
  }

  /** WAITING_FOR_APPROVAL: poll the ledger for decisions; timeout → blocked. */
  private async stepApproval(mission: Mission): Promise<void> {
    // The ledger on disk is authoritative — the operator may decide from a
    // different process (CLI/control API) while this runner waits.
    const disk = loadApprovals(this.store.dir(mission.id));
    const pending = disk.filter(a => a.status === 'pending');

    if (pending.length === 0) {
      // Every gate is decided. Honor the newest decision ONLY if it verifies:
      // with AGENTLOOP_APPROVAL_KEY configured, an unsigned or mis-signed
      // approvals.json write is not a human decision — it's a forgery attempt
      // (e.g. by the agent process itself, which has filesystem access).
      const last = disk.at(-1);
      this.store.mutate(mission.id, m => { m.approvals = disk; });
      if (last && verifyDecision(last) !== 'ok') {
        this.store.emit(mission.id, 'approval_unverified', {
          approvalId: last.id, reason: verifyDecision(last)
        });
        this.store.transition(mission, MissionState.BLOCKED,
          'approval decision failed integrity check — operator must re-decide');
        return;
      }
      this.store.emit(mission.id, 'approval_decided', {
        gate: last?.gate, status: last?.status, by: last?.decidedBy
      });
      if (last?.status === 'denied') {
        this.store.transition(mission, MissionState.BLOCKED, `approval denied: ${last.gate}`);
        this.store.emit(mission.id, 'mission_blocked', { gate: last.gate });
      } else {
        this.store.transition(mission, MissionState.RUNNING, 'approval granted, resuming');
      }
      return;
    }

    const oldest = pending[0];
    const waitedMs = Date.now() - Date.parse(oldest.requestedAt);
    if (waitedMs > mission.policy.approvalTimeoutMs) {
      this.store.transition(mission, MissionState.BLOCKED, 'approval timed out');
      this.store.emit(mission.id, 'mission_blocked', { reason: 'approval timeout', gate: oldest.gate });
      return;
    }

    // Track human wait time separately from agent runtime
    this.store.mutate(mission.id, m => {
      m.usage.approvalWaitMs = (m.usage.approvalWaitMs ?? 0) + APPROVAL_POLL_MS;
      m.approvals = disk;
    });
    Object.assign(mission, this.store.mustLoad(mission.id));

    // Still pending — wait and re-check (loop re-enters this step)
    await new Promise(r => setTimeout(r, APPROVAL_POLL_MS));
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private async invokeAgent(
    mission: Mission,
    task: TaskNode,
    kind: 'execute' | 'repair',
    promptOverride?: string
  ): Promise<AgentInvocationResult> {
    const adapter = getAdapter(String(mission.agent.type), mission.agent);
    const invocationId = mission.passes.at(-1)?.agentInvocationId;
    const logFile = join(this.store.dir(mission.id), `agent-${invocationId ?? `pass-${mission.usage.agentInvocations}`}.log`);

    const prompt = promptOverride ??
      this.buildTaskPrompt(mission, task, mission.tasks.find(t => t.id === task.id)?.interrupted === true);

    this.store.emit(mission.id, 'agent_started', {
      agent: String(mission.agent.type), taskId: task.id, kind, invocationId
    });

    if (this.opts.dryRun) {
      return {
        exitKind: 'success', exitCode: 0,
        durationMs: 0, outputTail: '[dry-run]', outputTruncated: false, logFile
      };
    }

    const signal = combinedSignal([this.abort.signal, this.pauseAbort.signal]);
    const ctx: import('../types.js').AgentInvocationContext = {
      prompt,
      cwd: mission.workspace.path,
      missionId: mission.id,
      taskId: task.id,
      pass: mission.passes.at(-1)?.n ?? 0,
      signal,
      env: mission.agent.env,
      timeoutMs: mission.budget.agentTimeoutMs,
      maxOutputBytes: AGENT_LOG_TAIL,
      logFile
    };

    const inv = toSpawnInvocation(adapter.buildInvocation(ctx, mission.agent));

    const result = await supervise({
      command: inv.command,
      args: inv.args,
      cwd: ctx.cwd,
      env: inv.env,
      timeoutMs: ctx.timeoutMs,
      maxOutputBytes: ctx.maxOutputBytes,
      logFile,
      signal,
      // Persist the spawned pid immediately — recovery uses it to detect and
      // reap orphaned agent processes after a runner crash.
      onSpawn: (pid) => {
        if (pid) this.store.mutate(mission.id, m => {
          const p = m.passes.at(-1);
          if (p && p.agentInvocationId === invocationId) p.agentPid = pid;
        });
      }
    });
    return { ...result, exitKind: adapter.classifyExit(result) };
  }

  private buildTaskPrompt(mission: Mission, task: TaskNode, interrupted: boolean): string {
    const spec = mission.spec;
    return [
      `Mission objective: ${spec.objective}`,
      spec.scope?.length ? `Scope: work only within ${spec.scope.join(', ')}` : '',
      spec.nonGoals?.length ? `Non-goals (do NOT do these): ${spec.nonGoals.join(', ')}` : '',
      `Current task: ${task.title}`,
      interrupted
        ? 'A previous attempt at this task was interrupted mid-execution — partial changes may already exist in the workspace. Inspect the current state before redoing work; do not assume a clean tree.'
        : '',
      `Acceptance criteria: ${spec.acceptanceCriteria.join('; ')}`,
      spec.riskConstraints?.length ? `Constraints: ${spec.riskConstraints.join(', ')}` : '',
      'Work in the current directory only. Do not commit, push, or open pull requests.',
      'Do not modify anything under .agentloop/ or runtime configuration files.'
    ].filter(Boolean).join('\n');
  }

  private buildRepairPrompt(mission: Mission, lastPass: MissionPass | undefined): string {
    const parts: string[] = [
      `Mission objective: ${mission.spec.objective}`,
      '',
      'The previous pass did not satisfy acceptance criteria. Fix the issues below.',
      ''
    ];
    if (lastPass?.gates?.length) {
      const failed = lastPass.gates.filter(g => !g.passed);
      if (failed.length) {
        parts.push('Failing validation gates:');
        for (const g of failed) {
          parts.push(`- ${g.name} (exit ${g.exitCode}): ${boundTail(g.outputTail ?? '', 1024).text.slice(-512)}`);
        }
        parts.push('');
      }
    }
    if (lastPass?.review && lastPass.review.findings.length > 0) {
      parts.push(reviewToPrompt(lastPass.review), '');
    }
    parts.push(
      'Make the minimal changes needed to satisfy the criteria.',
      'Do not commit, push, or open pull requests.'
    );
    return parts.join('\n');
  }

  private async checkpoint(missionId: string, kind: import('../types.js').Checkpoint['kind'], pass?: number): Promise<void> {
    const mission = this.store.mustLoad(missionId);
    if (!mission.policy.allowLocalCommit) return;
    try {
      const sha = await checkpointCommit(
        mission.workspace.path,
        `agentloop(${mission.id}): ${kind}${pass ? ` pass ${pass}` : ''}`
      );
      if (sha) {
        const diff = await diffSummary(mission.workspace.path, mission.repository.baseSha).catch(() => undefined);
        this.store.mutate(missionId, m => {
          m.checkpoints.push({ sha, at: new Date().toISOString(), kind, pass, diffSummary: diff });
          const p = m.passes.at(-1);
          if (p && !p.checkpointSha) p.checkpointSha = sha;
        });
        this.store.emit(missionId, 'checkpoint_created', { sha: sha.slice(0, 10), kind, pass, diff });
      }
    } catch (err) {
      logger.warn('Checkpoint failed (non-fatal)', {
        mission: missionId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private raiseApproval(
    mission: Mission,
    gate: import('../types.js').ApprovalRequest['gate'],
    detail: string,
    commands?: string[][]
  ): void {
    const dir = this.store.dir(mission.id);
    const req = requestApproval(dir, mission.id, gate, detail, commands, {
      policyHash: mission.policyHash ?? computePolicyHash(mission.policy),
      worktree: mission.workspace.path
    });
    this.store.mutate(mission.id, m => { m.approvals = loadApprovals(dir); });
    this.store.emit(mission.id, 'approval_required', { gate, detail: detail.slice(0, 300), approvalId: req.id });
    this.store.transition(mission, MissionState.WAITING_FOR_APPROVAL, `gate: ${gate}`);
  }

  private fail(mission: Mission, reason: string): void {
    this.store.transition(mission, MissionState.FAILED, reason);
    this.finalizeOutcome(mission.id, 'failed', reason);
    this.store.emit(mission.id, 'mission_failed', { reason: reason.slice(0, 300) });
  }

  private finalizeOutcome(missionId: string, result: 'completed' | 'failed' | 'cancelled', summary: string): void {
    this.store.mutate(missionId, fresh => {
      fresh.outcome = {
        result,
        summary,
        finalSha: fresh.checkpoints.at(-1)?.sha,
        at: new Date().toISOString()
      };
    });
    try {
      const fresh = this.store.mustLoad(missionId);
      const receiptPath = writeReceipt(this.store.repoRoot, fresh);
      this.store.mutate(missionId, m => { m.outcome!.receiptPath = receiptPath; });
    } catch { /* receipt is best-effort */ }
  }

  private startHeartbeat(missionId: string): void {
    this.heartbeat = setInterval(() => {
      this.hbSeq++;
      const ok = this.store.heartbeat(missionId, this.nonce, this.hbSeq);
      if (!ok) {
        this.leaseLost = true;
        this.abort.abort();
        this.pauseAbort.abort();
        this.store.emit(missionId, 'lease_lost', { nonce: this.nonce.slice(0, 8), pid: process.pid });
        this.stopHeartbeat();
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}
