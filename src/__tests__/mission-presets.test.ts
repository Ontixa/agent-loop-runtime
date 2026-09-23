import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listPresets, getPreset, resolvePresetMission, validatePresetShape,
  PresetError, PRESET_NAME_RE
} from '../engine/mission-presets.js';
import { BUILTIN_PRESETS } from '../engine/builtin-presets.js';
import { outstandingExpansion } from '../engine/scope-expansion.js';
import { classifyCommand } from '../policy/command-safety.js';
import { resolvePolicy, DEFAULT_POLICY } from '../policy/policy.js';
import type { Mission, RuntimeConfig } from '../types.js';

/**
 * Maintenance-mission presets: resolution into the existing Mission/policy
 * model (spec.scope + tightened policy snapshot), strict merge semantics,
 * config-defined presets, and failure modes. Scope enforcement is asserted
 * through the same scope-expansion arithmetic the runner uses.
 */

const GATE = ['npm', 'test'];
const configWithTest: RuntimeConfig = {
  agents: [], workingDirectory: '.', logLevel: 'info',
  validationCommands: { test: GATE, build: ['npm', 'run', 'build'] }
};

describe('preset registry', () => {
  test('built-ins ship dep-update and test-coverage', () => {
    const names = listPresets(configWithTest).map(e => e.name);
    assert.ok(names.includes('dep-update'));
    assert.ok(names.includes('test-coverage'));
    assert.ok(BUILTIN_PRESETS['dep-update'].scope!.includes('package.json'));
    assert.ok(BUILTIN_PRESETS['test-coverage'].scope!.includes('tests/'));
  });

  test('built-ins are structurally valid', () => {
    for (const [name, preset] of Object.entries(BUILTIN_PRESETS)) {
      assert.deepEqual(validatePresetShape(name, preset), [], `builtin ${name}`);
    }
  });
});

