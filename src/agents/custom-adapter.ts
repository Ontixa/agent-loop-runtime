import { CliAdapterBase, substituteArgs, resolveExecutable } from './cli-adapter-base.js';
import type { AgentConfig, AgentInvocation, AgentInvocationContext, AgentAvailability } from '../types.js';

/**
 * Custom (arbitrary CLI) agent adapter.
 *
 * Lets users wrap any terminal coding agent:
 *
 *   agent:
 *     name: my-agent
 *     type: custom
 *     command: myagent
 *     args: ["run", "{objective}", "--workdir", "{worktree}"]
 *
 * Placeholders are validated at config time. Execution is argv-only — the
 * command string is never concatenated into a shell line.
 */

const VALID_PLACEHOLDERS = new Set(['prompt', 'objective', 'mission', 'task', 'worktree', 'repository']);

/** Validate a custom agent config; returns error messages (empty = valid). */
export function validateCustomAgent(config: AgentConfig): string[] {
  const errors: string[] = [];
  if (!config.command || typeof config.command !== 'string' || config.command.trim() === '') {
    errors.push('custom agent requires a non-empty "command"');
  }
  if (config.command && /[|&;<>$`]/.test(config.command)) {
    errors.push('custom agent "command" must be an executable, not a shell expression');
  }
  if (config.args !== undefined) {
    if (!Array.isArray(config.args)) {
      errors.push('"args" must be an array of strings');
    } else {
      for (const arg of config.args) {
        if (typeof arg !== 'string') {
          errors.push('every entry in "args" must be a string');
          continue;
        }
        for (const m of arg.matchAll(/\{([^}]*)\}/g)) {
          if (!VALID_PLACEHOLDERS.has(m[1].toLowerCase())) {
            errors.push(`unknown placeholder {${m[1]}} — valid: ${[...VALID_PLACEHOLDERS].join(', ')}`);
          }
        }
      }
    }
  }
  if (config.additionalArgs !== undefined && !Array.isArray(config.additionalArgs)) {
    errors.push('"additionalArgs" must be an array of strings');
  }
  return errors;
}

export class CustomAdapter extends CliAdapterBase {
  readonly type = 'custom';
  readonly displayName = 'Custom agent';

  constructor(private readonly customName?: string) {
    super();
  }

  protected candidates(): string[] {
    return this.customName ? [this.customName] : [];
  }

  async detect(config?: AgentConfig): Promise<AgentAvailability> {
    const command = config?.command ?? this.customName;
    if (!command) return { available: false, error: 'no command configured' };
    const exe = await resolveExecutable([command]);
    if (!exe) return { available: false, error: `command not found: ${command}` };
    return { available: true, executable: exe };
  }

  buildInvocation(ctx: AgentInvocationContext, config: AgentConfig): AgentInvocation {
    const errors = validateCustomAgent(config);
    if (errors.length > 0) {
      throw new Error(`Invalid custom agent '${config.name}': ${errors.join('; ')}`);
    }

    let args: string[];
    if (config.args && config.args.length > 0) {
      args = substituteArgs(config.args, ctx);
      // If the template carries no prompt placeholder at all, append the
      // prompt as the final argument (documented behavior).
      const hasPrompt = config.args.some(a => /\{(prompt|objective)\}/i.test(a));
      if (!hasPrompt) args.push(ctx.prompt);
    } else {
      args = [ctx.prompt];
    }
    if (config.additionalArgs?.length) args.push(...config.additionalArgs);

    return { command: config.command!, args, ...(ctx.env ? { env: ctx.env } : {}) };
  }
}
