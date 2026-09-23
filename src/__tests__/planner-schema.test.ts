import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePlan, planFromResult, extractJsonArray, PlanValidationError
} from '../engine/planner.js';
import { TaskStatus } from '../types.js';
import type { AgentInvocationResult } from '../types.js';

/**
 * Planner schema hardening: planner output is untrusted agent text. Every
 * malformed or incomplete shape must be rejected deterministically with a
 * structured PlanValidationError listing all violations; unknown fields are
 * ignored per repo convention and can never widen authority.
 */

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof PlanValidationError, `expected PlanValidationError, got ${err}`);
    assert.equal(err.name, 'PlanValidationError');
    return err.issues;
  }
  assert.fail('expected validatePlan to throw');
}

function invocation(outputTail: string, exitKind: AgentInvocationResult['exitKind'] = 'success'): AgentInvocationResult {
  return { exitKind, exitCode: exitKind === 'success' ? 0 : 1, durationMs: 1, outputTail, outputTruncated: false };
}

describe('validatePlan — structural rejection', () => {
  test('non-array output rejected deterministically', () => {
    for (const raw of ['text', {}, null, 42, '[]']) {
      const issues = issuesOf(() => validatePlan(raw));
      // '[]' parses as a string here — still not an array input
      assert.ok(issues.length >= 1);
    }
    assert.match(issuesOf(() => validatePlan('no'))[0], /must be a JSON array/);
  });

  test('empty and oversized plans rejected', () => {
    assert.match(issuesOf(() => validatePlan([]))[0], /empty plan/);
    const big = Array.from({ length: 13 }, (_, i) => ({ title: `t${i}` }));
    assert.match(issuesOf(() => validatePlan(big))[0], /13 tasks \(max 12\)/);
  });

  test('malformed entries produce per-entry issues, all collected in order', () => {
    const issues = issuesOf(() => validatePlan([
      { dependsOn: [] },              // missing title
      'not-an-object',                // not an object
      { title: '   ' },               // blank title
      { title: 'ok', dependsOn: 'x' } // dependsOn not an array
    ]));
    assert.equal(issues.length, 4);
    assert.match(issues[0], /entry 0.*title/);
    assert.match(issues[1], /entry 1.*not an object/);
    assert.match(issues[2], /entry 2.*title/);
    assert.match(issues[3], /entry 3.*"dependsOn" must be an array/);
  });

  test('dependency errors are rejected deterministically', () => {
    const plan = [{ title: 'a' }, { title: 'b' }];
    assert.match(issuesOf(() => validatePlan([{ title: 'a', dependsOn: [0] }]))[0], /bad dep index 0/);
    assert.match(issuesOf(() => validatePlan([{ title: 'a', dependsOn: [2] }]))[0], /bad dep index 2/);
    assert.match(issuesOf(() => validatePlan([{ title: 'a', dependsOn: [-1] }]))[0], /bad dep index -1/);
    assert.match(issuesOf(() => validatePlan([{ title: 'a', dependsOn: [1.5] }]))[0], /must be index or title/);
    assert.match(issuesOf(() => validatePlan([{ title: 'a', dependsOn: ['ghost'] }]))[0], /unknown dep 'ghost'/);
    assert.match(issuesOf(() => validatePlan([{ title: 'a', dependsOn: [null] }]))[0], /must be index or title/);
    // self-dependency and cycles surface through graph validation
    assert.match(issuesOf(() => validatePlan([{ title: 'a', dependsOn: [1] }]))[0], /self-dependency/);
    assert.match(issuesOf(() => validatePlan([
      { title: 'a', dependsOn: [2] }, { title: 'b', dependsOn: [1] }
    ]))[0], /cycle/);
    assert.deepEqual(validatePlan(plan).tasks.length, 2);
  });

  test('duplicate titles rejected — title deps would be ambiguous', () => {
    const issues = issuesOf(() => validatePlan([{ title: 'same' }, { title: 'same' }]));
    assert.ok(issues.some(i => /duplicated/.test(i)));
  });

  test('title length bound enforced', () => {
    assert.match(issuesOf(() => validatePlan([{ title: 'x'.repeat(2001) }]))[0], /title too long/);
    assert.equal(validatePlan([{ title: 'x'.repeat(2000) }]).tasks.length, 1);
  });
});

