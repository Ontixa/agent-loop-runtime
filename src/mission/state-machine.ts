import { MissionState, TERMINAL_MISSION_STATES } from '../types.js';

/**
 * Mission state machine.
 *
 * Legal transitions are exhaustive and enforced — an illegal transition throws
 * IllegalTransitionError. Terminal states have no outgoing edges.
 *
 *   created → prepared → running ⇄ validating → repairing ↻
 *                ↑ pause/resume ↓        ↓
 *         waiting_for_approval → blocked → prepared
 *         running → stale → prepared   (crash recovery)
 *         * → cancelled / failed       (terminal)
 *         validating → completed       (terminal)
 */

const TRANSITIONS: ReadonlyMap<MissionState, ReadonlySet<MissionState>> = new Map([
  [MissionState.CREATED, new Set([MissionState.PREPARED, MissionState.CANCELLED, MissionState.FAILED])],
  [MissionState.PREPARED, new Set([
    MissionState.RUNNING, MissionState.PAUSED, MissionState.CANCELLED, MissionState.FAILED, MissionState.STALE
  ])],
  [MissionState.RUNNING, new Set([
    MissionState.PAUSED, MissionState.VALIDATING, MissionState.WAITING_FOR_APPROVAL,
    MissionState.BLOCKED, MissionState.FAILED, MissionState.CANCELLED, MissionState.STALE
  ])],
  [MissionState.PAUSED, new Set([
    MissionState.RUNNING, MissionState.CANCELLED, MissionState.FAILED, MissionState.STALE
  ])],
  [MissionState.WAITING_FOR_APPROVAL, new Set([
    MissionState.RUNNING, MissionState.REPAIRING, MissionState.VALIDATING,
    MissionState.BLOCKED, MissionState.CANCELLED, MissionState.FAILED, MissionState.STALE,
    // pausing while waiting stops the poll loop; resume re-reads the ledger
    MissionState.PAUSED,
    // recovery re-prepares: re-driving the step re-reads the persisted decision
    MissionState.PREPARED
  ])],
  [MissionState.VALIDATING, new Set([
    MissionState.COMPLETED, MissionState.REPAIRING, MissionState.WAITING_FOR_APPROVAL,
    MissionState.PAUSED, MissionState.BLOCKED, MissionState.FAILED, MissionState.CANCELLED,
    MissionState.STALE
  ])],
  [MissionState.REPAIRING, new Set([
    MissionState.VALIDATING, MissionState.WAITING_FOR_APPROVAL, MissionState.PAUSED,
    MissionState.BLOCKED, MissionState.FAILED, MissionState.CANCELLED, MissionState.STALE
  ])],
  [MissionState.BLOCKED, new Set([MissionState.PREPARED, MissionState.CANCELLED, MissionState.FAILED])],
  [MissionState.STALE, new Set([MissionState.PREPARED, MissionState.CANCELLED, MissionState.FAILED])],
  [MissionState.COMPLETED, new Set()],
  [MissionState.FAILED, new Set()],
  [MissionState.CANCELLED, new Set()]
]);

export class IllegalTransitionError extends Error {
  constructor(from: MissionState, to: MissionState) {
    super(`Illegal mission transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
    Object.setPrototypeOf(this, IllegalTransitionError.prototype);
  }
}

export function canTransition(from: MissionState, to: MissionState): boolean {
  return TRANSITIONS.get(from)?.has(to) ?? false;
}

/** Throw unless the transition is legal. */
export function assertTransition(from: MissionState, to: MissionState): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

export function isTerminal(state: MissionState): boolean {
  return TERMINAL_MISSION_STATES.has(state);
}

/** States in which a runner process may legitimately be driving the mission. */
export function isActiveState(state: MissionState): boolean {
  return [
    MissionState.RUNNING, MissionState.VALIDATING,
    MissionState.REPAIRING, MissionState.PREPARED
  ].includes(state);
}

/** States from which `resume` can re-drive the mission. */
export function isResumable(state: MissionState): boolean {
  return [
    MissionState.PAUSED, MissionState.BLOCKED, MissionState.STALE,
    MissionState.WAITING_FOR_APPROVAL, MissionState.PREPARED
  ].includes(state);
}
