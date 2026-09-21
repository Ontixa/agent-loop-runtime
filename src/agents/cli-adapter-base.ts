import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { quoteBatchLiteral, windowsInvocation } from './windows-invocation.js';
import type {
  AgentAdapter, AgentAvailability, AgentConfig, AgentInvocation,
  AgentInvocationContext, AgentInvocationResult, AgentExitKind
} from '../types.js';
import { logger } from '../logger.js';

/**
 * Shared machinery for CLI-based agent adapters.
 *
 * Windows npm Node shims resolve to their JavaScript entry point and retain
 * native argv semantics. Other batch wrappers accept restricted literal
 * arguments only; arbitrary prompts must never enter cmd.exe parsing.
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
 * Quote a restricted literal batch argument; shell-sensitive values are refused.
 */
export function cmdQuote(arg: string): string {
  return quoteBatchLiteral(arg);
}

/**
 * Convert an argv invocation into the actual spawn call.
 * Callers must forward the complete result to spawn/supervise, including the
 * Windows transport flag, and provide the child's cwd for relative commands.
 */
export function toSpawnInvocation(inv: AgentInvocation, cwd = process.cwd()): AgentInvocation {
  return IS_WINDOWS ? windowsInvocation(inv, cwd) : inv;
}

/** Probe `exe <versionArgs>` for a version string. Never throws. */
export async function probeVersion(executable: string, versionArgs: string[] = ['--version']): Promise<string | undefined> {
  return new Promise((resolve) => {
    const inv = toSpawnInvocation({ command: executable, args: versionArgs });
    let proc;
    try {
      proc = spawn(inv.command, inv.args, {
        shell: false, windowsHide: true,
        windowsVerbatimArguments: inv.windowsVerbatimArguments,
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