describe('validatePlan — unknown fields and declared scope requests', () => {
  test('unknown fields are ignored and never widen authority', () => {
    const { tasks, requests } = validatePlan([{
      title: 'work', permissions: ['*'], budget: 999, scope: ['/'],
      tools: ['shell'], policy: { allowPush: 'always' }, extra: { nested: true }
    }]);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'work');
    assert.deepEqual(requests.paths, []);
    assert.deepEqual(requests.commands, []);
    // The TaskNode carries only the schema fields — nothing leaks through.
    assert.deepEqual(Object.keys(tasks[0]).sort(), ['dependsOn', 'id', 'pass', 'status', 'title']);
  });

  test('valid paths/commands declarations aggregate into requests', () => {
    const { requests } = validatePlan([
      { title: 'a', paths: ['src/', 'docs/x.md'], commands: [['npm', 'test']] },
      { title: 'b', dependsOn: [1], paths: ['src/', 'scripts/build.sh'], commands: [['npm', 'test'], ['node', '-e', '1']] }
    ]);
    // deduped, insertion order, verbatim paths (trailing '/' is meaningful)
    assert.deepEqual(requests.paths, ['src/', 'docs/x.md', 'scripts/build.sh']);
    assert.deepEqual(requests.commands, [['npm', 'test'], ['node', '-e', '1']]);
  });

  test('dirty paths rejected: absolute, drive-qualified, traversal, empty, aliasing', () => {
    const issues = issuesOf(() => validatePlan([
      { title: 'a', paths: ['/etc/passwd', 'C:/win', '../escape', 'ok/../back', '', './alias', 'fine/ok.txt'] }
    ]));
    assert.equal(issues.length, 6, JSON.stringify(issues));
    assert.ok(issues.every(i => /entry 0.*invalid path/.test(i)));
  });

  test('non-array paths rejected', () => {
    assert.match(issuesOf(() => validatePlan([{ title: 'a', paths: 'src/' }]))[0], /"paths" must be an array/);
    assert.match(issuesOf(() => validatePlan([{ title: 'a', paths: [42] }]))[0], /invalid path 42/);
  });

  test('malformed commands rejected; valid argv arrays pass', () => {
    assert.match(issuesOf(() => validatePlan([{ title: 'a', commands: 'npm test' }]))[0], /"commands" must be an array/);
    assert.match(issuesOf(() => validatePlan([{ title: 'a', commands: [[]] }]))[0], /non-empty argv string arrays/);
    assert.match(issuesOf(() => validatePlan([{ title: 'a', commands: [['ok', 1]] }]))[0], /non-empty argv string arrays/);
    const { requests } = validatePlan([{ title: 'a', commands: [['git', 'status']] }]);
    assert.deepEqual(requests.commands, [['git', 'status']]);
  });

  test('per-task declaration caps are enforced', () => {
    const manyPaths = Array.from({ length: 41 }, (_, i) => `p/${i}`);
    assert.match(issuesOf(() => validatePlan([{ title: 'a', paths: manyPaths }]))[0], /41 entries \(max 40\)/);
    const manyCmds = Array.from({ length: 21 }, (_, i) => ['c', String(i)]);
    assert.match(issuesOf(() => validatePlan([{ title: 'a', commands: manyCmds }]))[0], /21 entries \(max 20\)/);
  });
});

describe('planFromResult', () => {
  test('valid agent plan carries tasks AND declared requests', () => {
    const out = JSON.stringify([{ title: 'do it', dependsOn: [], paths: ['src/'] }]);
    const r = planFromResult(invocation(out));
    assert.equal(r.source, 'agent');
    assert.equal(r.tasks.length, 1);
    assert.equal(r.tasks[0].status, TaskStatus.PENDING);
    assert.deepEqual(r.requests?.paths, ['src/']);
  });

  test('fenced JSON in prose still parses', () => {
    const r = planFromResult(invocation('Here is the plan:\n```json\n[{"title":"x"}]\n```\nDone.'));
    assert.equal(r.source, 'agent');
    assert.equal(r.tasks[0].title, 'x');
  });

  test('non-success exit, missing JSON, and invalid plans all fall back with errors', () => {
    for (const [result, match] of [
      [invocation('', 'failed'), /failed/],
      [invocation('no array here'), /no JSON/],
      [invocation('[{"dependsOn":[]}]'), /title/],
      [invocation('[{"title":"a","dependsOn":[9]}]'), /bad dep index/]
    ] as const) {
      const r = planFromResult(result);
      assert.equal(r.source, 'fallback');
      assert.equal(r.tasks.length, 1, 'fallback is the deterministic single task');
      assert.equal(r.tasks[0].title, 'Execute mission objective');
      assert.match(r.error ?? '', match);
      // A fallback plan NEVER carries requests — invalid output grants nothing.
      assert.equal(r.requests, undefined);
    }
  });

  test('plan validation error text is the structured issue list', () => {
    const r = planFromResult(invocation('[{"title":"a","dependsOn":[9]}]'));
    assert.equal(r.source, 'fallback');
    assert.match(r.error ?? '', /bad dep index 9/);
  });
});

describe('extractJsonArray', () => {
  test('extracts arrays from raw text and fences; null on garbage', () => {
    assert.deepEqual(extractJsonArray('[{"title":"a"}]'), [{ title: 'a' }]);
    assert.deepEqual(extractJsonArray('pre ```\n[1,2]\n``` post'), [1, 2]);
    assert.equal(extractJsonArray('{"title":"a"}'), null);
    assert.equal(extractJsonArray('[unclosed'), null);
    assert.equal(extractJsonArray(''), null);
  });
});
