import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  requestApproval, decideApproval, loadApprovals,
  approvalCoversPath, grantedScopePaths, approvalFingerprint
} from '../policy/approvals.js';
import { pathInScope } from '../policy/command-safety.js';
import { outstandingExpansion, effectiveScopePaths, expansionDetail } from '../engine/scope-expansion.js';
import { resolvePolicy } from '../policy/policy.js';
import type { ApprovalRequest, Mission } from '../types.js';

/**
 * Scope-expansion primitives: an approval widens the envelope by exactly the
 * paths/commands it lists — and only when bound to the mission's policy
 * fingerprint + worktree and verifiably decided.
 */

let dir: string;
const mkDir = () => { dir = mkdtempSync(join(tmpdir(), 'alr-scope-')); return dir; };

function mission(extra: { scope?: string[]; policyHash?: string; worktree?: string } = {}): Mission {
  return {
    spec: { objective: 'o', acceptanceCriteria: ['c'], ...(extra.scope ? { scope: extra.scope } : {}) },
    policy: resolvePolicy({ allowedCommands: [['npm', 'test']] }),
    policyHash: extra.policyHash ?? 'ph',
    workspace: { mode: 'worktree', path: extra.worktree ?? '/wt/1' }
  } as unknown as Mission;
}

function approvedReq(partial: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: `ap_${Math.random().toString(16).slice(2, 8)}`,
    gate: 'scope-expansion', detail: 'd', status: 'approved',
    requestedAt: new Date().toISOString(), decidedAt: new Date().toISOString(),
    decidedBy: 'op', ...partial
  };
}

describe('pathInScope', () => {
  test('scope entries cover exact paths and descendants — never sibling prefixes', () => {
    assert.ok(pathInScope('src/a.ts', ['src/']));
    assert.ok(pathInScope('src/a.ts', ['src']));
    assert.ok(pathInScope('src', ['src']));
    assert.ok(!pathInScope('other/a.ts', ['src']));
    assert.ok(!pathInScope('srcfoo/a.ts', ['src']), 'bare-prefix bleed is not scope');
    assert.ok(!pathInScope('srcfoo', ['src/']));
    assert.ok(!pathInScope('x', []));
    assert.ok(pathInScope('a\\b\\c.ts', ['a/']), 'backslashes normalize to scope separators');
  });
});

describe('scope-expansion approval records', () => {
  test('request persists the exact path set; identical pending requests dedupe', () => {
    const d = mkDir();
    const a = requestApproval(d, 'm1', 'scope-expansion', 'widen', undefined,
      { policyHash: 'ph', worktree: '/wt/1', paths: ['src/new/', 'tools/x.sh'] });
    assert.deepEqual(a.paths, ['src/new/', 'tools/x.sh']);
    const b = requestApproval(d, 'm1', 'scope-expansion', 'widen', undefined,
      { policyHash: 'ph', worktree: '/wt/1', paths: ['tools/x.sh', 'src/new/'] });
    assert.equal(a.id, b.id, 'same expansion set dedupes regardless of order');
    assert.equal(loadApprovals(d).length, 1);
    rmSync(d, { recursive: true, force: true });
  });

  test('a different path set is a different gate — approvals do not bleed over', () => {
    const d = mkDir();
    requestApproval(d, 'm1', 'scope-expansion', 'a', undefined, { paths: ['a/'] });
    requestApproval(d, 'm1', 'scope-expansion', 'b', undefined, { paths: ['b/'] });
    assert.equal(loadApprovals(d).length, 2);
    rmSync(d, { recursive: true, force: true });
  });

  test('approvalFingerprint distinguishes identical gates with different paths', () => {
    const base = { gate: 'scope-expansion' as const, policyHash: 'p', worktree: '/w' };
    assert.notEqual(
      approvalFingerprint({ ...base, paths: ['a'] }),
      approvalFingerprint({ ...base, paths: ['b'] }));
  });
});

