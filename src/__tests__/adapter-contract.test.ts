import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QwenAdapter, CodexAdapter, ClaudeAdapter, DevinAdapter,
  GeminiAdapter, OpenCodeAdapter, AiderAdapter
} from '../agents/vendor-adapters.js';
import { CustomAdapter, validateCustomAgent } from '../agents/custom-adapter.js';
import { getAdapter, listAdapterTypes, validateAgentConfig } from '../agents/registry.js';
import type { AgentConfig, AgentInvocationContext } from '../types.js';

/**
 * Adapter argv contract — pins the exact default argv each adapter builds so
 * docs/adapter-matrix.md cannot drift from code and a flag change fails
 * loudly instead of silently altering what a vendor CLI is asked to do.
 *
 * Fake-runner level: no real vendor CLIs are invoked. `detect()` and live
 * smoke coverage are out of scope here — the matrix records which adapters
 * have had their flags verified against a vendor release.
 */

const ctx: AgentInvocationContext = {
  prompt: 'PINNED PROMPT with "quotes" & symbols\nsecond line',
  cwd: 'C:\\work\\mission-wt',
  missionId: 'msn_contract',
  taskId: 'task-7',
  pass: 2,
  signal: new AbortController().signal,
  timeoutMs: 60_000,
  maxOutputBytes: 4096
};

const base = (type: string): AgentConfig => ({ name: `${type}-cfg`, type });

describe('adapter registry', () => {
  test('known types resolve to their adapters; custom is always listed', () => {
    assert.deepEqual(
      [...listAdapterTypes()].sort(),
      ['aider', 'claude', 'codex', 'custom', 'devin', 'gemini', 'opencode', 'qwen']
    );
    for (const [type, cls] of [
      ['qwen', QwenAdapter], ['codex', CodexAdapter], ['claude', ClaudeAdapter],
      ['devin', DevinAdapter], ['gemini', GeminiAdapter], ['opencode', OpenCodeAdapter],
      ['aider', AiderAdapter]
    ] as const) {
      assert.ok(getAdapter(type) instanceof cls, `type '${type}' must map to ${cls.name}`);
    }
    assert.ok(getAdapter('custom', { name: 'x', type: 'custom', command: 'myagent' }) instanceof CustomAdapter);
    // Type names normalize case — config values from JSON may not match enum case.
    assert.equal(getAdapter('QWEN').type, 'qwen');
  });

  test('unknown type falls back to custom only when a command is configured', () => {
    const fallback = getAdapter('not-a-vendor', { name: 'x', type: 'not-a-vendor', command: 'myagent' });
    assert.ok(fallback instanceof CustomAdapter);
    assert.equal(fallback.type, 'custom');
    assert.throws(() => getAdapter('not-a-vendor'), /Unknown agent type: 'not-a-vendor'/);
  });
});

/**
 * Default argv — one pinned row per adapter, matching docs/adapter-matrix.md.
 * The prompt always arrives as a single argv entry (never concatenated into a
 * shell line) and autonomy/non-interactive flags are the adapter's job.
 */
const vendorDefaults: Array<{
  type: string;
  adapter: () => { buildInvocation(c: AgentInvocationContext, cfg: AgentConfig): { command: string; args: string[]; env?: Record<string, string> } };
  command: string;
  args: string[];
  modelFlag: string;
}> = [
  {
    type: 'qwen', adapter: () => new QwenAdapter(), command: 'qwen',
    args: [ctx.prompt, '--yolo', '-o', 'text'], modelFlag: '-m'
  },
  {
    type: 'codex', adapter: () => new CodexAdapter(), command: 'codex',
    args: ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', ctx.prompt],
    modelFlag: '-m'
  },
  {
    type: 'claude', adapter: () => new ClaudeAdapter(), command: 'claude',
    args: ['-p', ctx.prompt, '--output-format', 'text', '--dangerously-skip-permissions'],
    modelFlag: '--model'
  },
  {
    type: 'devin', adapter: () => new DevinAdapter(), command: 'devin',
    args: ['--print', ctx.prompt, '--permission-mode', 'accept-edits'],
    modelFlag: '--model'
  },
  {
    type: 'gemini', adapter: () => new GeminiAdapter(), command: 'gemini',
    args: [ctx.prompt, '--yolo'], modelFlag: '-m'
  },
  {
    type: 'opencode', adapter: () => new OpenCodeAdapter(), command: 'opencode',
    args: ['run', ctx.prompt], modelFlag: '-m'
  },
  {
    type: 'aider', adapter: () => new AiderAdapter(), command: 'aider',
    args: ['--message', ctx.prompt, '--yes-always', '--no-auto-commits'],
    modelFlag: '--model'
  }
];

