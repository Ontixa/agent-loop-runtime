import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { MissionStore } from '../mission/mission-store.js';
import { isTerminal } from '../mission/state-machine.js';
import { boundTail } from '../util/redact.js';
import type { Mission } from '../types.js';

/**
 * Inspection commands: missions, status, logs.
 */

function stateColor(state: string): string {
  switch (state) {
    case 'completed': return chalk.green(state);
    case 'failed': case 'cancelled': return chalk.red(state);
    case 'running': case 'validating': case 'repairing': return chalk.cyan(state);
    case 'blocked': case 'stale': case 'waiting_for_approval': return chalk.yellow(state);
    default: return state;
  }
}

export function cmdMissions(opts: { json?: boolean; repo?: string; all?: boolean }): void {
  const store = new MissionStore(opts.repo ?? process.cwd());
  let missions = store.list().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!opts.all) missions = missions.filter(m => !isTerminal(m.state));

  if (opts.json) {
    console.log(JSON.stringify(missions.map(summarize), null, 2));
    return;
  }
  if (missions.length === 0) {
    console.log('No missions. Create one with `agentloop run "<objective>" --criteria "..."`.');
    return;
  }
  for (const m of missions) {
    console.log(`${chalk.cyan(m.id)}  ${stateColor(m.state).padEnd(24)}  ${String(m.agent.type).padEnd(9)}  ${m.spec.objective.slice(0, 60)}`);
  }
}

export function cmdStatus(id: string, opts: { json?: boolean; repo?: string }): void {
  const store = new MissionStore(opts.repo ?? process.cwd());
  const m = store.mustLoad(id);
  if (opts.json) {
    console.log(JSON.stringify({ ...summarize(m), tasks: m.tasks, stateHistory: m.stateHistory }, null, 2));
    return;
  }
  console.log(`${chalk.bold('Mission')} ${m.id}`);
  console.log(`  state:      ${stateColor(m.state)}`);
  console.log(`  objective:  ${m.spec.objective}`);
  console.log(`  agent:      ${m.agent.name} (${m.agent.type})`);
  console.log(`  repo:       ${m.repository.path} @ ${m.repository.baseSha.slice(0, 8)}`);
  console.log(`  workspace:  ${m.workspace.path ?? '(none)'} [${m.workspace.mode}]`);
  console.log(`  usage:      ${m.usage.agentInvocations} agent call(s), ${m.usage.repairPasses} repair pass(es)`);
  if (m.tasks.length > 0) {
    console.log('  tasks:');
    for (const t of m.tasks) {
      console.log(`    [${t.status.padEnd(9)}] ${t.title}`);
    }
  }
  const pending = m.approvals.filter(a => a.status === 'pending');
  if (pending.length > 0) {
    console.log(chalk.yellow('  pending approvals:'));
    for (const a of pending) console.log(`    ${a.id}  ${a.gate}: ${a.detail}`);
  }
  if (m.outcome) {
    console.log(`  outcome:    ${m.outcome.result}${m.outcome.summary ? ` — ${m.outcome.summary}` : ''}`);
  }
}

export function cmdLogs(id: string, opts: { repo?: string; events?: boolean; tail?: string }): void {
  const store = new MissionStore(opts.repo ?? process.cwd());
  const m = store.mustLoad(id);
  const dir = store.dir(id);
  const tailN = Number(opts.tail ?? 50);

  if (opts.events !== false) {
    const eventsPath = join(dir, 'events.jsonl');
    if (existsSync(eventsPath)) {
      const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).slice(-tailN);
      console.log(chalk.bold('events:'));
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          console.log(`  ${e.at ?? ''}  ${chalk.cyan(e.type)}  ${JSON.stringify(e.data ?? {}).slice(0, 120)}`);
        } catch { console.log(`  ${line.slice(0, 140)}`); }
      }
    }
  }

  // Agent invocation logs
  const logDir = join(dir, 'logs');
  if (existsSync(logDir)) {
    const files = readdirSync(logDir).filter(f => f.endsWith('.log')).sort();
    const last = files.at(-1);
    if (last) {
      console.log(chalk.bold(`\nagent log (${last}, last ${tailN} lines):`));
      const content = readFileSync(join(logDir, last), 'utf8');
      for (const line of boundTail(content, tailN * 200).text.split('\n').slice(-tailN)) {
        console.log(`  ${line}`);
      }
    }
  }
}

function summarize(m: Mission) {
  return {
    id: m.id, state: m.state, kind: m.kind,
    objective: m.spec.objective.slice(0, 200),
    agent: { type: String(m.agent.type), name: m.agent.name },
    worktree: m.workspace.path, branch: m.workspace.branch,
    usage: m.usage, outcome: m.outcome,
    pendingApprovals: m.approvals.filter(a => a.status === 'pending').length,
    createdAt: m.createdAt, updatedAt: m.updatedAt
  };
}
