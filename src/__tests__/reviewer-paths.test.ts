import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deterministicReview } from '../engine/reviewer.js';
import { changedFilesStrict, changedFiles } from '../git/repo-inspector.js';
import { GitError, GitOutputLimitError, MAX_GIT_OUTPUT_BYTES } from '../git/git-runner.js';
import { resolvePolicy } from '../policy/policy.js';
import type { Mission } from '../types.js';

const benign = (n: number) => Array.from({ length: n }, (_, i) => `safe/file-${String(i).padStart(4, '0')}.txt`);
const mission = (extra: Record<string, unknown> = {}) => ({
  id: 'fixture', policy: resolvePolicy({ protectedPaths: ['zz/private.txt'] }),
  spec: { objective: 'fixture', acceptanceCriteria: [], ...extra }
} as unknown as Mission);

// Each test file runs in its own Node test process. Patch only while awaited;
// no production injection hook, Git mutation, or provider invocation.
async function withPaths<T>(paths: string[], fn: () => Promise<T>, opts: { diff?: string; error?: boolean; raw?: string; overflow?: boolean } = {}) {
  const original = childProcess.spawn;
  const mutable = childProcess as { -readonly [K in keyof typeof childProcess]: (typeof childProcess)[K] };
  mutable.spawn = ((command: string, args: string[]) => {
    assert.equal(command, 'git');
    assert.equal(args[0], 'diff');
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    setImmediate(() => {
      const names = args.includes('--name-only');
      if (names && args.includes('-z')) {
        assert.deepEqual(args, ['diff', '--name-only', '-z', '--no-renames', args[4], 'HEAD', '--']);
      }
      if (names && opts.error) { child.stderr.emit('data', Buffer.from('fixture Git failure')); child.emit('close', 2); return; }
      if (names && opts.overflow) { child.stdout.emit('data', Buffer.alloc(MAX_GIT_OUTPUT_BYTES + 1)); child.emit('close', 0); return; }
      const out = names ? (opts.raw ?? paths.join(args.includes('-z') ? '\0' : '\n') + (paths.length ? (args.includes('-z') ? '\0' : '\n') : ''))
        : args.includes('--shortstat') ? ' 1 file changed\n' : opts.diff ?? '+benign content\n';
      child.stdout.emit('data', Buffer.from(out)); child.emit('close', 0);
    });
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try { return await fn(); }
  finally { mutable.spawn = original; syncBuiltinESMExports(); }
}

test('protected path at position 501 must reject hard review', async () => {
  const result = await withPaths([...benign(500), 'zz/private.txt'], () =>
    deterministicReview({ worktreePath: process.cwd(), baseSha: 'fixture-base', mission: mission() }));
  assert.equal(result.verdict, 'reject');
  assert.ok(result.findings.includes('protected path modified: zz/private.txt'));
});

test('protected path at position 500 also rejects', async () => {
  const result = await withPaths([...benign(499), 'zz/private.txt'], () =>
    deterministicReview({ worktreePath: process.cwd(), baseSha: 'fixture-base', mission: mission() }));
  assert.equal(result.verdict, 'reject');
});

test('more than 500 benign paths are complete and approve; display API stays bounded', async () => {
  await withPaths(benign(501), async () => {
    assert.equal((await changedFilesStrict(process.cwd(), 'base')).length, 501);
    assert.equal((await changedFiles(process.cwd(), 'base')).length, 500);
    const result = await deterministicReview({ worktreePath: process.cwd(), baseSha: 'base', mission: mission() });
    assert.equal(result.verdict, 'approve');
  });
});

test('scope and dependency violations after position 500 request changes', async () => {
  for (const [last, spec, finding] of [
    ['outside/file.txt', { scope: ['safe/'] }, 'out-of-scope'],
    ['zz/package.json', { riskConstraints: ['no-dependency-changes'] }, 'dependency manifests']
  ] as const) {
    const result = await withPaths([...benign(500), last], () =>
      deterministicReview({ worktreePath: process.cwd(), baseSha: 'base', mission: mission(spec) }));
    assert.equal(result.verdict, 'request-changes');
    assert.ok(result.findings.some(f => f.includes(finding)));
  }
});

test('protected path 501 rejects even above content scanning threshold', async () => {
  const result = await withPaths([...benign(500), 'zz/private.txt'], () =>
    deterministicReview({ worktreePath: process.cwd(), baseSha: 'base', mission: mission() }),
    { diff: '+'.padEnd(600 * 1024, 'x') });
  assert.equal(result.verdict, 'reject');
  assert.deepEqual(result.findings, ['protected path modified: zz/private.txt']);
});

test('NUL framing preserves textual names exactly without trimming or quoting', async () => {
  const paths = [' leading.txt', 'trailing.txt ', 'tab\tname.txt', 'line\nname.txt', 'quote"name.txt', '日本語-é.txt'];
  await withPaths(paths, async () => assert.deepEqual(await changedFilesStrict(process.cwd(), 'base'), paths));
  await withPaths([], async () => assert.deepEqual(await changedFilesStrict(process.cwd(), 'base'), []));
  await withPaths(['one'], async () => assert.deepEqual(await changedFilesStrict(process.cwd(), 'base'), ['one']));
});

test('ordinary Git failures, output overflow and malformed framing cannot approve', async () => {
  for (const opts of [{ error: true }, { overflow: true }, { raw: 'missing terminator' }, { raw: 'one\0\0' }]) {
    await withPaths([], async () => {
      await assert.rejects(() => changedFilesStrict(process.cwd(), 'base'), opts.overflow ? GitOutputLimitError : GitError);
      const result = await deterministicReview({ worktreePath: process.cwd(), baseSha: 'base', mission: mission() });
      assert.equal(result.verdict, 'request-changes');
      assert.ok(result.findings.some(f => f.startsWith('review error:')));
    }, opts);
  }
});

test('actual Git rename retains the protected source deletion for review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alr-review-rename-'));
  const hooks = join(dir, 'hooks'); mkdirSync(hooks);
  const repo = join(dir, 'repo'); mkdirSync(repo);
  const git = (args: string[]) => childProcess.execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 30_000 });
  let succeeded = false;
  try {
    git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'core.hooksPath', hooks]);
    mkdirSync(join(repo, 'zz')); mkdirSync(join(repo, 'safe'));
    writeFileSync(join(repo, 'zz/private.txt'), 'ordinary fixture content\n');
    const literalNames = [' leading.txt', 'spaced 日本語.txt'];
    for (const name of literalNames) writeFileSync(join(repo, name), 'base\n');
    git(['add', '.']); git(['-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture']);
    const base = git(['rev-parse', 'HEAD']).trim();
    renameSync(join(repo, 'zz/private.txt'), join(repo, 'safe/public.txt'));
    for (const name of literalNames) writeFileSync(join(repo, name), 'changed\n');
    git(['add', '.']); git(['-c', 'commit.gpgSign=false', 'commit', '-qm', 'rename']);
    const paths = await changedFilesStrict(repo, base);
    assert.ok(paths.includes('zz/private.txt')); assert.ok(paths.includes('safe/public.txt'));
    for (const name of literalNames) assert.ok(paths.includes(name), 'real Git preserves textual name');
    assert.equal((await deterministicReview({ worktreePath: repo, baseSha: base, mission: mission() })).verdict, 'reject');
    succeeded = true;
  } finally {
    if (succeeded) rmSync(dir, { recursive: true, force: true });
    else console.error(`Retained rename fixture: ${dir}`);
  }
});