describe('resolvePresetMission', () => {
  test('dep-update resolves into a strict maintenance mission', () => {
    const r = resolvePresetMission({
      name: 'dep-update', config: configWithTest, policy: resolvePolicy()
    });
    assert.equal(r.preset.source, 'builtin');
    assert.equal(r.planning, false, 'deterministic task list, no planner call');
    assert.ok(r.spec.scope!.includes('package.json'));
    assert.deepEqual(r.spec.verificationCommands, ['test']);
    assert.ok(r.spec.acceptanceCriteria.length >= 2);
    // Required gate argv joins the command envelope so the gate can run
    assert.ok(r.policy.allowedCommands.some(c => c.join(' ') === 'npm test'));
    assert.ok(r.policy.allowedCommands.some(c => c.join(' ') === 'npm install'));
    // Approval posture tightened: default allowPush is 'approval' → 'never'
    assert.equal(r.policy.allowPush, 'never');
    // Budgets take the tighter side (default 120 → preset 60)
    assert.equal(r.policy.maxMissionMinutes, 60);
    assert.equal(r.policy.maxAgentInvocations, 6);
    assert.equal(r.tasks.length, 3);
    assert.ok(r.tasks.every(t => t.status === 'pending' && t.dependsOn.length === 0));
  });

  test('CLI objective/criteria/non-goals override and append', () => {
    const r = resolvePresetMission({
      name: 'dep-update', config: configWithTest, policy: resolvePolicy(),
      objective: 'bump only patch versions',
      criteria: ['lockfile diff is minimal'],
      nonGoals: ['touching CI config']
    });
    assert.equal(r.spec.objective, 'bump only patch versions');
    assert.ok(r.spec.acceptanceCriteria.includes('lockfile diff is minimal'));
    assert.ok(r.spec.acceptanceCriteria.length > 2, 'preset criteria retained');
    assert.ok(r.spec.nonGoals!.includes('touching CI config'));
  });

  test('a preset can never widen repo policy', () => {
    const config: RuntimeConfig = {
      ...configWithTest,
      presets: {
        'loosey': {
          objective: 'x', acceptanceCriteria: ['y'],
          allowedCommands: [['anything']],
          budget: { maxMissionMinutes: 9999, maxAgentInvocations: 999 },
          approvals: { allowPush: 'always', allowNetwork: true, approvalTimeoutMs: 99999999 }
        }
      }
    };
    const repo = resolvePolicy({
      allowPush: 'never', allowNetwork: false,
      maxMissionMinutes: 30, maxAgentInvocations: 3, approvalTimeoutMs: 1000
    });
    const r = resolvePresetMission({ name: 'loosey', config, policy: repo });
    assert.equal(r.policy.allowPush, 'never', 'repo never is not loosened by preset always');
    assert.equal(r.policy.allowNetwork, false);
    assert.equal(r.policy.maxMissionMinutes, 30);
    assert.equal(r.policy.maxAgentInvocations, 3);
    assert.equal(r.policy.approvalTimeoutMs, 1000);
    // Preset may only TIGHTEN modes, never relax them
    assert.equal(r.policy.allowedCommands.some(c => c.join(' ') === 'anything'), true);
  });

  test('command envelope is preset-only — repo allowlist is not inherited', () => {
    const repo = resolvePolicy({ allowedCommands: [['repo', 'cmd']] });
    const r = resolvePresetMission({ name: 'dep-update', config: configWithTest, policy: repo });
    assert.equal(r.policy.allowedCommands.some(c => c.join(' ') === 'repo cmd'), false);
    assert.equal(r.policy.allowedCommands.some(c => c.join(' ') === 'npm install'), true);
    assert.equal(classifyCommand(['repo', 'cmd'], r.policy).risk, 'needs-approval');
    assert.equal(classifyCommand(['npm', 'install', 'lodash'], r.policy).risk, 'allowed');
  });

  test('protected paths union — preset can add, never remove', () => {
    const config: RuntimeConfig = {
      ...configWithTest,
      presets: {
        'guard': { objective: 'o', acceptanceCriteria: ['c'], protectedPaths: ['secrets/'] }
      }
    };
    const r = resolvePresetMission({
      name: 'guard', config,
      policy: resolvePolicy({ protectedPaths: [...DEFAULT_POLICY.protectedPaths, 'keep-me/'] })
    });
    assert.ok(r.policy.protectedPaths.includes('keep-me/'));
    assert.ok(r.policy.protectedPaths.includes('secrets/'));
    assert.ok(r.policy.protectedPaths.includes('agentloop.policy.json'), 'defaults retained');
  });
});

describe('scope enforcement composes with the scope-expansion gate', () => {
  function presetMission(name = 'dep-update'): Mission {
    const r = resolvePresetMission({ name, config: configWithTest, policy: resolvePolicy() });
    return {
      spec: r.spec, policy: r.policy, policyHash: 'ph',
      workspace: { mode: 'worktree', path: '/wt/1' }
    } as unknown as Mission;
  }

  test('out-of-scope paths and non-allowlisted commands gate', () => {
    const out = outstandingExpansion(presetMission(), {
      paths: ['package.json', 'src/app.ts'],
      commands: [['npm', 'install', 'lodash'], ['rm', '-rf', 'dist'], ['npm', 'test']]
    }, []);
    assert.deepEqual(out.paths, ['src/app.ts'], 'package.json is inside dep-update scope');
    assert.deepEqual(out.commands, [['rm', '-rf', 'dist']],
      'preset command prefixes and gate argv are not expansions');
  });

  test('test-coverage keeps production code out of scope', () => {
    const out = outstandingExpansion(presetMission('test-coverage'), {
      paths: ['tests/app.test.ts', 'src/app.ts'], commands: []
    }, []);
    assert.deepEqual(out.paths, ['src/app.ts']);
    assert.equal(out.commands.length, 0);
  });
});

