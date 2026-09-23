import { supervise } from '../supervisor/process-supervisor.js';
import { toSpawnInvocation } from '../agents/cli-adapter-base.js';
import { classifyCommand } from '../policy/command-safety.js';
import { approvalCoversArgv, policyHash as computePolicyHash, verifyDecision } from '../policy/approvals.js';
import type { ApprovalRequest, GateResult, Policy } from '../types.js';
import { boundTail } from '../util/redact.js';
import { logger } from '../logger.js';

/**
 * Deterministic validation gates.
 *
 * Gate commands come ONLY from configuration — never from agent output or
 * repository text discovered at runtime. Each gate is classified through the
 * command-safety policy before execution; gates needing approval are skipped
 * with a note (the caller decides whether to raise an approval gate).
 */

export interface ValidationGate {
  name: string;
  argv: string[];
  timeoutMs?: number;
}

const DEFAULT_GATE_TIMEOUT_MS = 5 * 60 * 1000;
const GATE_OUTPUT_TAIL = 8 * 1024;

/**
 * Run a set of validation gates in the mission worktree.
 * Commands are resolved through toSpawnInvocation (Windows .cmd shims handled).
 * Returns per-gate results; a refused command produces a failed gate with a
 * note rather than executing.
 */
export async function runValidationGates(
  gates: ValidationGate[],
  cwd: string,
  policy: Policy,
  opts: { stopOnFirstFailure?: boolean; approved?: ApprovalRequest[] } = {}
): Promise<{ results: GateResult[]; allPassed: boolean; needsApproval: GateResult[] }> {
  const results: GateResult[] = [];
  const needsApproval: GateResult[] = [];
  const currentPolicyHash = computePolicyHash(policy);

  // Commands a human already approved for this mission run as allowed.
  // Binding rules: the approval must (a) be decided 'approved', (b) carry the
  // EXACT same argv — approving ["node","-e"] does not bless every `node -e`,
  // (c) be bound to the same policy fingerprint — a policy change or a
  // different gated scope invalidates the earlier approval — and (d) pass
  // decision-signature verification when AGENTLOOP_APPROVAL_KEY is configured:
  // a forged ledger entry is not a human decision, even at consumption time.
  const isApproved = (argv: string[]) =>
    (opts.approved ?? []).some(ap =>
      approvalCoversArgv(ap, argv) &&
      (ap.policyHash === undefined || ap.policyHash === currentPolicyHash) &&
      verifyDecision(ap) === 'ok');

  for (const gate of gates) {
    const verdict = isApproved(gate.argv)
      ? { risk: 'allowed' as const, reason: 'approved by operator' }
      : classifyCommand(gate.argv, policy);

    if (verdict.risk === 'refused') {
      const res: GateResult = {
        name: gate.name,
        command: gate.argv,
        exitCode: null,
        passed: false,
        durationMs: 0,
        note: `refused by policy: ${verdict.reason}`
      };
      results.push(res);
      if (opts.stopOnFirstFailure) break;
      continue;
    }

    if (verdict.risk === 'needs-approval') {
      const res: GateResult = {
        name: gate.name,
        command: gate.argv,
        exitCode: null,
        passed: false,
        durationMs: 0,
        note: `requires approval: ${verdict.reason}`
      };
      results.push(res);
      needsApproval.push(res);
      if (opts.stopOnFirstFailure) break;
      continue;
    }

    const started = Date.now();
    const inv = toSpawnInvocation({ command: gate.argv[0], args: gate.argv.slice(1) }, cwd);
    const result = await supervise({
      ...inv,
      cwd,
      timeoutMs: gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
      maxOutputBytes: GATE_OUTPUT_TAIL
    });

    const tail = boundTail(result.outputTail, GATE_OUTPUT_TAIL).text;
    const res: GateResult = {
      name: gate.name,
      command: gate.argv,
      exitCode: result.exitCode,
      passed: result.exitKind === 'success',
      durationMs: result.durationMs ?? (Date.now() - started),
      outputTail: tail,
      note: result.exitKind === 'timeout' ? 'gate timed out' : undefined
    };
    results.push(res);
    logger.info(`Gate ${res.passed ? '✓' : '✗'} ${gate.name}`, { duration: res.durationMs });
    if (!res.passed && opts.stopOnFirstFailure) break;
  }

  return {
    results,
    allPassed: results.length > 0 && results.every(r => r.passed),
    needsApproval
  };
}

/**
 * Resolve gate names → argv from config. `verificationCommands` in a mission
 * spec names gates that must exist in configured validationCommands (or are
 * given inline as argv arrays starting with '[' — no free-form shell).
 */
export function resolveGates(
  spec: { verificationCommands?: string[] },
  configured: Record<string, string[]> | undefined
): { gates: ValidationGate[]; unknown: string[] } {
  const gates: ValidationGate[] = [];
  const unknown: string[] = [];

  // If the spec names no gates, run all configured validation commands —
  // a repo's standard gates are authoritative by default.
  const entries = spec.verificationCommands ?? Object.keys(configured ?? {});
  for (const entry of entries) {
    const trimmed = entry.trim();
    // Named gate from config
    if (configured && configured[trimmed]) {
      gates.push({ name: trimmed, argv: configured[trimmed] });
      continue;
    }
    // Inline argv array: '["npm","test"]' — JSON only, never shell text
    if (trimmed.startsWith('[')) {
      try {
        const argv = JSON.parse(trimmed) as unknown;
        if (Array.isArray(argv) && argv.every(a => typeof a === 'string') && argv.length > 0) {
          gates.push({ name: (argv as string[]).join(' '), argv: argv as string[] });
          continue;
        }
      } catch { /* fall through */ }
    }
    // Bare words are NOT executed — we never run free-form text as a command
    unknown.push(trimmed);
  }

  return { gates, unknown };
}
