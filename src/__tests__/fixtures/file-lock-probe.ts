// Owned subprocess fixture: fault injection never affects the parent test process.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withFileLock } from '../../util/atomic-file.js';

const mode = process.argv[2];
const phase = (value: string) => process.stderr.write(`lock-probe:${mode}:${value}\n`);
phase('loaded');
const dir = fs.mkdtempSync(join(tmpdir(), 'alr-lock-probe-'));
const path = join(dir, 'mission.lock');
const mutableFs = fs as { -readonly [Key in keyof typeof fs]: (typeof fs)[Key] };
const original = { kill: process.kill, stat: fs.statSync, read: fs.readFileSync, unlink: fs.unlinkSync };
const age = () => fs.utimesSync(path, new Date(0), new Date(0));
let entered = false;
let error: string | undefined;
let preserved = false;
let freeAcquired = false;
const attempt = () => {
  phase('attempt-start');
  try { withFileLock(path, () => { entered = true; }, {
    staleMs: mode === 'fresh-live' ? 1_000_000_000 : 1,
    timeoutMs: mode === 'zero-timeout' ? 0 : 75
  }); }
  catch (e) { error = (e as NodeJS.ErrnoException).code ?? (e as Error).name; }
  phase('attempt-returned');
};
try {
  phase('setup');
  if (mode === 'aged-live' || mode === 'fresh-live' || mode === 'zero-timeout') {
    withFileLock(path, () => {
      freeAcquired = true;
      const before = fs.readFileSync(path, 'utf8');
      if (mode === 'aged-live') age();
      attempt();
      preserved = fs.existsSync(path) && fs.readFileSync(path, 'utf8') === before;
    }, mode === 'zero-timeout' ? { timeoutMs: 0 } : {});
  } else if (mode === 'invalid-bounds') {
    let rejected = 0;
    for (const key of ['timeoutMs', 'staleMs']) for (const value of [NaN, Infinity, -1]) {
      try { withFileLock(path, () => { entered = true; }, { [key]: value }); }
      catch (e) { if (e instanceof RangeError) rejected++; else throw e; }
    }
    error = rejected === 6 ? 'RangeError' : 'missing rejection';
    preserved = !fs.existsSync(path);
  } else if (mode === 'callback-error') {
    try { withFileLock(path, () => { throw new Error('fixture callback'); }); }
    catch { error = 'callback'; }
    preserved = !fs.existsSync(path);
  } else {
    const child = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000, windowsHide: true });
    if (child.error || child.status !== 0 || !child.pid) throw new Error('dead-owner fixture child failed');
    const owner = { pid: child.pid, nonce: '0123456789abcdef', at: new Date().toISOString() };
    const raw = mode === 'malformed' ? '{incomplete' : JSON.stringify({ ...owner,
      ...(mode === 'invalid-pid' ? { pid: 0 } : {}),
      ...(mode === 'invalid-nonce' ? { nonce: '' } : {}) });
    fs.writeFileSync(path, raw); age();
    if (mode === 'probe-eperm' || mode === 'probe-unknown') {
      process.kill = (() => { throw Object.assign(new Error('fixture probe'), { code: mode === 'probe-eperm' ? 'EPERM' : 'EINVAL' }); }) as typeof process.kill;
    }
    if (mode === 'stat-eperm' || mode === 'stat-enoent') {
      mutableFs.statSync = ((...args: Parameters<typeof fs.statSync>) => {
        if (String(args[0]) === path) throw Object.assign(new Error('fixture stat'), { code: mode === 'stat-eperm' ? 'EPERM' : 'ENOENT' });
        return original.stat(...args);
      }) as typeof fs.statSync;
    }
    if (mode === 'unlink-eperm' || mode === 'unlink-enoent') {
      fs.unlinkSync = ((file: fs.PathLike) => {
        if (String(file) === path) throw Object.assign(new Error('fixture unlink'), { code: mode === 'unlink-eperm' ? 'EPERM' : 'ENOENT' });
        return original.unlink(file);
      }) as typeof fs.unlinkSync;
    }
    let replacement = '';
    if (mode === 'read-eperm') {
      fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === path) throw Object.assign(new Error('fixture read'), { code: 'EPERM' });
        return original.read(...args);
      }) as typeof fs.readFileSync;
    }
    if (mode === 'replacement') {
      let reads = 0;
      fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === path && ++reads === 2) {
          replacement = JSON.stringify({ ...owner, pid: process.pid, nonce: 'fedcba9876543210' });
          fs.writeFileSync(path, replacement); age();
        }
        return original.read(...args);
      }) as typeof fs.readFileSync;
    }
    syncBuiltinESMExports();
    attempt();
    preserved = fs.existsSync(path) && original.read(path, 'utf8') === (replacement || raw);
  }
  console.log(JSON.stringify({ mode, entered, error, preserved, freeAcquired }));
} finally {
  phase('cleanup-start');
  process.kill = original.kill; mutableFs.statSync = original.stat;
  fs.readFileSync = original.read; fs.unlinkSync = original.unlink;
  syncBuiltinESMExports();
  fs.rmSync(dir, { recursive: true, force: true });
  phase('cleanup-done');
}