describe('vendor adapter default argv (pinned to adapter-matrix.md)', () => {
  for (const row of vendorDefaults) {
    test(`${row.type}: default command + argv, prompt as one argv entry`, () => {
      const inv = row.adapter().buildInvocation(ctx, base(row.type));
      assert.equal(inv.command, row.command);
      assert.deepEqual(inv.args, row.args);
      // The prompt must survive verbatim — multiline, quotes, metacharacters.
      assert.ok(inv.args.includes(ctx.prompt), 'prompt must be a literal argv entry');
      assert.equal(inv.env, undefined, 'no env override → key stays absent');
    });

    test(`${row.type}: model, command override, additionalArgs ordering`, () => {
      const inv = row.adapter().buildInvocation(ctx, {
        ...base(row.type),
        command: `custom-${row.type}-exe`,
        model: 'model-x',
        additionalArgs: ['--extra-flag', 'v']
      });
      assert.equal(inv.command, `custom-${row.type}-exe`);
      // additionalArgs append to the default argv; the model flag trails them.
      assert.deepEqual(inv.args, [...row.args, '--extra-flag', 'v', row.modelFlag, 'model-x']);
    });

    test(`${row.type}: config.args replaces the default argv wholesale`, () => {
      const inv = row.adapter().buildInvocation(ctx, {
        ...base(row.type), args: ['sub', '{prompt}', '--flag']
      });
      assert.deepEqual(inv.args, ['sub', ctx.prompt, '--flag']);
      // None of the default autonomy flags may leak back in.
      for (const flag of ['--yolo', '--dangerously-skip-permissions', '--yes-always',
        'accept-edits', 'workspace-write', '-o']) {
        assert.ok(!inv.args.includes(flag), `${row.type}: '${flag}' must not appear in an argv override`);
      }
    });

    test(`${row.type}: agent env is forwarded to the invocation transport`, () => {
      const envCtx = { ...ctx, env: { ANTHROPIC_API_KEY: 'k', CUSTOM_FLAG: '1' } };
      const inv = row.adapter().buildInvocation(envCtx, base(row.type));
      assert.deepEqual(inv.env, { ANTHROPIC_API_KEY: 'k', CUSTOM_FLAG: '1' });
    });
  }
});

describe('custom adapter contract', () => {
  const adapter = new CustomAdapter();

  test('bare command receives the prompt as sole argv entry', () => {
    const inv = adapter.buildInvocation(ctx, { name: 'c', type: 'custom', command: 'myagent' });
    assert.equal(inv.command, 'myagent');
    assert.deepEqual(inv.args, [ctx.prompt]);
  });

  test('every documented placeholder substitutes; no-placeholder appends prompt', () => {
    const inv = adapter.buildInvocation(ctx, {
      name: 'c', type: 'custom', command: 'myagent',
      args: ['run', '{objective}', '--mission', '{mission}', '--task', '{task}',
        '--dir', '{worktree}', '--repo', '{repository}']
    });
    assert.deepEqual(inv.args, [
      'run', ctx.prompt, '--mission', ctx.missionId, '--task', ctx.taskId,
      '--dir', ctx.cwd, '--repo', ctx.cwd
    ]);

    const noPlaceholder = adapter.buildInvocation(ctx, {
      name: 'c', type: 'custom', command: 'myagent', args: ['run', '--batch']
    });
    assert.deepEqual(noPlaceholder.args, ['run', '--batch', ctx.prompt]);
  });

  test('config.model is ignored (no universal model flag for custom CLIs)', () => {
    const inv = adapter.buildInvocation(ctx, {
      name: 'c', type: 'custom', command: 'myagent', model: 'm-1', args: ['run', '{prompt}']
    });
    assert.deepEqual(inv.args, ['run', ctx.prompt]);
  });

  test('env forwards; additionalArgs append after the prompt', () => {
    const inv = adapter.buildInvocation({ ...ctx, env: { MY_VAR: 'v' } }, {
      name: 'c', type: 'custom', command: 'myagent',
      args: ['--task', '{task}'], additionalArgs: ['--tail']
    });
    assert.deepEqual(inv.args, ['--task', ctx.taskId, ctx.prompt, '--tail']);
    assert.deepEqual(inv.env, { MY_VAR: 'v' });
  });

  test('invalid configs are rejected at build time', () => {
    assert.throws(() => adapter.buildInvocation(ctx, { name: 'c', type: 'custom' } as AgentConfig),
      /requires a non-empty "command"/);
    assert.throws(() => adapter.buildInvocation(ctx, {
      name: 'c', type: 'custom', command: 'myagent', args: ['{bogus}']
    }), /unknown placeholder \{bogus\}/);
    assert.throws(() => adapter.buildInvocation(ctx, {
      name: 'c', type: 'custom', command: 'myagent && rm -rf x'
    }), /must be an executable, not a shell expression/);
  });

  test('validateCustomAgent reports every violation', () => {
    assert.deepEqual(validateCustomAgent({ name: 'c', type: 'custom', command: 'ok' }), []);
    const errors = validateCustomAgent({
      name: 'c', type: 'custom', command: 'a | b',
      args: ['{nope}'] as unknown as string[],
      additionalArgs: 'x' as unknown as string[]
    });
    assert.ok(errors.some(e => e.includes('shell expression')));
    assert.ok(errors.some(e => e.includes('unknown placeholder')));
    assert.ok(errors.some(e => e.includes('"additionalArgs" must be an array')));
  });
});

describe('agent config validation (registry level)', () => {
  test('name and type are required; env must be an object', () => {
    assert.ok(validateAgentConfig({ name: '', type: 'qwen' }).some(e => e.includes('requires a name')));
    assert.ok(validateAgentConfig({ name: 'x', type: '' }).some(e => e.includes('requires a type')));
    assert.ok(validateAgentConfig({ name: 'x', type: 'qwen', env: 'nope' as unknown as Record<string, string> })
      .some(e => e.includes('env must be an object')));
    assert.deepEqual(validateAgentConfig({ name: 'x', type: 'qwen' }), []);
  });
});
