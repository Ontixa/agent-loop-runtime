import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAdapter, DevinAdapter } from '../agents/vendor-adapters.js';
import type { AgentConfig, AgentInvocationContext } from '../types.js';

const adapter = new DevinAdapter();
const context: AgentInvocationContext = {
  prompt: 'Fix "quoted" paths & keep\nall task details',
  cwd: process.cwd(),
  missionId: 'devin-contract',
  taskId: 'task-1',
  pass: 1,
  signal: new AbortController().signal,
  timeoutMs: 5000,
  maxOutputBytes: 8192
};
const config: AgentConfig = { name: 'devin', type: 'devin' };

describe('Codex headless adapter', () => {
  test('selects workspace-write sandbox without the removed full-auto alias', () => {
    const invocation = new CodexAdapter().buildInvocation(context, {
      name: 'codex', type: 'codex'
    });
    assert.equal(invocation.command, 'codex');
    assert.deepEqual(invocation.args, [
      'exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', context.prompt
    ]);
  });

  test('preserves operator argv, additional arguments and configured model', () => {
    const invocation = new CodexAdapter().buildInvocation(context, {
      name: 'codex', type: 'codex', command: 'custom-codex',
      args: ['exec', '--sandbox', 'read-only', '{prompt}'],
      additionalArgs: ['--json'], model: 'configured-model'
    });
    assert.equal(invocation.command, 'custom-codex');
    assert.deepEqual(invocation.args, [
      'exec', '--sandbox', 'read-only', context.prompt,
      '--json', '-m', 'configured-model'
    ]);
  });
});

describe('Devin headless adapter', () => {
  test('uses print mode with one intact prompt and scoped edit permissions', () => {
    const invocation = adapter.buildInvocation(context, config);
    assert.equal(invocation.command, 'devin');
    assert.deepEqual(invocation.args, [
      '--print', context.prompt, '--permission-mode', 'accept-edits'
    ]);
    assert.ok(!invocation.args.includes('dangerous'));
    assert.ok(!invocation.args.includes('--respect-workspace-trust'));
  });

  test('forwards an explicit executable and model', () => {
    const invocation = adapter.buildInvocation(context, {
      ...config, command: 'C:\\tools\\devin.exe', model: 'configured-model'
    });
    assert.equal(invocation.command, 'C:\\tools\\devin.exe');
    assert.deepEqual(invocation.args.slice(-2), ['--model', 'configured-model']);
  });

  test('preserves full argv overrides without injecting default permissions', () => {
    const invocation = adapter.buildInvocation(context, {
      ...config,
      args: ['--print', '{prompt}', '--permission-mode', 'auto'],
      additionalArgs: ['--config', 'operator-config.json']
    });
    assert.deepEqual(invocation.args, [
      '--print', context.prompt, '--permission-mode', 'auto',
      '--config', 'operator-config.json'
    ]);
  });
});
