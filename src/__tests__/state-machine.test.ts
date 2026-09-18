import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition, assertTransition, isTerminal, isActiveState,
  IllegalTransitionError
} from '../mission/state-machine.js';
import { MissionState } from '../types.js';

const S = MissionState;

describe('mission state machine', () => {
  test('normal lifecycle path is legal', () => {
    const path = [S.CREATED, S.PREPARED, S.RUNNING, S.VALIDATING, S.REPAIRING, S.VALIDATING, S.COMPLETED];
    for (let i = 1; i < path.length; i++) {
      assert.ok(canTransition(path[i - 1], path[i]), `${path[i - 1]} → ${path[i]} should be legal`);
    }
  });

  test('terminal states cannot be left', () => {
    for (const terminal of [S.COMPLETED, S.FAILED, S.CANCELLED]) {
      for (const target of Object.values(S)) {
        assert.equal(canTransition(terminal, target), false, `${terminal} → ${target} must be illegal`);
      }
      assert.ok(isTerminal(terminal));
    }
  });

  test('cannot skip preparation: created → running is illegal', () => {
    assert.equal(canTransition(S.CREATED, S.RUNNING), false);
    assert.equal(canTransition(S.CREATED, S.COMPLETED), false);
    assert.equal(canTransition(S.CREATED, S.VALIDATING), false);
  });

  test('cannot jump straight to completed without validation', () => {
    assert.equal(canTransition(S.RUNNING, S.COMPLETED), false);
    assert.equal(canTransition(S.PREPARED, S.COMPLETED), false);
    assert.equal(canTransition(S.REPAIRING, S.COMPLETED), false);
  });

  test('pause/resume/cancel paths', () => {
    assert.ok(canTransition(S.RUNNING, S.PAUSED));
    assert.ok(canTransition(S.PAUSED, S.RUNNING)); // resume re-drives
    assert.ok(canTransition(S.RUNNING, S.CANCELLED));
    assert.ok(canTransition(S.PAUSED, S.CANCELLED));
  });

  test('approval gate path', () => {
    assert.ok(canTransition(S.RUNNING, S.WAITING_FOR_APPROVAL));
    assert.ok(canTransition(S.WAITING_FOR_APPROVAL, S.RUNNING));
    assert.ok(canTransition(S.WAITING_FOR_APPROVAL, S.CANCELLED));
    assert.ok(canTransition(S.WAITING_FOR_APPROVAL, S.STALE));
    assert.equal(canTransition(S.WAITING_FOR_APPROVAL, S.COMPLETED), false);
  });

  test('stale recovery only goes to prepared', () => {
    assert.ok(canTransition(S.STALE, S.PREPARED));
    assert.equal(canTransition(S.STALE, S.RUNNING), false);
    assert.equal(canTransition(S.STALE, S.COMPLETED), false);
  });

  test('assertTransition throws IllegalTransitionError with message', () => {
    assert.throws(() => assertTransition(S.COMPLETED, S.RUNNING), IllegalTransitionError);
    assert.throws(() => assertTransition(S.CREATED, S.COMPLETED), /created.*completed/);
  });

  test('active states cover the mid-flight set', () => {
    assert.ok(isActiveState(S.RUNNING));
    assert.ok(isActiveState(S.VALIDATING));
    assert.ok(isActiveState(S.REPAIRING));
    assert.ok(!isActiveState(S.COMPLETED));
    assert.ok(!isActiveState(S.PAUSED));
  });
});
