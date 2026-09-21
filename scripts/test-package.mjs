#!/usr/bin/env node
// Package inventory and actual unpacked-consumer acceptance. No registry writes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'alr-package-'));
console.log(`Retained package acceptance evidence: ${work}`);
const run = (cmd, args, cwd, extra = {}) => execFileSync(cmd, args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  timeout: 180_000, maxBuffer: 8 * 1024 * 1024, ...extra
});
const npm = (args, cwd) => process.platform === 'win32'
  ? run(process.execPath, [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...args], cwd)
  : run('npm', args, cwd);
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const required = [
  'package.json', 'LICENSE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'dist/index.js', 'dist/index.d.ts', 'dist/index.js.map', 'dist/index.d.ts.map',
  'dist/cli.js', 'src/index.ts', 'src/cli.ts', 'tsconfig.json',
  'qwen-loop.config.example.json', 'docs/threat-model.md', 'docs/deployment-guide.md',
  'scripts/run-tests.mjs', 'scripts/e2e-runtime-recovery.mjs',
  'scripts/demo-mission.mjs', 'scripts/test-demo.mjs', 'scripts/test-package.mjs'
];
const excluded = [
  '.env.production', 'operator-notes.txt', '.qwen/settings.json',
  '.github/workflows/private-fixture.yml', '.agentloop/daemon.json',
  'agentloop.config.json', 'agentloop.policy.json', 'qwen-loop.config.json',
  'scripts/operator-private.txt', 'src/operator-private.txt', 'dist/operator-private.txt'
];
const fixture = join(work, 'inventory');
mkdirSync(fixture);
// Inventory needs filenames, not real source or private incidental content.
for (const path of required) {
  mkdirSync(dirname(join(fixture, path)), { recursive: true });
  writeFileSync(join(fixture, path), 'synthetic required-file placeholder\n');
}
writeFileSync(join(fixture, 'package.json'), JSON.stringify(manifest, null, 2));
if (existsSync(join(root, '.gitignore'))) cpSync(join(root, '.gitignore'), join(fixture, '.gitignore'));
for (const path of excluded) {
  mkdirSync(dirname(join(fixture, path)), { recursive: true });
  writeFileSync(join(fixture, path), 'synthetic incidental fixture; not a credential\n');
}
function inventory(record) {
  const paths = new Set(record.files.map(file => file.path));
  for (const path of required) assert.ok(paths.has(path), `missing required package file: ${path}`);
  for (const path of excluded) assert.ok(!paths.has(path), `incidental file entered package: ${path}`);
  assert.ok([...paths].every(path => !path.startsWith('.qwen/') && !path.startsWith('.github/') && !path.startsWith('.agentloop/')),
    'private state/configuration directories must not be shipped');
  return paths;
}
const synthetic = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'], fixture))[0];
inventory(synthetic);
console.log('PASS synthetic required/excluded inventory');

const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', work], root))[0];
const paths = inventory(packed);
const install = join(work, 'install');
mkdirSync(install);
run('tar', ['-xzf', packed.filename, '-C', install.replace(/\\/g, '/')], work);
const pkg = join(install, 'package');
const maps = [...paths].filter(path => path.endsWith('.map'));
assert.ok(maps.length > 0, 'compiled source/declaration maps must be shipped');
for (const path of maps) {
  const map = JSON.parse(readFileSync(join(pkg, path), 'utf8'));
  for (const source of map.sources) {
    const target = resolve(dirname(join(pkg, path)), map.sourceRoot ?? '', source);
    const local = relative(pkg, target);
    assert.ok(local && !local.startsWith('..') && !isAbsolute(local), `map source escapes package: ${path}`);
    assert.ok(paths.has(local.replace(/\\/g, '/')), `map source missing from artifact: ${path}`);
  }
}
console.log(`PASS actual artifact inventory and ${maps.length} map source targets`);
// Local consumer test reuses installed dependencies; this is not a clean npm install.
symlinkSync(join(root, 'node_modules'), join(pkg, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const childEnv = { ...process.env, AGENTLOOP_LOG_FILE: join(work, 'consumer.log') };
const moduleUrl = pathToFileURL(join(pkg, manifest.main)).href;
run(process.execPath, ['--input-type=module', '-e',
  `import assert from 'node:assert/strict'; const runtime = await import(${JSON.stringify(moduleUrl)}); for (const name of ['MissionStore','MissionRunner','createMission','prepareMission','buildReceipt']) assert.equal(typeof runtime[name], 'function');`], work, { env: childEnv });
console.log('PASS unpacked public module import');
const help = run(process.execPath, [join(pkg, manifest.bin.agentloop), '--help'], work, { env: childEnv });
assert.ok(help.includes('report') && help.includes('run'), 'unpacked CLI help must expose mission commands');
console.log('PASS unpacked CLI help');
const demo = run(process.execPath, [join(pkg, 'scripts/test-demo.mjs')], work, { env: childEnv });
for (const message of ['PASS --help', 'PASS --unknown', 'PASS successful mission', 'PASS --fail-validation']) {
  assert.ok(demo.includes(message), `unpacked demo missing acceptance result: ${message}`);
}
console.log('PASS unpacked provider-free demo (4 scenarios)');
console.log('Package boundary acceptance passed; exclusion probes used synthetic markers, not credentials.');
