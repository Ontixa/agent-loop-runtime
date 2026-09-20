#!/usr/bin/env node
/**
 * Portable unit-test entry: enumerate src/__tests__/*.test.ts and run
 * `tsx --test` on the explicit file list.
 *
 * The previous `tsx --test src/__tests__/*.test.ts` relied on shell glob
 * expansion (bash only) or Node >=21's --test glob support. Both fail on
 * Windows cmd + Node 20 - the dependency floor is >=20.12 - so the file
 * list is built here instead, platform- and version-independent.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const dir = join(REPO, 'src', '__tests__');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(dir, f));
if (files.length === 0) {
  console.error(`no test files found in ${dir}`);
  process.exit(1);
}
const tsxCli = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const result = spawnSync(process.execPath, [tsxCli, '--test', ...files], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