describe('config-defined presets', () => {
  const config: RuntimeConfig = {
    ...configWithTest,
    presets: {
      'lint-fix': {
        description: 'Fix lint findings',
        objective: 'Resolve lint findings in src',
        scope: ['src/'],
        acceptanceCriteria: ['lint gate passes'],
        requiredGates: ['build'],
        allowedCommands: [['npm', 'run', 'lint']],
        tasks: ['Run lint', 'Fix findings']
      }
    }
  };

  test('custom preset resolves; source is config', () => {
    const r = resolvePresetMission({ name: 'lint-fix', config, policy: resolvePolicy() });
    assert.equal(r.preset.source, 'config');
    assert.deepEqual(r.spec.scope, ['src/']);
    assert.deepEqual(r.spec.verificationCommands, ['build']);
    assert.ok(r.policy.allowedCommands.some(c => c.join(' ') === 'npm run build'),
      'required gate argv enters the envelope');
    assert.equal(r.tasks.length, 2);
  });

  test('a config preset shadows the builtin of the same name', () => {
    const shadowed: RuntimeConfig = {
      ...configWithTest,
      presets: { 'dep-update': { objective: 'custom dep flow', scope: ['vendor/'], acceptanceCriteria: ['c'] } }
    };
    const entry = getPreset('dep-update', shadowed)!;
    assert.equal(entry.source, 'config');
    const r = resolvePresetMission({ name: 'dep-update', config: shadowed, policy: resolvePolicy() });
    assert.equal(r.spec.objective, 'custom dep flow');
    assert.deepEqual(r.spec.scope, ['vendor/']);
  });

  test('missing required gate fails before mission creation', () => {
    const noGates: RuntimeConfig = { agents: [], workingDirectory: '.', logLevel: 'info' };
    assert.throws(
      () => resolvePresetMission({ name: 'dep-update', config: noGates, policy: resolvePolicy() }),
      (e: unknown) => e instanceof PresetError && /test/.test((e as Error).message) && /validationCommands/.test((e as Error).message)
    );
  });
});

describe('failure modes', () => {
  test('unknown preset lists available names', () => {
    assert.throws(
      () => resolvePresetMission({ name: 'nope', config: configWithTest, policy: resolvePolicy() }),
      (e: unknown) => e instanceof PresetError && /dep-update/.test((e as Error).message)
    );
  });

  test('malformed config preset fails with its issues', () => {
    const bad: RuntimeConfig = {
      ...configWithTest,
      presets: { 'bad one': { scope: ['../escape'] } as never }
    };
    assert.throws(
      () => resolvePresetMission({ name: 'bad one', config: bad, policy: resolvePolicy() }),
      (e: unknown) => e instanceof PresetError && /escape|invalid preset name/.test((e as Error).message)
    );
  });

  test('no objective anywhere is a resolution error', () => {
    const config: RuntimeConfig = {
      ...configWithTest,
      presets: { 'aimless': { scope: ['src/'], acceptanceCriteria: ['c'] } }
    };
    assert.throws(
      () => resolvePresetMission({ name: 'aimless', config, policy: resolvePolicy() }),
      /no default objective/
    );
  });

  test('no acceptance criteria anywhere is a resolution error', () => {
    const config: RuntimeConfig = {
      ...configWithTest,
      presets: { 'gpless': { objective: 'o', scope: ['src/'], requiredGates: [] } }
    };
    assert.throws(
      () => resolvePresetMission({ name: 'gpless', config, policy: resolvePolicy() }),
      /acceptance criteria/
    );
  });

  test('empty scope resolves but warns (unbounded diff)', () => {
    const config: RuntimeConfig = {
      ...configWithTest,
      presets: { 'open': { objective: 'o', acceptanceCriteria: ['c'] } }
    };
    const r = resolvePresetMission({ name: 'open', config, policy: resolvePolicy() });
    assert.equal(r.spec.scope, undefined);
    assert.ok(r.warnings.some(w => /no path scope/.test(w)));
  });
});

