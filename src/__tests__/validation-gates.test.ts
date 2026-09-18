import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runValidationGates, resolveGates } from '../engine/validation-gates.js';
import { resolvePolicy } from '../policy/policy.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';

const NODE = execPath;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'alr-gates-'));
}

// Policy where NOTHING is allowlisted — every command classifies
// needs-approval, mirroring a locked-down mission.
function lockedPolicy() {
  const p = resolvePolicy();
  p.allowedCommands = [];
  p.approvalRequiredCommands = [];
  return p;
}

test('needs-approval gate is NOT executed without approval', async () => {
  const cwd = tmp();
  const gate = { name: 'check', argv: [NODE, '-e', "require('fs').writeFileSync('ran.txt','1')"] };
  const { results, allPassed, needsApproval } = await runValidationGates(
    [gate], cwd, lockedPolicy()
  );
  assert.equal(needsApproval.length, 1);
  assert.equal(allPassed, false);
  assert.match(results[0].note ?? '', /requires approval/);
  // Side effect must NOT have happened — the command never ran
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(cwd, 'ran.txt')), false);
});

test('approved command executes on re-validation instead of re-asking', async () => {
  const cwd = tmp();
  const argv = [NODE, '-e', "require('fs').writeFileSync('ran.txt','1')"];
  const gate = { name: 'check', argv };

  // First pass: needs approval
  const first = await runValidationGates([gate], cwd, lockedPolicy());
  assert.equal(first.needsApproval.length, 1);

  // Operator approves → sticky approval passed back in → gate RUNS
  const second = await runValidationGates([gate], cwd, lockedPolicy(), {
    approvedArgv: [argv]
  });
  assert.equal(second.needsApproval.length, 0);
  assert.equal(second.allPassed, true);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(cwd, 'ran.txt')), true);
});

test('approvedArgv prefix matches longer argv (same command, extra args)', async () => {
  const cwd = tmp();
  const approved = [NODE, '-e'];
  const gate = { name: 'check', argv: [NODE, '-e', 'process.exit(0)'] };
  const { allPassed, needsApproval } = await runValidationGates(
    [gate], cwd, lockedPolicy(), { approvedArgv: [approved] }
  );
  assert.equal(needsApproval.length, 0);
  assert.equal(allPassed, true);
});

test('different command is NOT covered by an unrelated approval', async () => {
  const cwd = tmp();
  const gate = { name: 'check', argv: [NODE, '-e', 'process.exit(0)'] };
  const { needsApproval } = await runValidationGates(
    [gate], cwd, lockedPolicy(),
    { approvedArgv: [[NODE, '--version']] }
  );
  assert.equal(needsApproval.length, 1);
});

test('refused command fails the gate and never executes', async () => {
  const cwd = tmp();
  const gate = { name: 'evil', argv: ['git', 'push', '--force', 'origin', 'main'] };
  const { results, allPassed, needsApproval } = await runValidationGates(
    [gate], cwd, lockedPolicy()
  );
  assert.equal(needsApproval.length, 0);
  assert.equal(allPassed, false);
  assert.match(results[0].note ?? '', /refused/);
});

test('failing gate fails allPassed; passing gate passes', async () => {
  const cwd = tmp();
  const p = resolvePolicy();
  p.allowedCommands = [[NODE]];
  const ok = { name: 'ok', argv: [NODE, '-e', 'process.exit(0)'] };
  const bad = { name: 'bad', argv: [NODE, '-e', 'process.exit(7)'] };
  const { results, allPassed } = await runValidationGates([ok, bad], cwd, p);
  assert.equal(allPassed, false);
  assert.equal(results[0].passed, true);
  assert.equal(results[1].passed, false);
  assert.equal(results[1].exitCode, 7);
});

test('resolveGates: spec names gate from config; bare words are never executed', () => {
  const configured = { test: [NODE, '-e', 'process.exit(0)'] };
  const named = resolveGates({ verificationCommands: ['test'] }, configured);
  assert.equal(named.gates.length, 1);
  assert.equal(named.unknown.length, 0);

  const bare = resolveGates({ verificationCommands: ['rm -rf /'] }, configured);
  assert.equal(bare.gates.length, 0);
  assert.equal(bare.unknown.length, 1);

  const inline = resolveGates(
    { verificationCommands: [`["${NODE.replace(/\\/g, '\\\\')}","--version"]`] },
    configured
  );
  assert.equal(inline.gates.length, 1);

  // No spec gates → all configured gates run by default
  const all = resolveGates({}, configured);
  assert.equal(all.gates.length, 1);
});
