import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { AgentInvocation } from '../types.js';

const EXECUTABLE_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat'];

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** Resolve PATH shims before Node's native spawn, which cannot execute .cmd files. */
function findExecutable(command: string, cwd: string, extra?: Record<string, string>): string {
  const hasDirectory = /[\\/]/.test(command);
  const pathKey = Object.keys(extra ?? {}).find(key => key.toLowerCase() === 'path');
  const inheritedKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path');
  const pathValue = pathKey ? extra![pathKey] : inheritedKey ? process.env[inheritedKey] : '';
  const candidates = hasDirectory || isAbsolute(command)
    ? [resolve(cwd, command)]
    : (pathValue ?? '').split(';').filter(Boolean).map(dir => resolve(cwd, dir.replace(/^"|"$/g, ''), command));
  for (const candidate of candidates) {
    // npm also installs an extensionless Unix shell launcher. Do not select it on Windows.
    const names = extname(candidate) ? [candidate] : EXECUTABLE_EXTENSIONS.map(ext => candidate + ext);
    const found = names.find(isFile);
    if (found) return found;
  }
  return command;
}

// Recognize the complete current npm Node shim, not an arbitrary script that merely
// mentions a JavaScript file. Unknown wrappers retain their own batch semantics.
const NPM_NODE_HEADER = `@ECHO off
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

function npmNodeEntryPoint(command: string): string | undefined {
  let source: string;
  try { source = readFileSync(command, 'utf8').replace(/\r\n/g, '\n'); }
  catch { return undefined; }
  if (!source.startsWith(NPM_NODE_HEADER)) return undefined;
  const target = source.slice(NPM_NODE_HEADER.length).match(
    /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%"  "%dp0%\\([^"\r\n%]+)" %\*\n?$/
  )?.[1];
  if (!target || !/\.(?:c?js|mjs)$/i.test(target)) return undefined;
  const entry = resolve(dirname(command), target);
  return isFile(entry) ? entry : undefined;
}

/** Restricted literal batch arguments; arbitrary agent prompts must use native/Node argv. */
export function quoteBatchLiteral(value: string): string {
  if (/[\x00-\x1f"%!^&|<>]/.test(value)) {
    throw new Error('Batch arguments must be literal single-line text without shell metacharacters; configure a native executable or Node entry point for arbitrary prompts');
  }
  // The final program may use the Windows CRT parser: protect a trailing backslash
  // from escaping its closing quote when a wrapper forwards %* to that program.
  return `"${value.replace(/(\\+)$/, '$1$1')}"`;
}

export function windowsInvocation(inv: AgentInvocation, cwd: string): AgentInvocation {
  const command = findExecutable(inv.command, cwd, inv.env);
  if (!/\.(cmd|bat)$/i.test(command)) return { ...inv, command };

  const entry = npmNodeEntryPoint(command);
  if (entry) {
    const localNode = join(dirname(command), 'node.exe');
    return { ...inv, command: isFile(localNode) ? localNode : process.execPath,
      args: [entry, ...inv.args] };
  }

  const line = [command, ...inv.args].map(quoteBatchLiteral).join(' ');
  return {
    ...inv,
    command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/v:off', '/c', `"${line}"`],
    windowsVerbatimArguments: true
  };
}
