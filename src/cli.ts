#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cmdInit, cmdDoctor, cmdMigrate } from './commands/setup-commands.js';
import { cmdRun, cmdPause, cmdResume, cmdCancel, cmdApprove } from './commands/mission-commands.js';
import { cmdMissions, cmdStatus, cmdLogs, cmdReport } from './commands/inspect-commands.js';
import { collectHealth } from './health/health.js';
import { MissionScheduler } from './engine/scheduler.js';
import { Daemon } from './daemon/daemon.js';
import { McpServer } from './mcp/mcp-server.js';
import { ConfigManager } from './config/config-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const VERSION = packageJson.version;

const program = new Command();

program
  .name('agentloop')
  .description('Agent Loop Runtime — headless, safe, resumable execution for coding agents')
  .version(VERSION);

program
  .command('init')
  .description('Initialize agentloop in this repository (config + policy + .gitignore)')
  .option('--agent <type>', 'Primary agent adapter (qwen|codex|claude|devin|gemini|opencode|aider)', 'qwen')
  .option('--force', 'Overwrite existing config')
  .action((opts) => cmdInit({ agent: opts.agent, force: opts.force }));

program
  .command('doctor')
  .description('Check environment: git, repo, config, policy, agent CLIs')
  .option('--json', 'Machine-readable output')
  .action((opts) => cmdDoctor({ json: opts.json }));

program
  .command('run <objective>')
  .description('Create and run a mission in the foreground')
  .option('-c, --criteria <criterion...>', 'Acceptance criteria (repeatable)')
  .option('-a, --agent <name>', 'Agent name or adapter type')
  .option('-r, --repo <path>', 'Repository path (default: cwd)')
  .option('--in-place', 'Run in working tree instead of isolated worktree')
  .option('--approve-in-place', 'Explicit sign-off required by --in-place')
  .option('--maintenance', 'Bounded maintenance mission')
  .option('--no-plan', 'Skip agent planning, use default single pass')
  .option('--non-goal <goal...>', 'Explicit non-goals (repeatable)')
  .option('--max-minutes <n>', 'Mission wall-time budget override')
  .action((objective, opts) => cmdRun(objective, {
    criteria: opts.criteria, agent: opts.agent, repo: opts.repo,
    inPlace: opts.inPlace, approveInPlace: opts.approveInPlace,
    maintenance: opts.maintenance, plan: opts.plan, nonGoal: opts.nonGoal,
    maxMinutes: opts.maxMinutes ? Number(opts.maxMinutes) : undefined
  }));

program
  .command('missions')
  .description('List active missions (add --all for history)')
  .option('--all', 'Include completed/failed/cancelled')
  .option('--json', 'Machine-readable output')
  .option('-r, --repo <path>', 'Repository path')
  .action((opts) => cmdMissions({ json: opts.json, repo: opts.repo, all: opts.all }));

program
  .command('status <missionId>')
  .description('Inspect a mission: state, tasks, approvals, outcome')
  .option('--json', 'Machine-readable output')
  .option('-r, --repo <path>', 'Repository path')
  .action((id, opts) => cmdStatus(id, { json: opts.json, repo: opts.repo }));

program
  .command('logs <missionId>')
  .description('Show mission events and latest agent log tail')
  .option('--no-events', 'Skip events.jsonl')
  .option('-n, --tail <lines>', 'Lines to tail', '50')
  .option('-r, --repo <path>', 'Repository path')
  .action((id, opts) => cmdLogs(id, { events: opts.events, tail: opts.tail, repo: opts.repo }));

program
  .command('report <missionId>')
  .description('Mission report: validation by pass, agent exits, approvals, recovery audit, outcome')
  .option('--json', 'Machine-readable (full receipt object)')
  .option('-r, --repo <path>', 'Repository path')
  .action((id, opts) => cmdReport(id, { json: opts.json, repo: opts.repo }));

program
  .command('pause <missionId>')
  .description('Pause a mission (checkpoints at next step boundary)')
  .option('-r, --repo <path>', 'Repository path')
  .action((id, opts) => cmdPause(id, opts.repo));

program
  .command('resume <missionId>')
  .description('Recover and resume a paused/stale/interrupted mission')
  .option('-r, --repo <path>', 'Repository path')
  .action((id, opts) => cmdResume(id, opts.repo));

program
  .command('cancel <missionId>')
  .description('Cancel a mission permanently')
  .option('-r, --repo <path>', 'Repository path')
  .action((id, opts) => cmdCancel(id, opts.repo));

program
  .command('approve <missionId> <approvalId>')
  .description('Approve a pending gate (push, dangerous command, scope expansion)')
  .option('--deny', 'Deny instead of approve')
  .option('--by <name>', 'Approver identity for the audit record', 'cli')
  .option('-r, --repo <path>', 'Repository path')
  .action((id, approvalId, opts) => cmdApprove(id, approvalId, { deny: opts.deny, by: opts.by, repo: opts.repo }));

program
  .command('health')
  .description('Mission-aware health report')
  .option('--json', 'Machine-readable output')
  .option('-r, --repo <path...>', 'Repository paths (default: cwd)')
  .action(async (opts) => {
    const cfg = new ConfigManager();
    const report = await collectHealth({
      repos: opts.repo ?? [process.cwd()],
      agents: cfg.getConfig().agents,
      version: VERSION
    });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`status: ${report.status}`);
      for (const r of report.repos) {
        console.log(`  ${r.path}: git=${r.git.ok ? 'ok' : r.git.error} missions=${r.missions.total} stale=${r.missions.stale} approvals=${r.missions.blockedApprovals}`);
      }
      for (const a of report.agents) console.log(`  agent ${a.name}(${a.type}): ${a.available ? 'ok' : `missing — ${a.error}`}`);
      for (const w of report.warnings) console.log(`  warn: ${w}`);
      for (const e of report.errors) console.log(`  err:  ${e}`);
    }
    if (report.status === 'error') process.exitCode = 1;
  });

program
  .command('daemon')
  .description('Run the long-lived scheduler + loopback control API')
  .option('-r, --repo <path...>', 'Repositories to serve (default: cwd)')
  .option('--port <n>', 'Control API port')
  .option('--host <h>', 'Control API bind host (default 127.0.0.1)')
  .option('--token <t>', 'Bearer token (required for non-loopback bind)')
  .action(async (opts) => {
    const cfg = new ConfigManager();
    const dc = cfg.getConfig().daemon ?? {};
    const scheduler = new MissionScheduler({});
    const daemon = new Daemon({
      repos: opts.repo ?? [process.cwd()],
      config: {
        port: opts.port ? Number(opts.port) : dc.port,
        host: opts.host ?? dc.host,
        token: opts.token ?? dc.token
      },
      scheduler,
      version: VERSION
    });
    await daemon.start();
    await new Promise(() => {}); // run until signal
  });

program
  .command('mcp')
  .description('Start the MCP control surface over stdio')
  .option('-r, --repo <path...>', 'Repositories to serve (default: cwd)')
  .action((opts) => {
    const server = new McpServer(opts.repo ?? [process.cwd()], VERSION);
    server.start();
  });

program
  .command('migrate')
  .description('Migrate qwen-loop.config.json to agentloop.config.json (backup kept)')
  .action(() => cmdMigrate());

program.parse(process.argv);
