import { hostname } from 'os';
import { join } from 'path';
import { MissionStore } from '../mission/mission-store.js';
import { isTerminal } from '../mission/state-machine.js';
import { MissionState, TaskStatus } from '../types.js';
import type { Mission, AgentAdapter, GateResult, TaskNode } from '../types.js';
import { supervise } from '../supervisor/process-supervisor.js';
import { toSpawnInvocation } from '../agents/cli-adapter-base.js';
import { getAdapter } from '../agents/registry.js';
import { readyTasks, blockedTasks } from './task-graph.js';
import { runValidationGates, resolveGates } from './validation-gates.js';
import { deterministicReview, reviewToPrompt } from './reviewer.js';
import { checkpointCommit } from '../git/worktree-manager.js';
import { diffSummary } from '../git/repo-inspector.js';
import { requestApproval, approvalStatus } from '../policy/approvals.js';
import { writeReceipt } from '../mission/receipt.js';
import { boundTail } from '../util/redact.js';
import { logger } from '../logger.js';

/**
 * Mission runner — drives one mission through its lifecycle:
 *
 *   prepared → running → validating → (completed | repairing ↻)
 *      ↑ pause/resume/cancel handled between steps
 *      → waiting_for_approval when a gate requires it
 *      → blocked/failed when budgets or limits expire
 *
 * Crash safety: every state change is persisted before acting; a heartbeat
 * is written while running so a dead runner is detectable as `stale`.
 */