describe('validatePresetShape', () => {
  test('rejects bad names, escapes, malformed fields', () => {
    assert.ok(!PRESET_NAME_RE.test('Bad Name'));
    assert.ok(validatePresetShape('ok-name', { scope: ['../x'] }).some(i => /scope path/.test(i)));
    assert.ok(validatePresetShape('ok-name', { scope: ['C:/abs'] }).length > 0);
    assert.ok(validatePresetShape('ok-name', { scope: ['./alias'] }).length > 0);
    assert.ok(validatePresetShape('ok-name', { allowedCommands: [['ok'], []] }).length > 0);
    assert.ok(validatePresetShape('ok-name', { budget: { maxMissionMinutes: -1 } }).length > 0);
    assert.ok(validatePresetShape('ok-name', { approvals: { allowPush: 'sometimes' as never } }).length > 0);
    assert.ok(validatePresetShape('ok-name', 'nope').length > 0);
  });

  test('accepts a well-formed custom preset', () => {
    assert.deepEqual(validatePresetShape('tidy', {
      objective: 'o', scope: ['src/', 'docs/readme.md'],
      allowedCommands: [['npm', 'run', 'lint']],
      budget: { maxMissionMinutes: 10 },
      approvals: { allowPush: 'never' }, tasks: ['t1']
    }), []);
  });
});

// ── CLI + end-to-end: preset → mission → runner ─────────────────────────────

const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));

/**
 * Fixture repo with a content-gated custom agent; returns run artifacts.
 * The fixture SHADOWS the dep-update builtin with a single-task config preset
 * of the same name — one agent invocation keeps the run fast on slow hosts
 * while still exercising the real CLI path: `--preset` → config shadow →
 * strict scope → gates → scope-expansion approval.
 */
function runPresetFixture(opts: { writePath: string; extraArgs?: string[]; preset?: string }) {
  const fixture = mkdtempSync(join(tmpdir(), 'alr-preset-'));
  const repo = join(fixture, 'repo');
  const hooks = join(fixture, 'empty-hooks');
  mkdirSync(repo);
  mkdirSync(hooks);
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: repo, stdio: 'pipe', timeout: 60_000, windowsHide: true
  });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Preset fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.hooksPath', hooks]);

  const agent = join(fixture, 'agent.cjs');
  const verifier = join(fixture, 'verify.cjs');
  writeFileSync(agent, `
const fs = require('node:fs');
const target = ${JSON.stringify(opts.writePath)};
const dir = require('node:path').dirname(target);
if (dir !== '.') fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(target, 'updated\\n');
`);
  writeFileSync(verifier, "require('node:assert/strict').ok(true);\n");
  const gate = [process.execPath, verifier];
  writeFileSync(join(repo, '.gitignore'), '.agentloop/\n');
  writeFileSync(join(repo, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  writeFileSync(join(repo, 'agentloop.config.json'), JSON.stringify({
    agents: [{ name: 'fixture', type: 'custom', command: process.execPath, args: [agent] }],
    defaultAgent: 'fixture',
    validationCommands: { test: gate },
    presets: {
      'dep-update': {
        description: 'fixture shadow of the builtin',
        objective: 'Bump deps',
        scope: ['package.json', 'package-lock.json'],
        acceptanceCriteria: ['manifest updated', 'test gate passes'],
        requiredGates: ['test'],
        tasks: ['Apply the dependency update'],
        allowedCommands: [['npm', 'install']],
        approvals: { allowPush: 'never' }
      }
    }
  }));
  writeFileSync(join(repo, 'agentloop.policy.json'), JSON.stringify({
    // Checkpoint commits make agent writes visible to the baseSha..HEAD review.
    allowLocalCommit: true, allowPush: 'approval', allowPullRequest: 'never', allowMerge: 'never',
    maxAgentInvocations: 4, maxRepairPasses: 0, maxMissionMinutes: 5,
    agentTimeoutMs: 15_000, allowedCommands: [gate],
    // Short enough for the scope-expansion gate to lapse inside the test run.
    approvalTimeoutMs: 3000
  }));
  git(['add', '-A']);
  git(['-c', 'commit.gpgSign=false', 'commit', '-qm', 'Initialize fixture']);

  const result = spawnSync(process.execPath, [
    tsx, cli, 'run', '--preset', opts.preset ?? 'dep-update',
    '--in-place', '--approve-in-place', ...(opts.extraArgs ?? [])
  ], {
    cwd: repo, encoding: 'utf8', timeout: 300_000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGENTLOOP_LOG_FILE: join(fixture, 'runtime.log') }
  });
  assert.ifError(result.error);
  const ids = readdirSync(join(repo, '.agentloop', 'missions'));
  assert.equal(ids.length, 1);
  const mission = JSON.parse(readFileSync(join(repo, '.agentloop', 'missions', ids[0], 'mission.json'), 'utf8'));
  return { fixture, result, mission };
}

