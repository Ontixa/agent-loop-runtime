import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CustomAdapter, validateCustomAgent } from '../agents/custom-adapter.js';
import { supervise } from '../supervisor/process-supervisor.js';
import { AgentType } from '../types.js';
import type { AgentConfig, AgentInvocationContext } from '../types.js';

/**
 * Deterministic fake coding agents — a node script is the "CLI".
 * Simulates: success, failure, file modification, early exit, huge output,
 * hang (for timeout), scope violation marker. No real CLIs required.
 */

let dir: string;
let fakeAgentJs: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'alr-fake-'));
  fakeAgentJs = join(dir, 'fake-agent.js');
  // Fake agent: echoes its argv, writes a marker file, behavior via --mode
  writeFileSync(fakeAgentJs, `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const mode = (args.find(a => a.startsWith('--mode=')) || '--mode=success').slice(7);
const prompt = args.find(a => !a.startsWith('--'));
if (mode === 'hang') { setInterval(() => {}, 1000); }
else if (mode === 'fail') { console.error('agent exploded'); process.exit(42); }
else if (mode === 'huge') { const s='z'.repeat(4000); for(let i=0;i<300;i++) console.log(s+i); }
else if (mode === 'modify') {
  fs.writeFileSync(path.join(process.cwd(), 'agent-was-here.txt'), prompt || 'x');
  console.log('modified workspace');
}
else if (mode === 'early') { console.log('quick done'); }
else { console.log('FAKE-AGENT-OK ' + JSON.stringify(args).slice(0, 200)); }
`);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const adapter = new CustomAdapter();
const NODE = process.execPath;

function ctx(prompt: string): AgentInvocationContext {
  return {
    prompt,
    missionId: 'm-test',
    cwd: dir,
    taskId: 't-1',
    pass: 1,
    signal: new AbortController().signal,
    timeoutMs: 5000,
    maxOutputBytes: 8192
  };
}

function cfg(extra: Partial<AgentConfig> = {}): AgentConfig {
  return { name: 'fake', type: AgentType.CUSTOM, command: NODE, args: [fakeAgentJs, '{objective}'], ...extra };
}

describe('custom adapter — config validation', () => {
  test('valid config passes', () => {
    assert.deepEqual(validateCustomAgent(cfg()), []);
    assert.deepEqual(validateCustomAgent(cfg({ args: ['run', '{prompt}', '--cwd', '{worktree}'] })), []);
  });

  test('missing command rejected', () => {
    const errs = validateCustomAgent({ name: 'x', type: AgentType.CUSTOM });
    assert.ok(errs.some(e => e.includes('command')));
  });

  test('shell metachars in command rejected', () => {
    const errs = validateCustomAgent({ name: 'x', type: AgentType.CUSTOM, command: 'foo && rm -rf /' });
    assert.ok(errs.length > 0);
  });

  test('unknown placeholders rejected', () => {
    const errs = validateCustomAgent(cfg({ args: ['{secrets}', '{env}'] }));
    assert.ok(errs.length >= 2);
    assert.ok(errs[0].includes('{secrets}'));
  });

  test('valid placeholders accepted', () => {
    for (const p of ['prompt', 'objective', 'mission', 'task', 'worktree', 'repository']) {
      assert.deepEqual(validateCustomAgent(cfg({ args: [`{${p}}`] })), [], `{${p}} should be valid`);
    }
  });
});

describe('custom adapter — invocation building', () => {
  test('{objective} placeholder is substituted with prompt', () => {
    const inv = adapter.buildInvocation(ctx('fix the bug'), cfg());
    assert.equal(inv.command, NODE);
    assert.equal(inv.args[0], fakeAgentJs);
    assert.equal(inv.args[1], 'fix the bug');
  });

  test('template without prompt placeholder gets prompt appended', () => {
    const inv = adapter.buildInvocation(ctx('do it'), cfg({ args: ['--flag'] }));
    assert.deepEqual(inv.args, ['--flag', 'do it']);
  });

  test('{worktree} and {repository} substitute paths', () => {
    const inv = adapter.buildInvocation(ctx('p'), cfg({ args: ['{prompt}', '--dir', '{worktree}', '{repository}'] }));
    assert.equal(inv.args[2], dir);
    assert.equal(inv.args[3], dir);
  });

  test('invalid config throws at build time', () => {
    assert.throws(() => adapter.buildInvocation(ctx('p'), cfg({ args: ['{bogus}'] })));
  });
});

describe('fake agent — supervised execution', () => {
  async function invokeFake(c: AgentConfig, prompt: string, opts: Partial<Parameters<typeof supervise>[0]> = {}) {
    const inv = adapter.buildInvocation(ctx(prompt), c);
    return supervise({ command: inv.command, args: inv.args, cwd: dir, timeoutMs: 5000, ...opts });
  }

  test('successful agent → success classification', async () => {
    const r = await invokeFake(cfg(), 'hello world');
    assert.equal(r.exitKind, 'success');
    assert.ok(r.outputTail.includes('FAKE-AGENT-OK'));
  });

  test('failing agent → failed, mission must NOT complete', async () => {
    const r = await invokeFake(cfg({ args: [fakeAgentJs, '--mode=fail', '{objective}'] }), 'x');
    assert.equal(r.exitKind, 'failed');
    assert.equal(r.exitCode, 42);
    assert.ok(r.outputTail.includes('agent exploded'));
  });

  test('hanging agent → timeout, does not hang the runtime', async () => {
    const r = await invokeFake(cfg({ args: [fakeAgentJs, '--mode=hang'] }), 'x', { timeoutMs: 800 });
    assert.equal(r.exitKind, 'timeout');
    assert.ok(r.durationMs < 8000);
  });

  test('file-modifying agent: its writes land in the worktree cwd', async () => {
    const r = await invokeFake(cfg({ args: [fakeAgentJs, '--mode=modify', '{objective}'] }), 'payload-123');
    assert.equal(r.exitKind, 'success');
    assert.ok(existsSync(join(dir, 'agent-was-here.txt')));
    assert.equal(readFileSync(join(dir, 'agent-was-here.txt'), 'utf8'), 'payload-123');
  });

  test('early-exit agent → success, no hang', async () => {
    const r = await invokeFake(cfg({ args: [fakeAgentJs, '--mode=early'] }), 'x');
    assert.equal(r.exitKind, 'success');
    assert.ok(r.durationMs < 4000);
  });

  test('huge-output agent → bounded tail + truncated', async () => {
    const r = await invokeFake(cfg({ args: [fakeAgentJs, '--mode=huge'] }), 'x', { maxOutputBytes: 8192 });
    assert.equal(r.exitKind, 'success');
    assert.ok(r.outputTruncated);
    assert.ok(r.outputTail.length <= 8700);
  });
});
