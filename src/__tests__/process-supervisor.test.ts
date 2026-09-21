import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { supervise } from '../supervisor/process-supervisor.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Process supervision tests — fake "agents" are `node -e` scripts so no real
 * CLI is required. Covers exit classification, timeout, abort, bounded output.
 */

const NODE = process.execPath;

function run(script: string, opts: Partial<Parameters<typeof supervise>[0]> = {}) {
  return supervise({
    command: NODE,
    args: ['-e', script],
    timeoutMs: opts.timeoutMs ?? 5000,
    maxOutputBytes: opts.maxOutputBytes,
    logFile: opts.logFile,
    signal: opts.signal,
    killGraceMs: opts.killGraceMs ?? 300
  });
}

describe('process supervisor — exit classification', () => {
  test('clean exit 0 → success', async () => {
    const r = await run('console.log("hello"); process.exit(0)');
    assert.equal(r.exitKind, 'success');
    assert.equal(r.exitCode, 0);
    assert.ok(r.outputTail.includes('hello'));
    assert.ok(r.pid! > 0);
  });

  test('nonzero exit → failed with exitCode', async () => {
    const r = await run('console.error("boom"); process.exit(3)');
    assert.equal(r.exitKind, 'failed');
    assert.equal(r.exitCode, 3);
    assert.ok(r.outputTail.includes('boom'));
  });

  test('uncaught exception → failed', async () => {
    const r = await run('throw new Error("crash")');
    assert.equal(r.exitKind, 'failed');
    assert.equal(r.exitCode, 1);
  });

  test('hanging process → timeout', async () => {
    const r = await run('setInterval(() => {}, 1000)', { timeoutMs: 800 });
    assert.equal(r.exitKind, 'timeout');
    assert.ok(r.durationMs < 5000, 'must not wait forever');
  });

  test('abort signal → cancelled', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await run('setInterval(() => {}, 1000)', { signal: ac.signal, timeoutMs: 30000 });
    assert.equal(r.exitKind, 'cancelled');
    assert.ok(r.durationMs < 10000);
  });

  test('missing binary → spawn-error (not a crash)', async () => {
    const r = await supervise({
      command: 'definitely-not-a-real-binary-xyz123',
      args: [], timeoutMs: 5000
    });
    assert.equal(r.exitKind, 'spawn-error');
    assert.ok(r.outputTail.includes('spawn error'));
  });
});

describe('process supervisor — output bounds', () => {
  test('huge output → tail bounded + truncated flag', async () => {
    const r = await run(
      'const s="x".repeat(2000); for(let i=0;i<200;i++) console.log(s+i)',
      { maxOutputBytes: 8192 }
    );
    assert.equal(r.exitKind, 'success');
    assert.ok(r.outputTruncated, 'output should be marked truncated');
    assert.ok(r.outputTail.length <= 8192 + 512, `tail ${r.outputTail.length} exceeds bound`);
    // tail keeps the END of output
    assert.ok(r.outputTail.includes('199') || r.outputTail.includes('19\n'), 'tail should contain late output');
  });

  test('no unbounded memory: 5MB output with 4KB cap', async () => {
    const r = await run(
      'const s="y".repeat(50000); for(let i=0;i<100;i++) console.log(s)',
      { maxOutputBytes: 4096 }
    );
    assert.ok(r.outputTail.length <= 4608);
    assert.ok(r.outputTruncated);
  });
});

describe('process supervisor — non-interactive stdin', () => {
  test('stdin readers receive EOF and stdout/stderr remain captured', async () => {
    const result = await run(`
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.log('stdin-eof:' + JSON.stringify(input));
  console.error('stderr-after-eof');
});
process.stdin.resume();
`);
    assert.equal(result.exitKind, 'success', result.outputTail);
    assert.equal(result.exitCode, 0);
    assert.ok(result.outputTail.includes('stdin-eof:""'));
    assert.ok(result.outputTail.includes('stderr-after-eof'));
  });

  test('synchronous stdin reads do not block argv-based agents', async () => {
    const result = await run(`
const input = require('fs').readFileSync(0, 'utf8');
console.log('sync-stdin:' + JSON.stringify(input));
`);
    assert.equal(result.exitKind, 'success', result.outputTail);
    assert.equal(result.outputTail.trim(), 'sync-stdin:""');
  });
});

describe('process supervisor — log file streaming', () => {
  test('logFile receives output while tail stays bounded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alr-log-'));
    try {
      const logFile = join(dir, 'agent.log');
      const r = await run(
        'for(let i=0;i<500;i++) console.log("line-"+i)',
        { maxOutputBytes: 2048, logFile }
      );
      assert.ok(existsSync(logFile));
      const onDisk = readFileSync(logFile, 'utf8');
      assert.ok(onDisk.includes('line-499'), 'full output should reach the log file');
      assert.ok(r.outputTail.length <= 2560, 'memory tail stays bounded even with log file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('process supervisor — argv safety', () => {
  test('args are passed literally, no shell interpretation', async () => {
    // A metachar-rich arg would execute if a shell were involved
    const r = await run('console.log(JSON.stringify(process.argv.slice(1)))', {
      timeoutMs: 5000
    });
    assert.equal(r.exitKind, 'success');
    // spawn is called with explicit argv — verify by echoing argv back
    const r2 = await supervise({
      command: NODE,
      args: ['-e', 'console.log(process.argv[1])', 'a;b && echo INJECTED | cat'],
      timeoutMs: 5000
    });
    assert.ok(r2.outputTail.includes('a;b && echo INJECTED | cat'), 'arg passed literally');
    assert.ok(!r2.outputTail.includes('\nINJECTED'), 'metachars must not execute');
  });
});
