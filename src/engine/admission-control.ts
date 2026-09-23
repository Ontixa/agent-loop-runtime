import { cpus, freemem, loadavg, totalmem } from 'os';
import type { RuntimeConfig } from '../types.js';

/**
 * Resource-aware admission control for the mission scheduler.
 *
 * The scheduler samples host pressure before admitting queued missions and
 * defers ALL new admissions while the host is over a configured threshold.
 * Deferral never touches running or queued missions — it only delays the
 * transition queue → running — and is re-evaluated on a bounded timer so a
 * host that recovers resumes admission without operator action.
 *
 * Everything here is a pure function over an injected sample — the scheduler
 * owns the timer, tests own the clock and the probe.
 *
 * Honest limits:
 * - `os.loadavg()` is `[0,0,0]` on Windows — the load check can never trip
 *   there; the memory check is the portable guard.
 * - The probe observes the whole host, not just this runtime's processes.
 *   Deferral is a courtesy brake, not an isolation or QoS mechanism.
 */

/** A point-in-time host pressure sample. */
export interface HostPressure {
  /** 1-minute load average divided by logical CPU count. 0 on Windows. */
  loadPerCpu: number;
  /** Fraction of total system memory currently free, in [0, 1]. */
  freeMemRatio: number;
}

/**
 * Resolved admission thresholds. A threshold <= 0 disables that check;
 * `enabled: false` disables the whole gate.
 */
export interface AdmissionLimits {
  /** Master switch. Default true. */
  enabled: boolean;
  /**
   * Defer when loadavg(1m) / logical CPUs exceeds this. Default 2.
   * Inert on Windows (loadavg is always 0 there).
   */
  maxLoadPerCpu: number;
  /** Defer when freemem/totalmem falls below this ratio. Default 0.05. */
  minFreeMemRatio: number;
  /** Delay before re-sampling while deferred, ms. Default 30000. */
  recheckMs: number;
}

export const DEFAULT_ADMISSION_LIMITS: AdmissionLimits = {
  enabled: true,
  maxLoadPerCpu: 2,
  minFreeMemRatio: 0.05,
  recheckMs: 30_000
};

export type PressureProbe = () => HostPressure;

/** Config-file shape (`daemon.admission` in agentloop.config.json). */
export type AdmissionConfig = NonNullable<RuntimeConfig['daemon']>['admission'];

/** Merge partial `daemon.admission` config over the documented defaults. */
export function resolveAdmissionLimits(cfg?: AdmissionConfig): AdmissionLimits {
  return {
    enabled: cfg?.enabled ?? DEFAULT_ADMISSION_LIMITS.enabled,
    maxLoadPerCpu: cfg?.maxLoadPerCpu ?? DEFAULT_ADMISSION_LIMITS.maxLoadPerCpu,
    minFreeMemRatio: cfg?.minFreeMemRatio ?? DEFAULT_ADMISSION_LIMITS.minFreeMemRatio,
    recheckMs: cfg?.recheckMs ?? DEFAULT_ADMISSION_LIMITS.recheckMs
  };
}

/**
 * Real host probe. On Windows `loadavg()` returns zeros, so `loadPerCpu`
 * stays 0 and the load check cannot trip — documented platform limit.
 */
export const hostPressureProbe: PressureProbe = () => {
  const cores = Math.max(cpus().length, 1);
  const total = totalmem();
  return {
    loadPerCpu: loadavg()[0] / cores,
    freeMemRatio: total > 0 ? freemem() / total : 1
  };
};

export interface AdmissionDecision {
  admit: boolean;
  /** Human/machine-readable reason when admission is deferred. */
  reason?: string;
  /** The sample that produced the decision (present on deferral). */
  sample?: HostPressure;
}

/**
 * Pure admission check. Deferral is reported with a stable reason string —
 * the scheduler records it verbatim as a `mission_deferred` event.
 */
export function evaluateAdmission(limits: AdmissionLimits, sample: HostPressure): AdmissionDecision {
  if (!limits.enabled) return { admit: true };
  const reasons: string[] = [];
  if (limits.maxLoadPerCpu > 0 && sample.loadPerCpu > limits.maxLoadPerCpu) {
    reasons.push(`load ${sample.loadPerCpu.toFixed(2)}/cpu > ${limits.maxLoadPerCpu}`);
  }
  if (limits.minFreeMemRatio > 0 && sample.freeMemRatio < limits.minFreeMemRatio) {
    reasons.push(`free memory ${(sample.freeMemRatio * 100).toFixed(1)}% < ${limits.minFreeMemRatio * 100}%`);
  }
  if (reasons.length === 0) return { admit: true };
  return { admit: false, reason: `host pressure: ${reasons.join('; ')}`, sample };
}
