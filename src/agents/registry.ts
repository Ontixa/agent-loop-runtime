import type { AgentAdapter, AgentConfig, AgentAvailability } from '../types.js';
import { AgentType } from '../types.js';
import {
  QwenAdapter, CodexAdapter, ClaudeAdapter, DevinAdapter,
  GeminiAdapter, OpenCodeAdapter, AiderAdapter
} from './vendor-adapters.js';
import { CustomAdapter, validateCustomAgent } from './custom-adapter.js';
import { logger } from '../logger.js';

/**
 * Agent adapter registry — maps adapter type names to adapter instances.
 * Vendor-neutral: the scheduler only ever sees AgentAdapter.
 */

const registry = new Map<string, AgentAdapter>();

export function registerAdapter(adapter: AgentAdapter): void {
  registry.set(adapter.type, adapter);
}

export function getAdapter(type: string, config?: AgentConfig): AgentAdapter {
  const normalized = type.toLowerCase();
  if (normalized === AgentType.CUSTOM) {
    return new CustomAdapter(config?.command ?? config?.name);
  }
  const adapter = registry.get(normalized);
  if (!adapter) {
    // Unknown vendor type → treat as custom command if a command is given
    if (config?.command) {
      logger.warn(`Unknown agent type '${type}', treating as custom agent`, { agent: config.name });
      return new CustomAdapter(config.command);
    }
    throw new Error(
      `Unknown agent type: '${type}'. Known adapters: ${[...registry.keys(), 'custom'].join(', ')}`
    );
  }
  return adapter;
}

export function listAdapterTypes(): string[] {
  return [...registry.keys(), 'custom'];
}

/** Probe availability of every known adapter. */
export async function detectAll(configs?: AgentConfig[]): Promise<Array<{ type: string; displayName: string } & AgentAvailability>> {
  const results: Array<{ type: string; displayName: string } & AgentAvailability> = [];
  for (const adapter of registry.values()) {
    const config = configs?.find(c => c.type === adapter.type);
    const avail = await adapter.detect(config);
    results.push({ type: adapter.type, displayName: adapter.displayName, ...avail });
  }
  return results;
}

/** Validate an agent config against its adapter's rules. */
export function validateAgentConfig(config: AgentConfig): string[] {
  const errors: string[] = [];
  if (!config.name || config.name.trim() === '') errors.push('agent requires a name');
  if (!config.type || config.type.trim() === '') errors.push(`agent '${config.name}' requires a type`);
  if (config.type === AgentType.CUSTOM) {
    errors.push(...validateCustomAgent(config));
  }
  if (config.env !== undefined && (typeof config.env !== 'object' || config.env === null)) {
    errors.push(`agent '${config.name}': env must be an object`);
  }
  return errors;
}

// Register built-in vendor adapters
for (const a of [
  new QwenAdapter(), new CodexAdapter(), new ClaudeAdapter(), new DevinAdapter(),
  new GeminiAdapter(), new OpenCodeAdapter(), new AiderAdapter()
]) {
  registerAdapter(a);
}