test('CLI run --preset resolves the config shadow and completes inside its scope', t => {
  const { result, mission } = runPresetFixture({ writePath: 'package.json' });
  t.diagnostic(result.stdout + result.stderr);
  assert.match(result.stdout, /Preset dep-update \(config\)/);
  assert.equal(mission.kind, 'maintenance');
  assert.deepEqual(mission.spec.scope, ['package.json', 'package-lock.json']);
  assert.deepEqual(mission.spec.verificationCommands, ['test']);
  assert.equal(mission.policy.allowPush, 'never', 'preset tightens repo allowPush=approval to never');
  // Command envelope = preset allowlist + required gate argv (repo list dropped)
  assert.equal(mission.policy.allowedCommands.some((c: string[]) => c.join(' ') === 'npm install'), true);
  assert.equal(mission.state, 'completed');
  assert.equal(mission.tasks.length, 1, 'preset deterministic task list');
});

test('CLI run --preset blocks out-of-scope writes behind a scope-expansion gate', t => {
  const { result, mission } = runPresetFixture({ writePath: 'src/hack.ts' });
  t.diagnostic(result.stdout + result.stderr);
  // The gate request is recorded, then the short approvalTimeoutMs lapses to blocked.
  assert.equal(mission.state, 'blocked');
  const gate = mission.approvals.find((a: { gate: string }) => a.gate === 'scope-expansion');
  assert.ok(gate, 'a scope-expansion approval must have been raised');
  assert.ok(gate.paths.includes('src/hack.ts'));
  assert.equal(gate.status, 'pending');
});

test('CLI unknown preset exits 2 and creates no mission', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'alr-preset-cli-'));
  writeFileSync(join(fixture, 'agentloop.config.json'), JSON.stringify({ agents: [], validationCommands: {} }));
  const result = spawnSync(process.execPath, [tsx, cli, 'run', 'x', '--preset', 'does-not-exist'], {
    cwd: fixture, encoding: 'utf8', timeout: 60_000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown preset 'does-not-exist'/);
  assert.match(result.stderr, /dep-update/);
});

test('CLI presets lists builtins and inspects one as JSON', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'alr-preset-cli-'));
  // The inspect path resolves the preset — it needs the required 'test' gate.
  writeFileSync(join(fixture, 'agentloop.config.json'), JSON.stringify({
    agents: [], validationCommands: { test: ['npm', 'test'] }
  }));
  const list = spawnSync(process.execPath, [tsx, cli, 'presets'], {
    cwd: fixture, encoding: 'utf8', timeout: 60_000, windowsHide: true
  });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /dep-update/);
  assert.match(list.stdout, /test-coverage/);

  const inspect = spawnSync(process.execPath, [tsx, cli, 'presets', 'dep-update', '--json'], {
    cwd: fixture, encoding: 'utf8', timeout: 60_000, windowsHide: true
  });
  assert.equal(inspect.status, 0, inspect.stderr);
  const parsed = JSON.parse(inspect.stdout);
  assert.equal(parsed.name, 'dep-update');
  assert.equal(parsed.source, 'builtin');
  assert.equal(parsed.spec.scope.includes('package.json'), true);
  assert.equal(parsed.effectivePolicy.allowPush, 'never');
  // The required gate's argv is in the resolved command envelope
  assert.ok(parsed.effectivePolicy.allowedCommands.some((c: string[]) => c.join(' ') === 'npm test'));
});
