import { CliAdapterBase, substituteArgs } from './cli-adapter-base.js';
import type { AgentConfig, AgentInvocation, AgentInvocationContext } from '../types.js';

/**
 * Vendor CLI adapters.
 *
 * Each adapter knows how to build one bounded non-interactive invocation for
 * its CLI. The default argv template can be replaced wholesale via
 * `config.args` ({prompt} placeholder) or extended via `config.additionalArgs`.
 *
 * Defaults select each vendor's non-interactive mode and permission model.
 * Codex retains its workspace sandbox; Devin permits workspace edits while
 * retaining trust checks. Some other adapters use vendor autonomy flags.
 * Runtime policy and validation do not sandbox agent child processes.
 */

function mergeArgs(defaults: string[], config: AgentConfig, ctx: AgentInvocationContext): string[] {
  const base = config.args ? substituteArgs(config.args, ctx) : [...defaults];
  if (config.additionalArgs?.length) base.push(...config.additionalArgs);
  return base;
}

/** Qwen Code — original adapter, preserved behavior. */
export class QwenAdapter extends CliAdapterBase {
  readonly type = 'qwen';
  readonly displayName = 'Qwen Code';
  protected candidates(): string[] { return ['qwen']; }

  buildInvocation(ctx: AgentInvocationContext, config: AgentConfig): AgentInvocation {
    const args = config.args
      ? mergeArgs([], config, ctx)
      : mergeArgs([ctx.prompt, '--yolo', '-o', 'text'], config, ctx);
    if (config.model) args.push('-m', config.model);
    return { command: config.command ?? 'qwen', args, ...(ctx.env ? { env: ctx.env } : {}) };
  }
}

/** OpenAI Codex CLI — `codex exec` non-interactive mode. */
export class CodexAdapter extends CliAdapterBase {
  readonly type = 'codex';
  readonly displayName = 'Codex CLI';
  protected candidates(): string[] { return ['codex']; }

  buildInvocation(ctx: AgentInvocationContext, config: AgentConfig): AgentInvocation {
    const args = config.args
      ? mergeArgs([], config, ctx)
      : mergeArgs(['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', ctx.prompt], config, ctx);
    if (config.model) args.push('-m', config.model);
    return { command: config.command ?? 'codex', args, ...(ctx.env ? { env: ctx.env } : {}) };
  }
}

/** Anthropic Claude Code — print mode with permissions skipped. */
export class ClaudeAdapter extends CliAdapterBase {
  readonly type = 'claude';
  readonly displayName = 'Claude Code';
  protected candidates(): string[] { return ['claude']; }

  buildInvocation(ctx: AgentInvocationContext, config: AgentConfig): AgentInvocation {
    const args = config.args
      ? mergeArgs([], config, ctx)
      : mergeArgs(['-p', ctx.prompt, '--output-format', 'text', '--dangerously-skip-permissions'], config, ctx);
    if (config.model) args.push('--model', config.model);
    return { command: config.command ?? 'claude', args, ...(ctx.env ? { env: ctx.env } : {}) };
  }
}

/**
 * Devin CLI — print mode exits after one non-interactive turn.
 * Accept workspace edits, but retain Devin's checks for other tool actions
 * and workspace trust. Operators can supply explicit argv overrides.
 */
export class DevinAdapter extends CliAdapterBase {
  readonly type = 'devin';
  readonly displayName = 'Devin CLI';
  protected candidates(): string[] { return ['devin']; }

  buildInvocation(ctx: AgentInvocationContext, config: AgentConfig): AgentInvocation {
    const args = config.args
      ? mergeArgs([], config, ctx)
      : mergeArgs(['--print', ctx.prompt, '--permission-mode', 'accept-edits'], config, ctx);
    if (config.model) args.push('--model', config.model);
    return { command: config.command ?? 'devin', args, ...(ctx.env ? { env: ctx.env } : {}) };
  }
}

/** Google Gemini CLI — positional prompt with --yolo auto-approve. */
export class GeminiAdapter extends CliAdapterBase {
  readonly type = 'gemini';
  readonly displayName = 'Gemini CLI';
  protected candidates(): string[] { return ['gemini']; }

  buildInvocation(ctx: AgentInvocationContext, config: AgentConfig): AgentInvocation {
    const args = config.args
      ? mergeArgs([], config, ctx)
      : mergeArgs([ctx.prompt, '--yolo'], config, ctx);
    if (config.model) args.push('-m', config.model);
    return { command: config.command ?? 'gemini', args, ...(ctx.env ? { env: ctx.env } : {}) };
  }
}

/** OpenCode — `opencode run` non-interactive. */
export class OpenCodeAdapter extends CliAdapterBase {
  readonly type = 'opencode';
  readonly displayName = 'OpenCode';
  protected candidates(): string[] { return ['opencode']; }

  buildInvocation(ctx: AgentInvocationContext, config: AgentConfig): AgentInvocation {
    const args = config.args
      ? mergeArgs([], config, ctx)
      : mergeArgs(['run', ctx.prompt], config, ctx);
    if (config.model) args.push('-m', config.model);
    return { command: config.command ?? 'opencode', args, ...(ctx.env ? { env: ctx.env } : {}) };
  }
}

/** Aider — message mode with auto-commits disabled (runtime owns commits). */
export class AiderAdapter extends CliAdapterBase {
  readonly type = 'aider';
  readonly displayName = 'Aider';
  protected candidates(): string[] { return ['aider']; }

  buildInvocation(ctx: AgentInvocationContext, config: AgentConfig): AgentInvocation {
    const args = config.args
      ? mergeArgs([], config, ctx)
      : mergeArgs(['--message', ctx.prompt, '--yes-always', '--no-auto-commits'], config, ctx);
    if (config.model) args.push('--model', config.model);
    return { command: config.command ?? 'aider', args, ...(ctx.env ? { env: ctx.env } : {}) };
  }
}