describe('grantedScopePaths', () => {
  test('approved scope-expansion paths widen the envelope — bound and verified only', () => {
    const m = mission({ scope: ['src/'], policyHash: 'ph', worktree: '/wt/1' });
    const approvals = [
      approvedReq({ paths: ['extra/'], policyHash: 'ph', worktree: '/wt/1' }),
      approvedReq({ paths: ['wrong-policy/'], policyHash: 'other', worktree: '/wt/1' }),
      approvedReq({ paths: ['wrong-wt/'], policyHash: 'ph', worktree: '/wt/2' }),
      approvedReq({ gate: 'push', paths: ['not-a-scope-gate/'], policyHash: 'ph', worktree: '/wt/1' }),
      approvedReq({ status: 'pending', paths: ['undecided/'], policyHash: 'ph', worktree: '/wt/1' })
    ];
    assert.deepEqual(grantedScopePaths(approvals, { policyHash: 'ph', worktree: '/wt/1' }), ['extra/']);
    assert.deepEqual(effectiveScopePaths(m, approvals), ['src/', 'extra/']);
  });

  test('unsigned approved decisions grant nothing when AGENTLOOP_APPROVAL_KEY is set', () => {
    const key = 'test-fixture-key';
    const prev = process.env.AGENTLOOP_APPROVAL_KEY;
    process.env.AGENTLOOP_APPROVAL_KEY = key;
    try {
      const d = mkDir();
      const req = requestApproval(d, 'm1', 'scope-expansion', 'widen', undefined, { paths: ['x/'] });
      const signed = decideApproval(d, 'm1', req.id, 'approved', 'op')!;
      assert.deepEqual(grantedScopePaths([signed], {}), ['x/']);
      // Forge: strip the signature — same payload, no human signature.
      const forged = { ...signed, sig: undefined };
      assert.deepEqual(grantedScopePaths([forged], {}), []);
      const badSig = { ...signed, sig: 'deadbeef' };
      assert.deepEqual(grantedScopePaths([badSig], {}), []);
      rmSync(d, { recursive: true, force: true });
    } finally {
      if (prev === undefined) delete process.env.AGENTLOOP_APPROVAL_KEY;
      else process.env.AGENTLOOP_APPROVAL_KEY = prev;
    }
  });
});

describe('approvalCoversPath', () => {
  test('grant covers exactly the listed paths and their children', () => {
    const req = approvedReq({ paths: ['src/new', 'one-file.txt'] });
    assert.ok(approvalCoversPath(req, 'src/new'));
    assert.ok(approvalCoversPath(req, 'src/new/deep/x.ts'));
    assert.ok(approvalCoversPath(req, 'one-file.txt'));
    assert.ok(!approvalCoversPath(req, 'src/old/x.ts'));
    assert.ok(!approvalCoversPath(req, 'other-file.txt'));
    assert.ok(!approvalCoversPath({ ...req, status: 'pending' }, 'src/new'));
    assert.ok(!approvalCoversPath(approvedReq({ paths: undefined }), 'x'));
  });
});

describe('outstandingExpansion', () => {
  const reqs = { paths: ['src/ok.ts', 'outside/x.ts'], commands: [['npm', 'test'], ['deploy', '--prod']] };

  test('returns only what exceeds spec.scope and allowedCommands', () => {
    const m = mission({ scope: ['src/'] });
    const out = outstandingExpansion(m, reqs, []);
    assert.deepEqual(out.paths, ['outside/x.ts']);
    assert.deepEqual(out.commands, [['deploy', '--prod']]);
  });

  test('no declared scope → path requests are not expansion (envelope unbounded)', () => {
    const m = mission();
    const out = outstandingExpansion(m, reqs, []);
    assert.deepEqual(out.paths, []);
    assert.deepEqual(out.commands, [['deploy', '--prod']], 'commands still classify against policy');
  });

  test('already-granted requests never re-gate', () => {
    const m = mission({ scope: ['src/'], policyHash: 'ph', worktree: '/w' });
    const grants = [
      approvedReq({ paths: ['outside/'], policyHash: 'ph', worktree: '/w' }),
      approvedReq({ commands: [['deploy', '--prod']], policyHash: 'ph', worktree: '/w' })
    ];
    const out = outstandingExpansion(m, reqs, grants);
    assert.deepEqual(out.paths, []);
    assert.deepEqual(out.commands, []);
  });

  test('no requests → nothing outstanding', () => {
    const m = mission({ scope: ['src/'] });
    assert.deepEqual(outstandingExpansion(m, undefined, []), { paths: [], commands: [] });
    assert.deepEqual(outstandingExpansion(m, { paths: [], commands: [] }, []), { paths: [], commands: [] });
  });

  test('expansionDetail names the exact expansion', () => {
    const d = expansionDetail('Plan requests scope', {
      paths: ['a.ts'], commands: [['x', 'y']]
    });
    assert.match(d, /a\.ts/);
    assert.match(d, /x y/);
  });
});
