import { existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { ConfigManager, CONFIG_FILE } from '../config/config-manager.js';
import { writeDefaultPolicy, loadPolicy, POLICY_FILE } from '../policy/policy.js';
import { writeJsonAtomic } from '../util/atomic-file.js';
import { inspectRepo } from '../git/repo-inspector.js';
import { getAdapter } from '../agents/registry.js';
import { gitStdout } from '../git/git-runner.js';
import { AgentType } from '../types.js';
import type { AgentConfig } from '../types.js';

/**
 * Setup commands: init, doctor, migrate.
 */

const GITIGNORE_BLOCK = [
  '# Agent Loop Runtime state',
  '.agentloop/'
].join('\n');

export async function cmdInit(opts: { agent?: string; force?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const repo = await inspectRepo(cwd);
  if (!repo.isRepo) {
    console.log(chalk.yellow('Warning: current directory is not a git repository.'));
    console.log('Missions require a git repo. Run `git init` first, then re-run `agentloop init`.');
  }

  const configPath = join(cwd, CONFIG_FILE);
  if (existsSync(configPath) && !opts.force) {
    console.log(`${CONFIG_FILE} already exists (use --force to overwrite).`);
  } else {
    const agentType = opts.agent ?? 'qwen';
    writeJsonAtomic(configPath, ConfigManager.exampleConfig(agentType));
    console.log(chalk.green(`Created ${CONFIG_FILE} (agent: ${agentType})`));
  }

  const policyPath = join(cwd, POLICY_FILE);
  if (!existsSync(policyPath)) {
    writeDefaultPolicy(cwd);
    console.log(chalk.green(`Created ${POLICY_FILE} — review before running missions.`));
  } else {
    console.log(`${POLICY_FILE} already exists.`);
  }

  // Gitignore runtime state — agents must never commit their own ledger
  const giPath = join(cwd, '.gitignore');
  if (existsSync(giPath)) {
    const { readFileSync, appendFileSync } = await import('fs');
    const current = readFileSync(giPath, 'utf8');
    if (!current.includes('.agentloop/')) {
      appendFileSync(giPath, `\n${GITIGNORE_BLOCK}\n`);
      console.log('Added .agentloop/ to .gitignore');
    }
  } else {
    const { writeFileSync } = await import('fs');
    writeFileSync(giPath, `${GITIGNORE_BLOCK}\n`);
    console.log('Created .gitignore with .agentloop/ entry');
  }

  console.log('\nNext steps:');
  console.log('  agentloop doctor                     # verify environment');
  console.log('  agentloop run "fix the login bug" \\');
  console.log('    --criteria "npm test passes"       # run a mission');
}

export async function cmdDoctor(opts: { json?: boolean }): Promise<void> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const cfg = new ConfigManager();

  // Node + git
  checks.push({ name: 'node', ok: true, detail: process.version });
  try {
    const gitVersion = await gitStdout(['--version'], process.cwd());
    checks.push({ name: 'git', ok: true, detail: gitVersion });
  } catch (e) {
    checks.push({ name: 'git', ok: false, detail: String(e) });
  }

  // Config
  const configErrors = cfg.validateConfig();
  checks.push({
    name: 'config',
    ok: configErrors.length === 0,
    detail: cfg.loadedFromFile
      ? (configErrors.length ? configErrors.join('; ') : 'ok')
      : 'no config file (run agentloop init)'
  });
  if (cfg.hasLegacyConfig()) {
    checks.push({ name: 'legacy-config', ok: true, detail: `found ${cfg.legacyPath} — run 'agentloop migrate'` });
  }

  // Policy
  const { loadedFromFile } = loadPolicy(process.cwd());
  checks.push({ name: 'policy', ok: true, detail: loadedFromFile ? POLICY_FILE : 'defaults (no policy file)' });

  // Repo
  const repo = await inspectRepo(process.cwd());
  checks.push({
    name: 'repository',
    ok: repo.isRepo,
    detail: repo.isRepo
      ? `${repo.branch}${repo.dirty ? ' (dirty)' : ''}${repo.hasRemote ? ` remote=${repo.remote}` : ' no-remote'}`
      : 'not a git repository'
  });

  // Agents — from config, or probe the common CLIs
  const agents: AgentConfig[] = cfg.getConfig().agents.length > 0
    ? cfg.getConfig().agents
    : (['qwen', 'codex', 'claude', 'devin', 'gemini', 'opencode', 'aider'] as AgentType[])
        .map(t => ({ name: t, type: t }));
  for (const agent of agents) {
    try {
      const probe = await getAdapter(String(agent.type), agent).detect(agent);
      checks.push({
        name: `agent:${agent.name}`,
        ok: probe.available,
        detail: probe.available ? `available${probe.version ? ` (${probe.version})` : ''}` : `missing — ${probe.error ?? 'not found'}`
      });
    } catch (e) {
      checks.push({ name: `agent:${agent.name}`, ok: false, detail: String(e) });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }
  for (const c of checks) {
    const mark = c.ok ? chalk.green('✓') : chalk.red('✗');
    console.log(`${mark} ${c.name.padEnd(18)} ${c.detail}`);
  }
  const bad = checks.filter(c => !c.ok);
  if (bad.length > 0) process.exitCode = 1;
}

export function cmdMigrate(): void {
  const cfg = new ConfigManager();
  const result = cfg.migrateOnDisk();
  if (!result) {
    if (existsSync(join(process.cwd(), CONFIG_FILE))) {
      console.log(`${CONFIG_FILE} already exists — nothing to migrate.`);
    } else {
      console.log('No legacy qwen-loop.config.json found — nothing to migrate.');
    }
    return;
  }
  console.log(chalk.green(`Migrated to ${result.configPath}`));
  console.log(`Legacy config backed up at ${result.backupPath}`);
  console.log('Note: loop mechanics moved to agentloop.policy.json; auto-push is now gated by policy.');
}
