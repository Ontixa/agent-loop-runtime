import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { MissionStore, CorruptStateError } from '../mission/mission-store.js';
import { isTerminal } from '../mission/state-machine.js';
import { boundTail } from '../util/redact.js';
import { buildReceipt, MissionReceipt } from '../mission/receipt.js';
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
  const corrupt = store.listCorrupt();

  if (opts.json) {
    console.log(JSON.stringify({
      missions: missions.map(summarize),
      corrupt
    }, null, 2));
    return;
  }
  if (missions.length === 0 && corrupt.length === 0) {
    console.log('No missions. Create one with `agentloop run "<objective>" --criteria "..."`.');
    return;
  }
  for (const m of missions) {
    console.log(`${chalk.cyan(m.id)}  ${stateColor(m.state).padEnd(24)}  ${String(m.agent.type).padEnd(9)}  ${m.spec.objective.slice(0, 60)}`);
  }
  // Corrupt records are surfaced, never silently dropped.
  for (const c of corrupt) {
    console.log(`${chalk.cyan(c.id)}  ${chalk.red('corrupt').padEnd(24)}  ${chalk.gray(`mission.json unparseable — inspect .agentloop/missions/${c.id}/`)}`);
  }
}

export function cmdStatus(id: string, opts: { json?: boolean; repo?: string }): void {
  const store = new MissionStore(opts.repo ?? process.cwd());
  let m: Mission;
  try {
    m = store.mustLoad(id);
  } catch (err) {
    if (err instanceof CorruptStateError) {
      console.error(chalk.red(`Mission ${id} record is corrupt — the file is preserved for inspection:`));
      console.error(`  ${join(store.dir(id), 'mission.json')}`);
      console.error(`  error: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  if (opts.json) {
    console.log(JSON.stringify({
      ...summarize(m), tasks: m.tasks, passes: m.passes,
      runner: m.runner ?? null, workspace: m.workspace,
      stateHistory: m.stateHistory
    }, null, 2));
    return;
  }
  console.log(`${chalk.bold('Mission')} ${m.id}  ${chalk.gray(`rev ${m.revision ?? 0}`)}`);
  console.log(`  state:      ${stateColor(m.state)}`);
  console.log(`  objective:  ${m.spec.objective}`);
  console.log(`  agent:      ${m.agent.name} (${m.agent.type})`);
  console.log(`  repo:       ${m.repository.path} @ ${m.repository.baseSha.slice(0, 8)}`);
  console.log(`  workspace:  ${m.workspace.path ?? '(none)'} [${m.workspace.mode}]`);
  console.log(`  policy:     ${m.policyHash ?? '(none)'}`);
  console.log(`  usage:      ${m.usage.agentInvocations} agent call(s), ${m.usage.repairPasses} repair pass(es)` +
    (m.usage.approvalWaitMs ? `, ${(m.usage.approvalWaitMs / 1000).toFixed(0)}s approval wait` : ''));
  if (m.runner) {
    console.log(`  runner:     pid ${m.runner.pid} nonce ${m.runner.nonce.slice(0, 8)} hb#${m.runner.hbSeq ?? 0} @ ${m.runner.heartbeatAt}`);
  }
  if (m.lastRecovery) {
    const r = m.lastRecovery;
    console.log(chalk.yellow(`  recovery:   ${r.at} from=${r.from} interruptedTasks=${r.interruptedTasks.length} interruptedPasses=${r.interruptedPasses.length} orphansKilled=${r.orphanedPids.length} worktreeRecreated=${r.worktreeRecreated}${r.lostWorkSuspected ? ' LOST-WORK-SUSPECTED' : ''}`));
  }
  if (m.tasks.length > 0) {
    console.log('  tasks:');
    for (const t of m.tasks) {
      const flag = t.interrupted ? chalk.yellow(' ⚠interrupted') : '';
      console.log(`    [${t.status.padEnd(9)}] ${t.title}${flag}`);
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

/**
 * `agentloop report <mission>` — machine-readable mission report (the full
 * receipt) or a concise human-readable rendering of the same data. Never
 * trusts agent self-reports: everything shown comes from persisted state,
 * gate results, and the event log.
 */
export function cmdReport(id: string, opts: { json?: boolean; repo?: string }): void {
  const store = new MissionStore(opts.repo ?? process.cwd());
  const m = store.mustLoad(id);
  const receipt: MissionReceipt = buildReceipt(m);

  if (opts.json) {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }

  console.log(chalk.bold(`Mission report ${m.id}`));
  console.log(`  state:      ${stateColor(m.state)}  (revision ${m.revision ?? 0}, policy ${m.policyHash ?? 'n/a'})`);
  console.log(`  objective:  ${m.spec.objective}`);
  console.log(`  agent:      ${m.agent.name} (${m.agent.type})`);
  console.log(`  repo:       ${m.repository.path} @ ${m.repository.baseSha.slice(0, 10)} → ${receipt.repository.finalSha?.slice(0, 10) ?? '—'}`);
  console.log(`  usage:      ${m.usage.agentInvocations} agent call(s), ${m.usage.repairPasses} repair pass(es), wall ${(m.usage.wallTimeMs / 60000).toFixed(1)}m` +
    (m.usage.approvalWaitMs ? ` (approval wait ${(m.usage.approvalWaitMs / 60000).toFixed(1)}m)` : ''));

  console.log(chalk.bold('\n  passes:'));
  for (const p of receipt.passes) {
    const flags = [p.interrupted ? 'interrupted' : null, p.agentExit ? `exit=${p.agentExit}` : null].filter(Boolean).join(' ');
    console.log(`    #${p.n} ${p.kind}${flags ? ` [${flags}]` : ''}  checkpoint=${p.checkpointSha?.slice(0, 10) ?? '—'}`);
    for (const g of p.gates ?? []) {
      console.log(`      gate ${g.passed ? chalk.green('✓') : chalk.red('✗')} ${g.name}  exit=${g.exitCode ?? '—'}  ${g.durationMs}ms${g.note ? `  (${g.note})` : ''}`);
    }
    if (p.review) {
      console.log(`      review: ${p.review.verdict}${p.review.findings.length ? ` — ${p.review.findings.length} finding(s)` : ''}`);
    }
  }

  if (receipt.approvals.length > 0) {
    console.log(chalk.bold('\n  approvals:'));
    for (const a of receipt.approvals) {
      console.log(`    ${a.gate}: ${a.status}${a.decidedBy ? ` by ${a.decidedBy}` : ''}${a.decidedAt ? ` @ ${a.decidedAt}` : ''}`);
    }
  }

  if (receipt.lastRecovery) {
    const r = receipt.lastRecovery;
    console.log(chalk.bold('\n  last recovery:'));
    console.log(`    at=${r.at} from=${r.from} interruptedTasks=${r.interruptedTasks.length} interruptedPasses=${r.interruptedPasses.length}`);
    console.log(`    orphanedPids=[${r.orphanedPids.join(', ')}] worktreeRecreated=${r.worktreeRecreated} lostWorkSuspected=${r.lostWorkSuspected}`);
  }

  if (m.outcome) {
    console.log(chalk.bold('\n  outcome:'));
    console.log(`    ${m.outcome.result} — ${m.outcome.summary}`);
    if (m.outcome.receiptPath) console.log(`    receipt: ${m.outcome.receiptPath}`);
  }
}

function summarize(m: Mission) {
  return {
    schemaVersion: 1,
    id: m.id, state: m.state, kind: m.kind,
    revision: m.revision ?? 0,
    policyHash: m.policyHash,
    objective: m.spec.objective.slice(0, 200),
    agent: { type: String(m.agent.type), name: m.agent.name },
    worktree: m.workspace.path, branch: m.workspace.branch,
    usage: m.usage, outcome: m.outcome,
    lastRecovery: m.lastRecovery,
    pendingApprovals: m.approvals.filter(a => a.status === 'pending').length,
    createdAt: m.createdAt, updatedAt: m.updatedAt
  };
}
