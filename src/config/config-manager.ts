import { existsSync, copyFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { readJsonFile, writeJsonAtomic } from '../util/atomic-file.js';
import type { RuntimeConfig, AgentConfig } from '../types.js';
import { AgentType } from '../types.js';
import { validateAgentConfig } from '../agents/registry.js';
import { logger } from '../logger.js';

/**
 * Runtime configuration (agentloop.config.json).
 *
 * Migration path: an existing qwen-loop.config.json is detected, backed up,
 * and translated to agentloop.config.json. The old file is never destroyed.
 */

export const CONFIG_FILE = 'agentloop.config.json';
export const LEGACY_CONFIG_FILES = ['qwen-loop.config.json', 'qwen-loop.config.example.json'];

const DEFAULT_CONFIG: RuntimeConfig = {
  agents: [],
  workingDirectory: '.',
  logLevel: 'info'
};

export class ConfigManager {
  readonly configPath: string;
  private config: RuntimeConfig;
  readonly loadedFromFile: boolean;
  /** Set when a legacy file was detected but not yet migrated */
  readonly legacyPath?: string;

  constructor(configPath?: string) {
    const cwd = process.cwd();
    this.configPath = configPath ? resolve(configPath) : join(cwd, CONFIG_FILE);

    if (existsSync(this.configPath)) {
      const raw = readJsonFile<Record<string, unknown>>(this.configPath);
      if (raw === undefined) {
        throw new Error(`Config file exists but is not valid JSON: ${this.configPath}`);
      }
      this.config = this.normalize(raw);
      this.loadedFromFile = true;
      return;
    }

    // Look for a legacy config beside the target file (cwd for the default
    // path; the repo dir when an explicit path was given).
    const searchDir = configPath ? dirname(this.configPath) : cwd;
    const legacy = LEGACY_CONFIG_FILES.map(f => join(searchDir, f)).find(existsSync);
    if (legacy) {
      this.legacyPath = legacy;
      const raw = readJsonFile<Record<string, unknown>>(legacy);
      this.config = raw ? this.migrateLegacy(raw) : { ...DEFAULT_CONFIG };
      this.loadedFromFile = true;
      return;
    }

    this.config = { ...DEFAULT_CONFIG };
    this.loadedFromFile = false;
  }

  getConfig(): RuntimeConfig {
    return this.config;
  }

  /** True if a legacy qwen-loop config was found (migration suggested). */
  hasLegacyConfig(): boolean {
    return this.legacyPath !== undefined;
  }

  /** Normalize arbitrary JSON into RuntimeConfig (tolerates legacy keys). */
  private normalize(raw: Record<string, unknown>): RuntimeConfig {
    const cfg: RuntimeConfig = {
      agents: Array.isArray(raw.agents) ? (raw.agents as AgentConfig[]) : [],
      defaultAgent: typeof raw.defaultAgent === 'string' ? raw.defaultAgent : undefined,
      workingDirectory: typeof raw.workingDirectory === 'string' ? raw.workingDirectory : '.',
      logLevel: (['error', 'warn', 'info', 'debug'] as const).includes(raw.logLevel as 'info')
        ? raw.logLevel as RuntimeConfig['logLevel'] : 'info',
      projects: Array.isArray(raw.projects) ? raw.projects as RuntimeConfig['projects'] : undefined,
      validationCommands: raw.validationCommands && typeof raw.validationCommands === 'object'
        ? raw.validationCommands as Record<string, string[]> : undefined,
      daemon: raw.daemon && typeof raw.daemon === 'object' ? raw.daemon as RuntimeConfig['daemon'] : undefined
    };
    return cfg;
  }

  /**
   * Translate a legacy qwen-loop.config.json into the new shape.
   * Preserved: agents (type qwen→qwen, custom→custom with command=name),
   * workingDirectory, logLevel, projects. Dropped: loop mechanics (replaced
   * by policy budgets), auto git behavior (replaced by policy).
   */
  migrateLegacy(raw: Record<string, unknown>): RuntimeConfig {
    const agents: AgentConfig[] = Array.isArray(raw.agents)
      ? (raw.agents as Array<Record<string, unknown>>).map(a => ({
          name: String(a.name ?? 'agent'),
          type: a.type === 'custom' ? AgentType.CUSTOM : (String(a.type ?? AgentType.QWEN) as AgentType),
          model: typeof a.model === 'string' ? a.model : undefined,
          timeout: typeof a.timeout === 'number' ? a.timeout : undefined,
          workingDirectory: typeof a.workingDirectory === 'string' ? a.workingDirectory : undefined,
          additionalArgs: Array.isArray(a.additionalArgs) ? a.additionalArgs as string[] : undefined,
          command: a.type === 'custom' ? String(a.command ?? a.name) : undefined
        }))
      : [];

    return {
      agents,
      defaultAgent: agents[0]?.name,
      workingDirectory: typeof raw.workingDirectory === 'string' ? raw.workingDirectory : '.',
      logLevel: 'info',
      projects: Array.isArray(raw.projects) ? raw.projects as RuntimeConfig['projects'] : undefined
    };
  }

  /**
   * Perform the on-disk migration: backup the legacy file, write
   * agentloop.config.json. Never overwrites an existing new config;
   * never deletes the legacy file.
   */
  migrateOnDisk(): { configPath: string; backupPath: string } | null {
    if (!this.legacyPath) return null;
    const target = join(process.cwd(), CONFIG_FILE);
    if (existsSync(target)) return null;

    const backupPath = `${this.legacyPath}.bak`;
    copyFileSync(this.legacyPath, backupPath);
    writeJsonAtomic(target, this.config);
    logger.info(`Migrated ${this.legacyPath} → ${target} (backup: ${backupPath})`);
    return { configPath: target, backupPath };
  }

  /** Validate config; returns error messages. */
  validateConfig(): string[] {
    const errors: string[] = [];
    for (const agent of this.config.agents) {
      errors.push(...validateAgentConfig(agent));
    }
    if (this.config.defaultAgent &&
        !this.config.agents.some(a => a.name === this.config.defaultAgent)) {
      errors.push(`defaultAgent '${this.config.defaultAgent}' does not match any configured agent`);
    }
    if (this.config.validationCommands) {
      for (const [name, argv] of Object.entries(this.config.validationCommands)) {
        if (!Array.isArray(argv) || argv.length === 0 || !argv.every(s => typeof s === 'string')) {
          errors.push(`validationCommands.${name} must be an argv array of strings`);
        }
      }
    }
    const admission = this.config.daemon?.admission;
    if (admission) {
      if (admission.enabled !== undefined && typeof admission.enabled !== 'boolean') {
        errors.push('daemon.admission.enabled must be a boolean');
      }
      for (const key of ['maxLoadPerCpu', 'minFreeMemRatio', 'recheckMs'] as const) {
        const v = admission[key];
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
          errors.push(`daemon.admission.${key} must be a non-negative number`);
        }
      }
      if (typeof admission.minFreeMemRatio === 'number' && admission.minFreeMemRatio > 1) {
        errors.push('daemon.admission.minFreeMemRatio must be between 0 and 1');
      }
    }
    return errors;
  }

  /** Generate a fresh example config for `agentloop init`. */
  static exampleConfig(agentType = 'qwen'): RuntimeConfig {
    return {
      agents: [{
        name: `${agentType}-1`,
        type: agentType,
        timeout: 1200000
      }],
      defaultAgent: `${agentType}-1`,
      workingDirectory: '.',
      logLevel: 'info',
      validationCommands: {
        // Examples — replace with your project's real commands
        // test: ["npm", "test"],
        // lint: ["npm", "run", "lint"],
        // build: ["npm", "run", "build"]
      }
    };
  }
}