const HEARTBEAT_INTERVAL_MS = 10_000;
const APPROVAL_POLL_MS = 5_000;
const AGENT_LOG_TAIL = 64 * 1024;

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
  private pauseRequested = false;
  private cancelRequested = false;

  constructor(
    private readonly store: MissionStore,
    private readonly opts: RunnerOptions = {}
  ) {}

  /** Request cooperative pause (checked between steps). */
  requestPause(): void { this.pauseRequested = true; }
  /** Request cooperative cancel. */
  requestCancel(): void { this.cancelRequested = true; this.abort.abort(); }

  /**
   * Drive a prepared/resumable mission to a terminal or waiting state.
   * Returns the final mission record.
   */
  async run(missionId: string): Promise<Mission> {
    const mission = this.store.mustLoad(missionId);
    if (isTerminal(mission.state)) return mission;

    // Runner identity + heartbeat for stale detection
    mission.runner = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      host: `${hostname()}/${process.platform}`
    };
    mission.usage.startedAt = mission.usage.startedAt ?? new Date().toISOString();
    this.store.save(mission);
    this.startHeartbeat(mission.id);

    try {
      if (mission.state === MissionState.PREPARED || mission.state === MissionState.PAUSED ||
          mission.state === MissionState.STALE || mission.state === MissionState.BLOCKED) {
        this.store.transition(mission, MissionState.RUNNING, 'runner started');
      }

      await this.executeLoop(mission);
      return this.store.mustLoad(mission.id);
    } finally {
      this.stopHeartbeat();
      const final = this.store.mustLoad(mission.id);
      if (final.runner?.pid === process.pid) {
        final.runner = undefined;
        this.store.save(final);
      }
    }
  }

  // ── main loop ─────────────────────────────────────────────────────────

  private async executeLoop(mission: Mission): Promise<void> {
    while (!isTerminal(mission.state)) {
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

  /** Check pause/cancel requests; applies transitions. Returns true if loop should exit. */
  private checkInterrupts(mission: Mission): boolean {
    const fresh = this.store.mustLoad(mission.id);
    // External operators can also set state via the store (control API)
    if (fresh.state === MissionState.PAUSED || fresh.state === MissionState.CANCELLED ||
        fresh.state === MissionState.BLOCKED || isTerminal(fresh.state)) {
      mission.state = fresh.state;
      return true;
    }
    if (this.cancelRequested) {
      this.store.transition(mission, MissionState.CANCELLED, 'cancel requested');
      this.finalizeOutcome(mission, 'cancelled', 'Mission cancelled by operator');
      return true;
    }
    if (this.pauseRequested) {
      this.store.transition(mission, MissionState.PAUSED, 'pause requested');
      return true;
    }
    return false;
  }

  /** Enforce wall-time and invocation budgets. */
  private checkBudget(mission: Mission): boolean {
    const elapsedMin = mission.usage.startedAt
      ? (Date.now() - Date.parse(mission.usage.startedAt)) / 60_000
      : 0;
    mission.usage.wallTimeMs = mission.usage.startedAt
      ? Date.now() - Date.parse(mission.usage.startedAt) : 0;

    if (elapsedMin > mission.budget.maxMissionMinutes) {
      this.fail(mission, `budget exceeded: mission ran ${elapsedMin.toFixed(1)}m > max ${mission.budget.maxMissionMinutes}m`);
      return true;
    }
    if (mission.usage.agentInvocations >= mission.budget.maxAgentInvocations) {
      this.fail(mission, `budget exceeded: ${mission.usage.agentInvocations} agent invocations ≥ max ${mission.budget.maxAgentInvocations}`);
      return true;
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
        this.finalizeOutcome(mission, 'failed', 'Planner produced no executable tasks');
        return;
      }
      const blocked = blockedTasks(mission.tasks);
      if (blocked.length > 0) {
        this.store.transition(mission, MissionState.VALIDATING, 'task set exhausted');
        return;
      }
      // All remaining tasks already terminal — move to validation
      if (mission.tasks.every(t => t.status === TaskStatus.COMPLETED || t.status === TaskStatus.FAILED || t.status === TaskStatus.CANCELLED)) {
        this.store.transition(mission, MissionState.VALIDATING, 'all tasks finished');
        return;
      }
    }

    const adapter = getAdapter(String(mission.agent.type), mission.agent);

    for (const task of ready) {
      if (this.checkInterrupts(mission) || this.checkBudget(mission)) return;

      task.status = TaskStatus.RUNNING;
      task.startedAt = new Date().toISOString();
      this.store.save(mission);
      this.store.emit(mission.id, 'task_started', { taskId: task.id, title: task.title.slice(0, 120) });

      const result = await this.invokeAgent(mission, task, 'execute');
      mission.usage.agentInvocations++;

      const pass = this.openPass(mission, 'execute');
      pass.agentExit = result.exitKind;

      if (result.exitKind === 'cancelled') {
        task.status = TaskStatus.CANCELLED;
        task.completedAt = new Date().toISOString();
        this.closePass(mission, pass, `cancelled`);
        this.store.save(mission);
        this.store.transition(mission, MissionState.CANCELLED, 'agent cancelled');
        this.finalizeOutcome(mission, 'cancelled', 'Agent invocation cancelled');
        return;
      }

      // Honest task record: only a clean exit completes the task. A nonzero
      // exit doesn't end the mission — repair/validation decide — but the
      // record must never claim failed work succeeded.
      task.status = result.exitKind === 'success' ? TaskStatus.COMPLETED : TaskStatus.FAILED;
      task.completedAt = new Date().toISOString();
      task.outputSummary = boundTail(result.outputTail, 2 * 1024).text;
      task.result = result.exitKind;
      if (result.exitKind === 'spawn-error') task.error = result.outputTail.slice(0, 500);

      this.closePass(mission, pass, result.exitKind);
      this.store.emit(mission.id, 'task_finished', {
        taskId: task.id, status: task.status, exit: result.exitKind
      });
      this.store.emit(mission.id, 'agent_finished', {
        exit: result.exitKind, exitCode: result.exitCode, durationMs: result.durationMs,
        truncated: result.outputTruncated
      });

      await this.checkpoint(mission, 'pass', pass.n);
      this.store.save(mission);
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

    if (unknown.length > 0) {
      this.store.emit(mission.id, 'validation_started', {
        note: `ignored unconfigured commands: ${unknown.join(', ')}`
      });
    } else {
      this.store.emit(mission.id, 'validation_started', { gates: allGates.map(g => g.name) });
    }

    // Commands a human already approved for this mission run as allowed.
    const approvedArgv = mission.approvals
      .filter(a => a.status === 'approved' && a.commands)
      .flatMap(a => a.commands!);

    const { results, allPassed, needsApproval } = await runValidationGates(
      allGates, mission.workspace.path, mission.policy, { approvedArgv }
    );

    const pass = this.currentPass(mission);
    if (pass) pass.gates = results;

    this.store.emit(mission.id, 'validation_finished', {
      passed: allPassed,
      gates: results.map(r => ({ name: r.name, passed: r.passed, note: r.note }))
    });

    // Gates needing approval → raise approval gate
    if (needsApproval.length > 0) {
      const detail = `Validation commands require approval: ${needsApproval.map(g => `${g.name} (${g.command.join(' ')})`).join(', ')}`;
      this.raiseApproval(mission, 'dangerous-command', detail, MissionState.VALIDATING,
        needsApproval.map(g => g.command));
      return;
    }

    // Review phase
    const review = await deterministicReview({
      worktreePath: mission.workspace.path,
      baseSha: mission.repository.baseSha,
      mission
    });
    if (pass) pass.review = review;
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
        `Reviewer rejected the diff: ${review.findings.join('; ')}`, MissionState.VALIDATING);
      return;
    }

    if (criteriaSatisfied && review.verdict === 'approve') {
      await this.checkpoint(mission, 'final');
      this.store.transition(mission, MissionState.COMPLETED, 'acceptance criteria satisfied');
      this.finalizeOutcome(mission, 'completed', 'Validation gates passed and review approved');
      this.store.emit(mission.id, 'mission_completed', { summary: mission.outcome?.summary });
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
    mission.usage.repairPasses++;
    const adapter = getAdapter(String(mission.agent.type), mission.agent);

    const pass = this.openPass(mission, 'repair');
    const lastPass = mission.passes[mission.passes.length - 2];

    const feedback = this.buildRepairPrompt(mission, lastPass);
    const task: TaskNode = {
      id: `repair_${pass.n}`,
      title: `Repair pass ${mission.usage.repairPasses}`,
      dependsOn: [],
      status: TaskStatus.RUNNING,
      pass: pass.n,
      startedAt: new Date().toISOString()
    };
    this.store.save(mission);

    const result = await this.invokeAgent(mission, task, 'repair', feedback);
    mission.usage.agentInvocations++;
    pass.agentExit = result.exitKind;

    if (result.exitKind === 'cancelled') {
      this.closePass(mission, pass, 'cancelled');
      this.store.save(mission);
      this.store.transition(mission, MissionState.CANCELLED, 'repair cancelled');
      this.finalizeOutcome(mission, 'cancelled', 'Repair pass cancelled');
      return;
    }

    task.status = result.exitKind === 'spawn-error' ? TaskStatus.FAILED : TaskStatus.COMPLETED;
    task.completedAt = new Date().toISOString();
    mission.tasks.push(task);

    this.closePass(mission, pass, result.exitKind);
    await this.checkpoint(mission, 'repair', pass.n);
    this.store.save(mission);

    this.store.transition(mission, MissionState.VALIDATING, `repair pass ${mission.usage.repairPasses} done`);
  }

  /** WAITING_FOR_APPROVAL: poll for decisions; timeout → blocked. */
  private async stepApproval(mission: Mission): Promise<void> {
    const pending = mission.approvals.filter(a => a.status === 'pending');
    if (pending.length === 0) {
      // Decisions arrived via store — figure out where to go
      const last = mission.approvals.at(-1);
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

    // Re-read approvals from disk (operator may have decided externally)
    const { loadApprovals } = await import('../policy/approvals.js');
    const disk = loadApprovals(this.store.dir(mission.id));
    mission.approvals = disk;
    const decided = disk.find(a => a.id === oldest.id && a.status !== 'pending');

    if (decided) {
      this.store.emit(mission.id, 'approval_decided', {
        gate: decided.gate, status: decided.status, by: decided.decidedBy
      });
      if (decided.status === 'denied') {
        this.store.transition(mission, MissionState.BLOCKED, `approval denied: ${decided.gate}`);
        this.store.emit(mission.id, 'mission_blocked', { gate: decided.gate });
      } else {
        this.store.transition(mission, MissionState.RUNNING, 'approval granted');
      }
      return;
    }

    // Still pending — wait and re-check (loop re-enters this step)
    await new Promise(r => setTimeout(r, APPROVAL_POLL_MS));
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private async invokeAgent(
    mission: Mission,
    task: TaskNode,
    kind: 'execute' | 'repair',
    promptOverride?: string
  ): Promise<import('../types.js').AgentInvocationResult> {
    const adapter = getAdapter(String(mission.agent.type), mission.agent);
    const logFile = join(this.store.dir(mission.id), `agent-pass-${mission.usage.agentInvocations + 1}.log`);

    const prompt = promptOverride ?? this.buildTaskPrompt(mission, task);
    const ctx = {
      prompt,
      cwd: mission.workspace.path,
      missionId: mission.id,
      taskId: task.id,
      pass: mission.usage.repairPasses + 1,
      signal: this.abort.signal,
      timeoutMs: mission.budget.agentTimeoutMs,
      maxOutputBytes: AGENT_LOG_TAIL,
      logFile,
      env: mission.agent.env
    };

    this.store.emit(mission.id, 'agent_started', {
      agent: String(mission.agent.type), taskId: task.id, kind
    });

    if (this.opts.dryRun) {
      return {
        exitKind: 'success', exitCode: 0,
        durationMs: 0, outputTail: '[dry-run]', outputTruncated: false, logFile
      };
    }

    const inv = toSpawnInvocation(adapter.buildInvocation(ctx, mission.agent));
    const result = await supervise({
      command: inv.command,
      args: inv.args,
      cwd: ctx.cwd,
      env: inv.env,
      timeoutMs: ctx.timeoutMs,
      maxOutputBytes: ctx.maxOutputBytes,
      logFile,
      signal: this.abort.signal
    });
    return { ...result, exitKind: adapter.classifyExit(result) };
  }

  private buildTaskPrompt(mission: Mission, task: TaskNode): string {
    const spec = mission.spec;
    return [
      `Mission objective: ${spec.objective}`,
      spec.scope?.length ? `Scope: work only within ${spec.scope.join(', ')}` : '',
      spec.nonGoals?.length ? `Non-goals (do NOT do these): ${spec.nonGoals.join(', ')}` : '',
      `Current task: ${task.title}`,
      `Acceptance criteria: ${spec.acceptanceCriteria.join('; ')}`,
      spec.riskConstraints?.length ? `Constraints: ${spec.riskConstraints.join(', ')}` : '',
      'Work in the current directory only. Do not commit, push, or open pull requests.',
      'Do not modify anything under .agentloop/ or runtime configuration files.'
    ].filter(Boolean).join('\n');
  }

  private buildRepairPrompt(mission: Mission, lastPass: import('../types.js').MissionPass | undefined): string {
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

  private openPass(mission: Mission, kind: 'execute' | 'repair'): import('../types.js').MissionPass {
    const pass: import('../types.js').MissionPass = {
      n: mission.passes.length + 1,
      kind,
      startedAt: new Date().toISOString()
    };
    mission.passes.push(pass);
    return pass;
  }

  private closePass(mission: Mission, pass: import('../types.js').MissionPass, note?: string): void {
    pass.finishedAt = new Date().toISOString();
    if (note) pass.note = note;
    this.store.save(mission);
  }

  private currentPass(mission: Mission): import('../types.js').MissionPass | undefined {
    return mission.passes.at(-1);
  }

  private async checkpoint(mission: Mission, kind: import('../types.js').Checkpoint['kind'], pass?: number): Promise<void> {
    if (!mission.policy.allowLocalCommit) return;
    try {
      const sha = await checkpointCommit(
        mission.workspace.path,
        `agentloop(${mission.id}): ${kind}${pass ? ` pass ${pass}` : ''}`
      );
      if (sha) {
        const diff = await diffSummary(mission.workspace.path, mission.repository.baseSha).catch(() => undefined);
        mission.checkpoints.push({ sha, at: new Date().toISOString(), kind, pass, diffSummary: diff });
        this.store.save(mission);
        this.store.emit(mission.id, 'checkpoint_created', { sha: sha.slice(0, 10), kind, pass, diff });
      }
    } catch (err) {
      logger.warn('Checkpoint failed (non-fatal)', {
        mission: mission.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private raiseApproval(
    mission: Mission,
    gate: import('../types.js').ApprovalRequest['gate'],
    detail: string,
    fromState: MissionState,
    commands?: string[][]
  ): void {
    const req = requestApproval(this.store.dir(mission.id), mission.id, gate, detail, commands);
    mission.approvals.push(req);
    this.store.save(mission);
    this.store.emit(mission.id, 'approval_required', { gate, detail: detail.slice(0, 300) });
    this.store.transition(mission, MissionState.WAITING_FOR_APPROVAL, `gate: ${gate}`);
  }

  private fail(mission: Mission, reason: string): void {
    this.store.transition(mission, MissionState.FAILED, reason);
    this.finalizeOutcome(mission, 'failed', reason);
    this.store.emit(mission.id, 'mission_failed', { reason: reason.slice(0, 300) });
  }

  private finalizeOutcome(mission: Mission, result: 'completed' | 'failed' | 'cancelled', summary: string): void {
    const fresh = this.store.mustLoad(mission.id);
    fresh.outcome = {
      result,
      summary,
      finalSha: fresh.checkpoints.at(-1)?.sha,
      at: new Date().toISOString()
    };
    this.store.save(fresh);
    try {
      fresh.outcome.receiptPath = writeReceipt(this.store.repoRoot, fresh);
      this.store.save(fresh);
    } catch { /* receipt is best-effort */ }
    Object.assign(mission, fresh);
  }

  private startHeartbeat(missionId: string): void {
    this.heartbeat = setInterval(() => {
      try {
        const m = this.store.load(missionId);
        if (m && m.runner?.pid === process.pid) {
          m.runner.heartbeatAt = new Date().toISOString();
          this.store.save(m);
          this.store.emit(missionId, 'runner_heartbeat', { pid: process.pid });
        }
      } catch { /* heartbeat is best-effort */ }
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
