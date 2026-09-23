import chalk from 'chalk';
import { join } from 'path';
import { ConfigManager, CONFIG_FILE } from '../config/config-manager.js';
import { loadPolicy } from '../policy/policy.js';
import {
  listPresets, resolvePresetMission, PresetError, type PresetEntry
} from '../engine/mission-presets.js';

/**
 * `agentloop presets [name]` — list available mission presets or inspect one
 * in detail: effective scope, command envelope, budgets and approval posture
 * after the restrictive merge against this repo's policy.
 */

function summarize(entry: PresetEntry) {
  const p = entry.preset;
  return {
    name: entry.name,
    source: entry.source,
    description: p.description ?? '',
    scopePaths: p.scope?.length ?? 0,
    requiredGates: p.requiredGates ?? [],
    commands: p.allowedCommands?.length ?? 0,
    planning: p.planning === true,
    budget: p.budget ?? {}
  };
}

export function cmdPresets(name: string | undefined, opts: { json?: boolean; repo?: string }): void {
  const repoPath = opts.repo ?? process.cwd();
  const config = new ConfigManager(join(repoPath, CONFIG_FILE)).getConfig();
  const entries = listPresets(config);

  if (!name) {
    if (opts.json) {
      console.log(JSON.stringify({ presets: entries.map(summarize) }, null, 2));
      return;
    }
    console.log(chalk.bold('Mission presets') + chalk.gray('  (agentloop run "<objective>" --preset <name>)'));
    for (const e of entries) {
      const s = summarize(e);
      console.log(`  ${chalk.cyan(e.name.padEnd(16))} ${chalk.gray(e.source.padEnd(7))} scope=${s.scopePaths} cmd=${s.commands} gates=[${s.requiredGates.join(',')}]${s.planning ? ' plans' : ''}`);
      if (s.description) console.log(`    ${s.description}`);
    }
    console.log(chalk.gray('Inspect one: agentloop presets <name>'));
    return;
  }

  const entry = entries.find(e => e.name === name);
  if (!entry) {
    console.error(chalk.red(`Unknown preset '${name}'. Available: ${entries.map(e => e.name).join(', ') || '(none)'}`));
    process.exitCode = 2;
    return;
  }

  // Show the effective shape after the restrictive merge with this repo's
  // policy — that is what the mission snapshot would actually carry.
  const { policy: repoPolicy } = loadPolicy(repoPath);
  let resolved;
  try {
    resolved = resolvePresetMission({ name, config, policy: repoPolicy });
  } catch (err) {
    if (err instanceof PresetError) {
      // Malformed preset or missing required gates — show the raw preset plus
      // the resolution failure rather than hiding it.
      if (opts.json) {
        console.log(JSON.stringify({ ...summarize(entry), error: err.message }, null, 2));
      } else {
        console.log(`${chalk.cyan(entry.name)} ${chalk.gray(`(${entry.source})`)} — ${chalk.red('unresolvable here')}`);
        console.error(chalk.red(`  ${err.message}`));
      }
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  if (opts.json) {
    console.log(JSON.stringify({
      ...summarize(entry),
      spec: resolved.spec,
      effectivePolicy: resolved.policy,
      planning: resolved.planning,
      tasks: resolved.tasks.map(t => t.title),
      warnings: resolved.warnings
    }, null, 2));
    return;
  }

  const p = resolved.policy;
  console.log(chalk.bold(`Preset ${entry.name}`) + chalk.gray(` (${entry.source})`));
  if (entry.preset.description) console.log(`  ${entry.preset.description}`);
  console.log(`  objective:    ${resolved.spec.objective}`);
  console.log(`  planning:     ${resolved.planning ? 'agent planner' : 'deterministic task list'}`);
  console.log(`  scope (${resolved.spec.scope?.length ?? 0}):`);
  for (const s of resolved.spec.scope ?? []) console.log(`    ${s}`);
  console.log(`  required gates: ${(resolved.spec.verificationCommands ?? []).join(', ') || '(all configured)'}`);
  console.log(`  command envelope (${p.allowedCommands.length}):`);
  for (const c of p.allowedCommands) console.log(`    ${c.join(' ')}`);
  console.log('  budgets (min of preset and repo policy):');
  console.log(`    maxMissionMinutes=${p.maxMissionMinutes} maxRepairPasses=${p.maxRepairPasses} ` +
    `maxAgentInvocations=${p.maxAgentInvocations} agentTimeoutMs=${p.agentTimeoutMs}` +
    (p.maxDiffBytes ? ` maxDiffBytes=${p.maxDiffBytes}` : ''));
  console.log('  approval posture:');
  console.log(`    push=${p.allowPush} pullRequest=${p.allowPullRequest} merge=${p.allowMerge} ` +
    `network=${p.allowNetwork} localCommit=${p.allowLocalCommit} approvalTimeoutMs=${p.approvalTimeoutMs}`);
  if (resolved.spec.nonGoals?.length) {
    console.log(`  non-goals: ${resolved.spec.nonGoals.join('; ')}`);
  }
  for (const w of resolved.warnings) console.warn(chalk.yellow(`  warn: ${w}`));
}
