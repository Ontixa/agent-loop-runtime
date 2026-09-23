import { createInterface } from 'readline';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { MissionStore, CorruptStateError } from '../mission/mission-store.js';
import { createMission } from '../engine/mission-factory.js';
import { recoverMission, pidAlive } from '../engine/recovery.js';
import { loadApprovals } from '../policy/approvals.js';
import { isTerminal } from '../mission/state-machine.js';
import { MissionState } from '../types.js';
import type { MissionSpec, AgentConfig, Policy } from '../types.js';
import { loadPolicy } from '../policy/policy.js';
import { logger } from '../logger.js';

/**
 * MCP control surface — exposes mission operations to MCP clients (e.g.
 * ai-cli-editor) over stdio JSON-RPC (MCP protocol, newline-delimited).
 *
 * Deliberately exposes NO tool that approves a gate — a machine client must
 * never stand in for a human. Approvals are listed read-only; the human
 * decides via `agentloop approve` or the authenticated control API.
 */

const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'create_mission',
    description: 'Create a new mission in a repository. Returns the mission id and summary.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository path (defaults to cwd)' },
        objective: { type: 'string' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        agent: { type: 'object', description: 'AgentConfig {name,type,...}' },
        nonGoals: { type: 'array', items: { type: 'string' } }
      },
      required: ['objective', 'acceptanceCriteria']
    }
  },
  {
    name: 'list_missions',
    description: 'List missions with state, agent, and outcome summary.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } } }
  },
  {
    name: 'inspect_mission',
    description: 'Get full detail for one mission including tasks and pending approvals.',
    inputSchema: {
      type: 'object',
      properties: { missionId: { type: 'string' }, repo: { type: 'string' } },
      required: ['missionId']
    }
  },
  {
    name: 'pause_mission',
    description: 'Pause a running mission. It checkpoints and can be resumed later.',
    inputSchema: {
      type: 'object',
      properties: { missionId: { type: 'string' }, repo: { type: 'string' } },
      required: ['missionId']
    }
  },
  {
    name: 'cancel_mission',
    description: 'Cancel a mission permanently.',
    inputSchema: {
      type: 'object',
      properties: { missionId: { type: 'string' }, repo: { type: 'string' } },
      required: ['missionId']
    }
  },
  {
    name: 'resume_mission',
    description:
      'Recover and resume a paused/stale/blocked/waiting mission. If a daemon is running, ' +
      'hands the mission to it; otherwise re-prepares the record so `agentloop resume` or the ' +
      'next daemon start can drive it. Never resumes a mission whose approvals are undecided ' +
      'into running — waiting_for_approval re-enters its wait.',
    inputSchema: {
      type: 'object',
      properties: { missionId: { type: 'string' }, repo: { type: 'string' } },
      required: ['missionId']
    }
  },
  {
    name: 'list_pending_approvals',
    description: 'List pending approval gates (read-only — approvals are decided by humans).',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } } }
  }
] as const;

export class McpServer {
  private stores = new Map<string, MissionStore>();
  private policies = new Map<string, Policy>();

  constructor(private readonly repos: string[], private readonly version: string) {
    for (const repo of repos) {
      this.stores.set(repo, new MissionStore(repo));
      this.policies.set(repo, loadPolicy(repo).policy);
    }
  }

  private storeFor(repo?: string): MissionStore {
    const key = repo ?? this.repos[0];
    const store = this.stores.get(key);
    if (!store) throw new Error(`unknown repo: ${key}`);
    return store;
  }

  private findMission(id: string, repo?: string) {
    const tryLoad = (store: MissionStore) => {
      try { return store.load(id); }
      catch (err) {
        if (err instanceof CorruptStateError) throw new Error(`mission ${id} state is corrupt — inspect .agentloop/missions/${id}/mission.json`);
        throw err;
      }
    };
    if (repo) {
      const store = this.stores.get(repo);
      if (!store) throw new Error(`unknown repo: ${repo}`);
      const m = tryLoad(store);
      if (!m) throw new Error(`mission not found: ${id}`);
      return { store, mission: m };
    }
    for (const store of this.stores.values()) {
      const m = tryLoad(store);
      if (m) return { store, mission: m };
    }
    throw new Error(`mission not found: ${id}`);
  }

