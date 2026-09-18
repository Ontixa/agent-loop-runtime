/**
 * Canonical type definitions for Agent Loop Runtime.
 *
 * The fundamental abstraction is a Mission: a bounded, policy-governed unit of
 * autonomous agent work with explicit acceptance criteria, validation gates,
 * checkpoints, and a persisted execution history.
 *
 * Legacy task-queue types are preserved at the bottom for backwards
 * compatibility with earlier releases.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Agent types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported agent adapter types. Qwen Code is one adapter among several —
 * it no longer defines the architecture.
 */
export enum AgentType {
  QWEN = 'qwen',
  CODEX = 'codex',
  CLAUDE = 'claude',
  DEVIN = 'devin',
  GEMINI = 'gemini',
  OPENCODE = 'opencode',
  AIDER = 'aider',
  CUSTOM = 'custom'
}

/** Status states for agents in the system */
export enum AgentStatus {
  IDLE = 'idle',
  BUSY = 'busy',
  ERROR = 'error',
  OFFLINE = 'offline'
}

/**
 * Configuration for a single agent instance.
 */
export interface AgentConfig {
  /** Unique name/identifier for this agent configuration */
  name: string;
  /** Adapter type */
  type: AgentType | string;
  /** Model identifier where the adapter supports it */
  model?: string;
  /** Timeout in milliseconds for a single agent invocation */
  timeout?: number;
  /** Working directory override (defaults to the mission worktree) */
  workingDirectory?: string;
  /**
   * Additional CLI arguments appended to the adapter's invocation.
   * Must be explicit argv entries — never shell strings.
   */
  additionalArgs?: string[];
  /**
   * For `custom` agents: the executable name or path.
   * For known adapters: optional explicit executable path override.
   */
  command?: string;
  /**
   * For `custom` agents: argv template with placeholders.
   * Supported placeholders: {objective}, {mission}, {task}, {worktree}, {repository}
   */
  args?: string[];
  /** Environment variable overrides for the agent process */
  env?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mission model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mission lifecycle states. Transitions are enforced by the mission state
 * machine — illegal transitions throw.
 */
export enum MissionState {
  /** Created, not yet prepared (no worktree/plan) */
  CREATED = 'created',
  /** Prepared: repository verified, worktree created, plan built */
  PREPARED = 'prepared',
  /** An agent is actively executing */
  RUNNING = 'running',
  /** Execution paused by operator */
  PAUSED = 'paused',
  /** Halted on a human approval gate */
  WAITING_FOR_APPROVAL = 'waiting_for_approval',
  /** Deterministic validation gates are running */
  VALIDATING = 'validating',
  /** A bounded repair pass is in progress */
  REPAIRING = 'repairing',
  /** All acceptance criteria satisfied — terminal */
  COMPLETED = 'completed',
  /** Unrecoverable failure or budget exhausted — terminal */
  FAILED = 'failed',
  /** Cancelled by operator — terminal */
  CANCELLED = 'cancelled',
  /** Blocked: needs operator action to proceed (non-terminal) */
  BLOCKED = 'blocked',
  /** Runner disappeared without checkpointing — recoverable */
  STALE = 'stale'
}

export const TERMINAL_MISSION_STATES: ReadonlySet<MissionState> = new Set([
  MissionState.COMPLETED,
  MissionState.FAILED,
  MissionState.CANCELLED
]);

/**
 * Explicit mission specification. Acceptance criteria are mandatory — an
 * agent may never self-declare success.
 */
export interface MissionSpec {
  /** What the agent must accomplish */
  objective: string;
  /** Files/directories in scope (glob-style, relative to repo root) */
  scope?: string[];
  /** Explicit non-goals — work outside scope requires approval */
  nonGoals?: string[];
  /** Human-readable acceptance criteria */
  acceptanceCriteria: string[];
  /** Deterministic verification commands (resolved via configured gates) */
  verificationCommands?: string[];
  /** Risk constraints, e.g. 'no-dependency-changes', 'docs-only' */
  riskConstraints?: string[];
}

/** Git context captured when the mission was created */
export interface MissionRepository {
  /** Absolute path to the repository root */
  path: string;
  /** Base commit SHA the mission branched from */
  baseSha: string;
  /** Branch checked out at mission creation (or 'HEAD' if detached) */
  baseBranch: string;
  /** Remote name if present (e.g. 'origin') — never a URL with credentials */
  remote?: string;
}

/** Workspace assignment for a mission */
export interface MissionWorkspace {
  /** 'worktree' (default, isolated) or 'in-place' (explicit opt-in) */
  mode: 'worktree' | 'in-place';
  /** Absolute path of the mission worktree */
  path: string;
  /** Mission branch name (worktree mode) */
  branch?: string;
}

/** Per-mission budget limits — always finite */
export interface MissionBudget {
  /** Hard wall-clock limit for the whole mission, minutes */
  maxMissionMinutes: number;
  /** Maximum repair passes after a failed validation/review */
  maxRepairPasses: number;
  /** Maximum total agent process invocations */
  maxAgentInvocations: number;
  /** Optional cap on cumulative diff size in bytes */
  maxDiffBytes?: number;
  /** Per-invocation timeout, milliseconds */
  agentTimeoutMs: number;
}

/** Runtime bookkeeping (no secrets) */
export interface MissionUsage {
  agentInvocations: number;
  repairPasses: number;
  wallTimeMs: number;
  startedAt?: string;
}

/** A node in the mission task DAG */
export interface TaskNode {
  id: string;
  title: string;
  /** IDs of tasks that must complete first */
  dependsOn: string[];
  status: TaskStatus;
  /** Which pass produced/consumed this task */
  pass?: number;
  result?: string;
  error?: string;
  /** Bounded agent output summary — never full logs */
  outputSummary?: string;
  startedAt?: string;
  completedAt?: string;
}

/** Result of one validation gate execution */
export interface GateResult {
  name: string;
  command: string[];
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  /** Bounded tail of combined output */
  outputTail?: string;
  /** If the gate was skipped/blocked by policy, why */
  note?: string;
}

/** Review verdict for a pass */
export interface ReviewResult {
  reviewer: string;
  verdict: 'approve' | 'request-changes' | 'reject';
  findings: string[];
  at: string;
}

/** One execute→validate→review→repair cycle */
export interface MissionPass {
  n: number;
  kind: 'execute' | 'repair';
  agentInvocationId?: string;
  startedAt: string;
  finishedAt?: string;
  gates?: GateResult[];
  review?: ReviewResult;
  checkpointSha?: string;
  /** Agent-reported outcome classification */
  agentExit?: 'success' | 'failed' | 'timeout' | 'cancelled' | 'spawn-error';
  note?: string;
}

/** An approval gate raised during the mission */
export interface ApprovalRequest {
  id: string;
  gate:
    | 'scope-expansion'
    | 'dangerous-command'
    | 'push'
    | 'pull-request'
    | 'merge'
    | 'dependency-change'
    | 'deployment'
    | 'policy-change'
    | 'in-place-execution';
  detail: string;
  /** For command gates: the argv(s) that were gated. Approved commands are sticky for the mission. */
  commands?: string[][];
  status: 'pending' | 'approved' | 'denied';
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

/** A Git-native checkpoint */
export interface Checkpoint {
  sha: string;
  at: string;
  kind: 'prepare' | 'pass' | 'repair' | 'final' | 'manual';
  pass?: number;
  /** Short diffstat summary, e.g. "3 files changed, +120 -40" */
  diffSummary?: string;
}

/** Runner identity used for crash/stale detection */
export interface MissionRunnerInfo {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  /** Hostname + platform, for diagnostics */
  host?: string;
}

/** The persisted mission record — atomic JSON in .agentloop/missions/<id>/ */
export interface Mission {
  schemaVersion: 1;
  id: string;
  /** Mission kind: objective (default), maintenance, or legacy continuous */
  kind: 'objective' | 'maintenance' | 'continuous';
  spec: MissionSpec;
  repository: MissionRepository;
  workspace: MissionWorkspace;
  agent: AgentConfig;
  policy: ResolvedPolicy;
  budget: MissionBudget;
  state: MissionState;
  stateHistory: Array<{ state: MissionState; at: string; reason?: string }>;
  tasks: TaskNode[];
  passes: MissionPass[];
  approvals: ApprovalRequest[];
  checkpoints: Checkpoint[];
  usage: MissionUsage;
  runner?: MissionRunnerInfo;
  outcome?: MissionOutcome;
  createdAt: string;
  updatedAt: string;
}

/** Final mission outcome, written once on terminal states */
export interface MissionOutcome {
  result: 'completed' | 'failed' | 'cancelled';
  summary: string;
  finalSha?: string;
  receiptPath?: string;
  at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic local policy. Agents and agent text can never modify this.
 * Stored in agentloop.policy.json (user-managed) and snapshotted per mission.
 */
export interface Policy {
  /** Allow local checkpoint commits on the mission branch */
  allowLocalCommit: boolean;
  /** Allow pushing to any remote — requires approval unless 'always' */
  allowPush: 'never' | 'approval' | 'always';
  /** Allow creating pull requests */
  allowPullRequest: 'never' | 'approval' | 'always';
  /** Merge is never automatic; kept for forward-compat */
  allowMerge: 'never';
  /** Allow agent processes to access the network (advisory flag) */
  allowNetwork: boolean;
  /** Hard defaults for mission budgets */
  maxMissionMinutes: number;
  maxRepairPasses: number;
  maxAgentInvocations: number;
  maxDiffBytes?: number;
  agentTimeoutMs: number;
  /**
   * Commands that may run as validation gates without approval.
   * Entries are exact argv prefixes, e.g. ["npm", "test"].
   */
  allowedCommands: string[][];
  /** Commands matched by prefix that always require approval */
  approvalRequiredCommands: string[][];
  /** Extra dangerous command patterns (see command-safety) */
  dangerousCommandPatterns: string[];
  /** Paths (repo-relative globs) agents may never modify */
  protectedPaths: string[];
  /** Maximum concurrent missions across the runtime */
  maxConcurrentMissions: number;
  /** Maximum concurrent missions per repository */
  maxConcurrentMissionsPerRepo: number;
  /** Approval wait timeout (ms) before mission is blocked */
  approvalTimeoutMs: number;
}

/** Policy resolved into a mission snapshot (identical shape, resolved) */
export type ResolvedPolicy = Policy;

// ─────────────────────────────────────────────────────────────────────────────
// Agent adapter contract
// ─────────────────────────────────────────────────────────────────────────────

/** Result of probing whether an agent CLI is usable */
export interface AgentAvailability {
  available: boolean;
  /** Resolved executable path if found */
  executable?: string;
  version?: string;
  error?: string;
}

/** Everything an adapter needs to launch one bounded invocation */
export interface AgentInvocationContext {
  /** The text handed to the agent (objective / repair prompt) */
  prompt: string;
  /** Working directory — the mission worktree */
  cwd: string;
  missionId: string;
  taskId?: string;
  pass: number;
  /** Abort signal for cancellation */
  signal: AbortSignal;
  /** Extra environment from agent config */
  env?: Record<string, string>;
  /** Per-invocation timeout */
  timeoutMs: number;
  /** Max bytes of combined output retained in memory */
  maxOutputBytes: number;
  /** File to append full output to (bounded, rotating) */
  logFile?: string;
}

/** The argv/env for one agent invocation — never a shell string */
export interface AgentInvocation {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** How a completed invocation ended */
export type AgentExitKind =
  | 'success'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'spawn-error';

/** Bounded result metadata for one agent invocation */
export interface AgentInvocationResult {
  exitKind: AgentExitKind;
  exitCode: number | null;
  signal?: string | null;
  durationMs: number;
  /** Tail of stdout+stderr, bounded */
  outputTail: string;
  /** True if output was truncated */
  outputTruncated: boolean;
  /** Path of the full (rotated) log file, if any */
  logFile?: string;
  pid?: number;
}

/**
 * Vendor-neutral adapter contract. Adapters translate a mission invocation
 * context into a concrete argv invocation, and classify the result.
 * No vendor-specific concepts may leak into the scheduler.
 */
export interface AgentAdapter {
  readonly type: string;
  readonly displayName: string;
  /** Probe local availability (never throws) */
  detect(config?: AgentConfig): Promise<AgentAvailability>;
  /** Build the invocation for one bounded run */
  buildInvocation(ctx: AgentInvocationContext, config: AgentConfig): AgentInvocation;
  /** Map an invocation result to an exit classification */
  classifyExit(result: AgentInvocationResult): AgentExitKind;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured events (bounded payloads; no secrets)
// ─────────────────────────────────────────────────────────────────────────────

export type RuntimeEventType =
  | 'mission_created'
  | 'mission_prepared'
  | 'task_started'
  | 'task_finished'
  | 'agent_started'
  | 'agent_finished'
  | 'file_activity_summary'
  | 'validation_started'
  | 'validation_finished'
  | 'review_finished'
  | 'approval_required'
  | 'approval_decided'
  | 'checkpoint_created'
  | 'state_changed'
  | 'mission_completed'
  | 'mission_failed'
  | 'mission_cancelled'
  | 'mission_blocked'
  | 'runner_heartbeat';

export interface RuntimeEvent {
  seq?: number;
  type: RuntimeEventType;
  at: string;
  missionId: string;
  /** Bounded, redacted payload */
  data?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime config (agentloop.config.json)
// ─────────────────────────────────────────────────────────────────────────────

/** A project/repository registered in config */
export interface ProjectConfig {
  name: string;
  workingDirectory: string;
  agents?: AgentConfig[];
}

/** agentloop.config.json — user-facing runtime configuration */
export interface RuntimeConfig {
  /** Named agent configurations */
  agents: AgentConfig[];
  /** Default agent name for new missions */
  defaultAgent?: string;
  /** Default working directory for missions in this repo */
  workingDirectory: string;
  /** Logging verbosity */
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  /** Multi-project mode */
  projects?: ProjectConfig[];
  /** Optional default validation gate commands by name */
  validationCommands?: Record<string, string[]>;
  /** Optional daemon overrides */
  daemon?: {
    host?: string;
    port?: number;
    token?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy compatibility layer (pre-1.x Qwen Loop types)
// ─────────────────────────────────────────────────────────────────────────────

/** Possible states for a task in the queue */
export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

/** Priority levels for task scheduling */
export enum TaskPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

/** @deprecated Legacy task shape kept for compatibility */
export interface Task {
  id: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  assignedAgent?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

/** @deprecated Legacy agent result shape */
export interface AgentResult {
  success: boolean;
  output?: string;
  error?: string;
  executionTime: number;
  filesModified?: string[];
  filesCreated?: string[];
  filesDeleted?: string[];
}

/** @deprecated Legacy loop statistics */
export interface LoopStats {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  runningTasks: number;
  activeAgents: number;
  uptime: number;
  averageExecutionTime: number;
  loopIterations?: number;
  maxLoopIterations?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Health reporting
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptimeMs: number;
  runtime: {
    version: string;
    pid: number;
    nodeVersion: string;
    platform: string;
  };
  missions: {
    total: number;
    byState: Record<string, number>;
    active: number;
    blocked: number;
    awaitingApproval: number;
    stale: number;
  };
  agents: Array<{
    name: string;
    type: string;
    available: boolean;
    version?: string;
    error?: string;
  }>;
  resources: {
    memoryRssBytes: number;
    heapUsedBytes: number;
    systemMemoryFreeBytes: number;
    systemMemoryTotalBytes: number;
    activeProcesses: number;
  };
  warnings: string[];
  errors: string[];
}
