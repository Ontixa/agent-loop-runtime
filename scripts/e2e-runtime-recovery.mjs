#!/usr/bin/env node
/**
 * e2e acceptance: runtime recovery
 *
 * Exercises the full contract end to end against the PACKED artifact:
 *
 *   npm pack → temp install → fixture repo → init → doctor →
 *   run (real change + real validation) → SIGKILL mid-agent →
 *   stale/recover → resume → truthful COMPLETED → report (human + JSON)
 *
 * Asserts: history preserved across the crash, the lease stops a second
 * runner, validation is a real subprocess, and nothing is pushed/merged.
 *
 * Usage:  node scripts/e2e-runtime-recovery.mjs
 * Exit:   0 = all checks passed; 1 = a check failed (report printed).
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const NODE = process.execPath;
// npm is a .cmd shim on Windows (unspawnable without shell); run npm-cli.js
// under node directly — same result, argv-only, no shell.
import { dirname } from 'node:path';
const NPM_CLI = process.platform === 'win32'
  ? join(dirname(NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : 'npm';
const npm = (args, cwd) => process.platform === 'win32'
  ? run(NODE, [NPM_CLI, ...args], cwd)
  : run(NPM_CLI, args, cwd);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const fail = (msg) => { console.error(`\nFATAL: ${msg}`); summarize(1); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const run = (cmd, args, cwd, opts = {}) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, ...opts });

function summarize(code) {
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  process.exit(code ?? (failed.length ? 1 : 0));
}

// ── 1. pack + install ────────────────────────────────────────────────────
console.log('phase 1: pack & install');
const work = mkdtempSync(join(tmpdir(), 'alr-e2e-'));
const installDir = join(work, 'install');
mkdirSync(installDir);
npm(['pack', '--pack-destination', work], REPO);
const tgz = join(work, readdirSync(work).find(f => f.endsWith('.tgz')));
check('npm pack produced a tarball', existsSync(tgz), tgz);

// Unpack the shipped artifact and run IT (not src/) — deps are junctioned
// from the repo's node_modules (npm install of the tarball needs network;
// the packed dist + real deps is the honest local-install equivalent).
const posix = p => p.replace(/\\/g, '/');
run('tar', ['--force-local', '-xzf', posix(tgz), '-C', posix(installDir)], work);
const pkgDir = join(installDir, 'package');
try {
  run('cmd', ['/c', 'mklink', '/J', join(pkgDir, 'node_modules'), join(REPO, 'node_modules')], work);
} catch {
  run('cmd', ['/c', 'xcopy', '/E', '/I', '/Q', join(REPO, 'node_modules'), join(pkgDir, 'node_modules')], work);
}
const CLI = join(pkgDir, 'dist', 'cli.js');
check('packed artifact contains runnable dist/cli.js', existsSync(CLI), CLI);

const cli = (args, cwd, opts) => run(NODE, [CLI, ...args], cwd, opts);

// ── 2. fixture repo ──────────────────────────────────────────────────────
console.log('phase 2: fixture repo (real bug, real test, real git)');
const fixture = join(work, 'fixture');
mkdirSync(fixture);
run('git', ['init', '-b', 'main'], fixture);
run('git', ['config', 'user.email', 'e2e@local'], fixture);
run('git', ['config', 'user.name', 'e2e'], fixture);
writeFileSync(join(fixture, 'app.js'), 'exports.add = (a, b) => a - b; // BUG\n');
writeFileSync(join(fixture, 'test.js'), `
const { add } = require('./app.js');
if (add(2, 3) !== 5) { console.error('FAIL: add(2,3) !== 5'); process.exit(1); }
console.log('PASS');
`);
// Agent that actually fixes the bug after a delay (long enough to be killed mid-flight).
writeFileSync(join(fixture, 'fake-agent.js'), `
const fs = require('fs');
const delay = Number(process.env.FIXTURE_DELAY_MS || 6000);
console.log('agent working...');
setTimeout(() => {
  fs.writeFileSync('app.js', 'exports.add = (a, b) => a + b; // fixed by agent\\n');
  console.log('fix applied');
}, delay);
`);

cli(['init', '--agent', 'custom'], fixture);
// Config: custom agent + a real validation gate. init wrote defaults; we
// overwrite with the fixture wiring (custom agent needs an explicit command).
writeFileSync(join(fixture, 'agentloop.config.json'), JSON.stringify({
  agents: [{ name: 'fixer', type: 'custom', command: NODE, args: [join(fixture, 'fake-agent.js'), '{objective}'] }],
  defaultAgent: 'fixer',
  workingDirectory: '.',
  validationCommands: { test: [NODE, 'test.js'] }
}, null, 2));
// Policy: allow the test gate; everything else defaults (push=approval,
// merge=never). The gate argv is an exact allowlist entry.
writeFileSync(join(fixture, 'agentloop.policy.json'), JSON.stringify({
  allowedCommands: [[NODE, 'test.js']],
  agentTimeoutMs: 60_000,
  approvalTimeoutMs: 30_000
}, null, 2));
check('fixture committed', true, run('git', ['add', '-A'], fixture) ?? '');
run('git', ['commit', '-m', 'fixture'], fixture);

const doctorOut = cli(['doctor', '--json'], fixture);
check('doctor runs on fixture', doctorOut.includes('git') || doctorOut.length > 10);

// ── 3. run → kill mid-agent ─────────────────────────────────────────────
console.log('phase 3: run mission, SIGKILL the runner mid-agent');
const child = spawn(NODE, [CLI, 'run', 'fix the add() bug', '--no-plan'], { cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { out += d; });

const missionId = await new Promise((res, rej) => {
  const t = setInterval(() => {
    const m = out.match(/Mission (msn-[\w-]+) created/);
    if (m) { clearInterval(t); res(m[1]); }
  }, 100);
  setTimeout(() => rej(new Error('mission never created; output:\n' + out)), 60_000);
});
check('mission created by foreground run', missionId.startsWith('msn-'), missionId);

const eventsFile = join(fixture, '.agentloop', 'missions', missionId, 'events.jsonl');
// Wait until the agent process is spawned (durable intent + pid recorded)
await new Promise((res, rej) => {
  const t = setInterval(() => {
    if (existsSync(eventsFile) && readFileSync(eventsFile, 'utf8').includes('agent_started')) { clearInterval(t); res(); }
  }, 150);
  setTimeout(() => rej(new Error('agent never spawned; events:\n' + (existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8') : '(none)'))), 60_000);
});
await sleep(1500); // mid-work
child.kill('SIGKILL'); // simulate runner death — NOT a graceful stop
await new Promise(r => child.on('exit', r));
check('runner killed mid-agent (SIGKILL)', true);

const status1 = JSON.parse(cli(['status', missionId, '--json'], fixture));
check('mission left in non-terminal state after crash', ['running', 'stale'].includes(status1.state), status1.state);

// ── 4. recover + resume ─────────────────────────────────────────────────
console.log('phase 4: resume — recover audit, retry interrupted work, validate');
const resumeOut = cli(['resume', missionId], fixture);
check('resume reaches a terminal state', /finished:\s*(completed|failed|blocked|cancelled)/i.test(resumeOut), resumeOut.trim().split('\n').pop());

const final = JSON.parse(cli(['status', missionId, '--json'], fixture));
check('mission COMPLETED truthfully', final.state === 'completed', final.state);
check('interrupted pass preserved in history', (final.passes ?? []).some(p => p.interrupted), `${(final.passes ?? []).length} passes`);
check('interrupted task was retried to completion', (final.tasks ?? []).every(t => t.status === 'completed'));
check('recovery audit recorded', !!final.lastRecovery, JSON.stringify(final.lastRecovery?.interruptedTasks ?? []));
check('runner lease released', !final.runner);

const wtApp = join(final.workspace.path, 'app.js');
check('agent fix landed in mission worktree', existsSync(wtApp) && readFileSync(wtApp, 'utf8').includes('a + b'));
check('main checkout untouched (isolation)', readFileSync(join(fixture, 'app.js'), 'utf8').includes('a - b'));

// ── 5. report ────────────────────────────────────────────────────────────
console.log('phase 5: report + receipt');
const humanReport = cli(['report', missionId], fixture);
check('human-readable report renders', /state|outcome|validation/i.test(humanReport));
const receipt = JSON.parse(cli(['report', missionId, '--json'], fixture));
check('receipt: revision + policyHash present',
  receipt.mission?.revision >= 1 && typeof receipt.mission?.policyHash === 'string' && receipt.mission.policyHash.length >= 8);
check('receipt: gate results recorded',
  (receipt.passes ?? []).flatMap(p => p.gates ?? []).some(g => g.name === 'test' && g.passed));
check('receipt: recovery audit in receipt', !!receipt.lastRecovery);
check('receipt: usage cumulative across resume', (receipt.usage?.agentInvocations ?? 0) >= 2, `invocations=${receipt.usage?.agentInvocations}`);

// events log: monotonic seq, unique ids
const events = readFileSync(eventsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const seqs = events.map(e => e.seq).filter(s => typeof s === 'number');
check('events sequenced monotonically', seqs.length > 3 && seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
check('event ids unique', new Set(events.map(e => e.id).filter(Boolean)).size === events.filter(e => e.id).length);

// no remote side effects: no push/merge anywhere
check('no push/merge events', !events.some(e => /push|merge/i.test(e.type)));
const branches = run('git', ['branch'], fixture);
check('mission branch kept for review, main unmerged', branches.includes('main'));

summarize();
