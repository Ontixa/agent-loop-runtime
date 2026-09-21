import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toSpawnInvocation } from '../agents/cli-adapter-base.js';
import { supervise } from '../supervisor/process-supervisor.js';

const npmHeader = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

`;

describe('Windows CLI invocation', { skip: process.platform !== 'win32' }, () => {
  test('npm shim in a spaced path preserves multiline and metacharacter arguments', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentloop shim '));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const shim = join(dir, 'fixture.cmd');
    writeFileSync(join(dir, 'fixture.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    writeFileSync(shim, npmHeader + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\fixture.cjs" %*\n');
    const args = ['first\nsecond', '"quoted"', '', 'trailing\\', '%PATH%', '!EXPAND!',
      'a & echo unsafe>unexpected.txt', '() ^ | < >', 'Tiếng Việt\t✓'];
    const invocation = toSpawnInvocation({ command: shim, args });
    const result = await supervise({ ...invocation, cwd: dir, timeoutMs: 30_000 });
    assert.equal(result.exitKind, 'success', result.outputTail);
    assert.deepEqual(JSON.parse(result.outputTail), args);
    assert.equal(existsSync(join(dir, 'unexpected.txt')), false);

    // The normal vendor adapters supply a bare name, not the resolved .cmd path.
    const fromPath = toSpawnInvocation({ command: 'fixture', args, env: { PATH: dir } });
    const pathResult = await supervise({ ...fromPath, cwd: dir, timeoutMs: 30_000 });
    assert.equal(pathResult.exitKind, 'success', pathResult.outputTail);
    assert.deepEqual(JSON.parse(pathResult.outputTail), args);

    const relative = toSpawnInvocation({ command: '.\\fixture.cmd', args }, dir);
    assert.equal(relative.command, invocation.command);
    assert.deepEqual(relative.args, invocation.args);

    writeFileSync(shim, npmHeader + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\fixture.cjs" %*\necho extra\n');
    assert.throws(() => toSpawnInvocation({ command: shim, args }), /Batch arguments must be literal/,
      'do not drop extra behavior from an unknown wrapper');
  });

  test('ordinary batch wrapper passes supported literal arguments', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentloop batch '));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const shim = join(dir, 'fixture.cmd');
    writeFileSync(join(dir, 'echo.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0echo.cjs" %*\r\n`);
    const args = ['space here', '', 'trailing\\', '--flag=value', 'Tiếng Việt'];
    const invocation = toSpawnInvocation({ command: shim, args });
    const result = await supervise({ ...invocation, cwd: dir, timeoutMs: 30_000 });
    assert.equal(result.exitKind, 'success', result.outputTail);
    assert.deepEqual(JSON.parse(result.outputTail), args);
  });

  test('unknown batch wrappers reject shell-sensitive input before spawning', () => {
    for (const argument of ['line\nbreak', 'carriage\rreturn', 'a"b', '%PATH%', '!x!',
      'a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a\0b']) {
      assert.throws(() => toSpawnInvocation({ command: 'unknown.cmd', args: [argument] }),
        /batch.*literal|native executable|Node entry point/i, argument);
    }
  });
});
