import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskGraph, findCycle, readyTasks, graphComplete, blockedTasks } from '../engine/task-graph.js';
import { TaskStatus } from '../types.js';
import type { TaskNode } from '../types.js';

function t(id: string, deps: string[] = [], status = TaskStatus.PENDING): TaskNode {
  return { id, title: id, dependsOn: deps, status };
}

describe('task DAG validation', () => {
  test('valid linear chain passes', () => {
    const tasks = [t('a'), t('b', ['a']), t('c', ['b'])];
    assert.deepEqual(validateTaskGraph(tasks), []);
  });

  test('missing dependency rejected', () => {
    const errs = validateTaskGraph([t('a', ['ghost'])]);
    assert.ok(errs.length > 0);
    assert.ok(errs[0].includes('ghost'));
  });

  test('duplicate task ids rejected', () => {
    const errs = validateTaskGraph([t('a'), t('a')]);
    assert.ok(errs.length > 0);
  });

  test('self-dependency rejected', () => {
    const errs = validateTaskGraph([t('a', ['a'])]);
    assert.ok(errs.length > 0);
  });
});

describe('cycle detection', () => {
  test('no cycle → null', () => {
    assert.equal(findCycle([t('a'), t('b', ['a']), t('c', ['a','b'])]), null);
  });

  test('direct cycle detected', () => {
    const cycle = findCycle([t('a', ['b']), t('b', ['a'])]);
    assert.ok(cycle);
    assert.ok(cycle!.includes('a') || cycle!.includes('b'));
  });

  test('indirect cycle detected', () => {
    const cycle = findCycle([t('a'), t('b', ['a','c']), t('c', ['b'])]);
    assert.ok(cycle);
  });
});

describe('ready set computation', () => {
  test('roots are ready first', () => {
    const tasks = [t('a'), t('b', ['a']), t('c', ['b'])];
    assert.deepEqual(readyTasks(tasks).map(x => x.id), ['a']);
  });

  test('unblocked children become ready when deps complete', () => {
    const tasks = [
      t('a', [], TaskStatus.COMPLETED),
      t('b', ['a']),
      t('c', ['b'])
    ];
    assert.deepEqual(readyTasks(tasks).map(x => x.id), ['b']);
  });

  test('failed dep does not unblock children', () => {
    const tasks = [
      t('a', [], TaskStatus.FAILED),
      t('b', ['a'])
    ];
    assert.equal(readyTasks(tasks).length, 0);
  });

  test('diamond: both parents must finish', () => {
    const tasks = [
      t('a'), t('b'),
      t('c', ['a', 'b'])
    ];
    assert.deepEqual(readyTasks(tasks).map(x => x.id).sort(), ['a', 'b']);
    tasks[0].status = TaskStatus.COMPLETED;
    assert.deepEqual(readyTasks(tasks).map(x => x.id), ['b']);
    tasks[1].status = TaskStatus.COMPLETED;
    assert.deepEqual(readyTasks(tasks).map(x => x.id), ['c']);
  });
});

describe('completion and blocked detection', () => {
  test('graphComplete when all terminal', () => {
    assert.ok(graphComplete([t('a', [], TaskStatus.COMPLETED), t('b', [], TaskStatus.FAILED)]));
    assert.ok(!graphComplete([t('a', [], TaskStatus.COMPLETED), t('b')]));
  });

  test('blockedTasks finds stranded work', () => {
    const tasks = [
      t('a', [], TaskStatus.FAILED),
      t('b', ['a'])
    ];
    const blocked = blockedTasks(tasks);
    assert.deepEqual(blocked.map(x => x.id), ['b']);
  });
});