  start(): void {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', line => {
      if (!line.trim()) return;
      let req: JsonRpcRequest;
      try { req = JSON.parse(line); } catch { return; }
      void this.dispatch(req);
    });
    rl.on('close', () => process.exit(0));
    logger.info(`MCP server started (${this.repos.length} repo(s))`);
  }

  private respond(id: string | number | undefined, result: unknown): void {
    if (id === undefined) return; // notification — no response
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private respondError(id: string | number | undefined, code: number, message: string): void {
    if (id === undefined) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  }

  private async dispatch(req: JsonRpcRequest): Promise<void> {
    try {
      switch (req.method) {
        case 'initialize':
          return this.respond(req.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'agentloop', version: this.version }
          });

        case 'notifications/initialized':
        case 'ping':
          return this.respond(req.id, {});

        case 'tools/list':
          return this.respond(req.id, { tools: TOOLS });

        case 'tools/call': {
          const params = req.params ?? {};
          const name = String(params.name ?? '');
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const result = await this.callTool(name, args);
          return this.respond(req.id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          });
        }

        default:
          return this.respondError(req.id, -32601, `method not found: ${req.method}`);
      }
    } catch (err) {
      return this.respondError(req.id, -32603, err instanceof Error ? err.message : String(err));
    }
  }

  private summarize(m: import('../types.js').Mission) {
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
      pendingApprovals: m.approvals.filter(a => a.status === 'pending')
        .map(a => ({
          id: a.id, gate: a.gate, detail: a.detail,
          // The exact expansion under decision — what approval would grant.
          ...(a.paths ? { paths: a.paths } : {}),
          ...(a.commands ? { commands: a.commands } : {})
        })),
      createdAt: m.createdAt, updatedAt: m.updatedAt
    };
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'create_mission': {
        const repo = typeof args.repo === 'string' ? args.repo : this.repos[0];
        const store = this.storeFor(repo);
        const policy = this.policies.get(repo)!;
        const spec: MissionSpec = {
          objective: String(args.objective ?? ''),
          acceptanceCriteria: Array.isArray(args.acceptanceCriteria)
            ? (args.acceptanceCriteria as string[]) : [],
          nonGoals: Array.isArray(args.nonGoals) ? args.nonGoals as string[] : undefined
        };
        if (!spec.objective || spec.acceptanceCriteria.length === 0) {
          throw new Error('objective and acceptanceCriteria[] are required');
        }
        const agent = (args.agent as AgentConfig) ?? { name: 'default', type: 'qwen' };
        const mission = createMission({ repoPath: repo, spec, agent, policy }, store);
        return { mission: this.summarize(mission) };
      }

      case 'list_missions': {
        const store = this.storeFor(args.repo as string | undefined);
        return { missions: store.list().map(m => this.summarize(m)) };
      }

      case 'inspect_mission': {
        const { mission } = this.findMission(String(args.missionId), args.repo as string | undefined);
        return { mission: this.summarize(mission), tasks: mission.tasks, stateHistory: mission.stateHistory };
      }

      case 'pause_mission': {
        const { store, mission } = this.findMission(String(args.missionId), args.repo as string | undefined);
        if (isTerminal(mission.state)) throw new Error(`mission is ${mission.state}`);
        if (mission.state === MissionState.RUNNING || mission.state === MissionState.VALIDATING ||
            mission.state === MissionState.REPAIRING || mission.state === MissionState.PREPARED) {
          store.transition(mission, MissionState.PAUSED, 'paused via MCP');
        }
        return { mission: this.summarize(store.mustLoad(mission.id)) };
      }

      case 'cancel_mission': {
        const { store, mission } = this.findMission(String(args.missionId), args.repo as string | undefined);
        if (!isTerminal(mission.state)) {
          store.transition(mission, MissionState.CANCELLED, 'cancelled via MCP');
        }
        return { mission: this.summarize(store.mustLoad(mission.id)) };
      }

      case 'resume_mission': {
        const { store, mission } = this.findMission(String(args.missionId), args.repo as string | undefined);
        if (isTerminal(mission.state)) {
          throw new Error(`mission is ${mission.state} — terminal, cannot resume`);
        }

        // Prefer the running daemon: it owns a live scheduler that can drive
        // the mission immediately. daemon.json carries the API token.
        const daemonFile = join(store.repoRoot, '.agentloop', 'daemon.json');
        const daemon = existsSync(daemonFile)
          ? (JSON.parse(readFileSync(daemonFile, 'utf-8')) as { pid?: number; url?: string; token?: string })
          : null;
        if (daemon?.pid && daemon.url && daemon.token && pidAlive(daemon.pid)) {
          const res = await fetch(`${daemon.url}/v1/missions/${mission.id}/resume`, {
            method: 'POST',
            headers: { authorization: `Bearer ${daemon.token}` }
          });
          const body = await res.json() as { mission?: unknown; error?: string };
          if (!res.ok) throw new Error(`daemon resume failed: ${body.error ?? res.status}`);
          return { mission: body.mission, via: 'daemon' };
        }

        // No live daemon — recover the record to PREPARED and report honestly:
        // nothing will drive it until `agentloop resume` or a daemon start.
        const recovered = await recoverMission(store, mission.id);
        return {
          mission: this.summarize(recovered),
          via: 'local',
          note: 'no running daemon — mission is prepared; drive it with `agentloop resume` or start `agentloop daemon`'
        };
      }

      case 'list_pending_approvals': {
        const store = this.storeFor(args.repo as string | undefined);
        // Read the authoritative ledger files, not the mission mirror.
        const pending = store.list()
          .flatMap(m => loadApprovals(store.dir(m.id))
            .filter(a => a.status === 'pending')
            .map(a => ({ missionId: m.id, ...a })));
        return { pendingApprovals: pending };
      }

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }
}
