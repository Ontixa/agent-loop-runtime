import { spawn } from 'child_process';
import { existsSync } from 'fs';
import type {
  AgentAdapter, AgentAvailability, AgentConfig, AgentInvocation,
  AgentInvocationContext, AgentInvocationResult, AgentExitKind
} from '../types.js';
import { logger } from '../logger.js';

/**
 * Shared machinery for CLI-based agent adapters.
 *
 * Executable resolution handles Windows shims (.cmd/.bat cannot be spawned
 * with shell:false since Node 20.12 — they are routed through cmd.exe with
 * strictly quoted argv, which is not the same as shell:true string
 * interpolation and does not permit shell metacharacter injection).
 */

const IS_WINDOWS = process.platform === 'win32';

/**
 * Resolve an executable from candidate names.
 * Returns absolute path or bare command name found on PATH, else null.
 */
export async function resolveExecutable(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    // Explicit path?
    if (/[\\/]/.test(candidate) && existsSync(candidate)) return candidate;
    const found = await which(candidate);
    if (found) return found;
  }
  return null;
}

function which(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = IS_WINDOWS ? 'where.exe' : 'which';
    const proc = spawn(cmd, [name], { shell: false, windowsHide: true });
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const first = out.split('\n').map(l => l.trim()).filter(Boolean)[0];
      resolve(first ?? null);
    });
    proc.on('error', () => resolve(null));
  });
}

/** True if a resolved executable is a batch shim needing cmd.exe routing. */
export function isBatchShim(executable: string): boolean {
  return /\.(cmd|bat)$/i.test(executable);
}

/**
 * Quote one argument for a cmd.exe command line: wrap in double quotes and
 * double inner quotes. Inside quotes, & | < > ^ are literal in cmd.exe.
 */
export function cmdQuote(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Convert an argv invocation into the actual spawn call.
 * On Windows, .cmd/.bat shims go through cmd.exe /d /s /c with every argument
 * double-quoted — argv semantics preserved, no shell string interpolation.
 */
export function toSpawnInvocation(inv: AgentInvocation): AgentInvocation {
  if (IS_WINDOWS && isBatchShim(inv.command)) {
    const line = [cmdQuote(inv.command), ...inv.args.map(cmdQuote)].join(' ');
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', line],
      env: inv.env
    };
  }
  return inv;
}

/** Probe `exe <versionArgs>` for a version string. Never throws. */
export async function probeVersion(executable: string, versionArgs: string[] = ['--version']): Promise<string | undefined> {
  return new Promise((resolve) => {
    const inv = toSpawnInvocation({ command: executable, args: versionArgs });
    let proc;
    try {
      proc = spawn(inv.command, inv.args, {
        shell: false, windowsHide: true,
        env: process.env,
        detached: process.platform !== 'win32'
      });
    } catch {
      return resolve(undefined);
    }
    let out = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* noop */ } }, 10000);
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', () => {
      clearTimeout(timer);
      const line = out.split('\n').map(l => l.trim()).filter(Boolean)[0];
      resolve(line?.slice(0, 120));
    });
    proc.on('error', () => { clearTimeout(timer); resolve(undefined); });
  });
}

/**
 * Substitute {placeholders} in an argv template.
 * {prompt}/{objective} → ctx.prompt, {mission} → missionId, {task} → taskId,
 * {worktree} → ctx.cwd, {repository} → repo root (ctx.cwd's parent chain —
 * adapters pass worktree; repository is ctx.cwd when in-place).
 */
export function substituteArgs(template: string[], ctx: AgentInvocationContext): string[] {
  const map: Record<string, string> = {
    prompt: ctx.prompt,
    objective: ctx.prompt,
    mission: ctx.missionId,
    task: ctx.taskId ?? '',
    worktree: ctx.cwd,
    repository: ctx.cwd
  };
  return template.map(a =>
    a.replace(/\{(prompt|objective|mission|task|worktree|repository)\}/gi, (m, k) => map[k.toLowerCase()])
  );
}

/** Base class for vendor CLI adapters. */
export abstract class CliAdapterBase implements AgentAdapter {
  abstract readonly type: string;
  abstract readonly displayName: string;
  /** Executable names to probe, in order */
  protected abstract candidates(): string[];
  protected versionArgs(): string[] { return ['--version']; }

  async detect(config?: AgentConfig): Promise<AgentAvailability> {
    try {
      const exe = config?.command
        ? (existsSync(config.command) ? config.command : await resolveExecutable([config.command]))
        : await resolveExecutable(this.candidates());
      if (!exe) {
        return { available: false, error: `${this.displayName} CLI not found on PATH` };
      }
      const version = await probeVersion(exe, this.versionArgs());
      return { available: true, executable: exe, version };
    } catch (err) {
      return {
        available: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  abstract buildInvocation(ctx: AgentInvocationContext, config: AgentConfig): AgentInvocation;

  /** Default: trust the supervisor's classification. */
  classifyExit(result: AgentInvocationResult): AgentExitKind {
    return result.exitKind;
  }

  /** Helper: resolve executable or fall back to first candidate name. */
  protected async exe(config: AgentConfig): Promise<string> {
    if (config.command) return config.command;
    return (await resolveExecutable(this.candidates())) ?? this.candidates()[0];
  }
}
