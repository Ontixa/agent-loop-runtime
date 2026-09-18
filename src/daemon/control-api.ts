import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { MissionStore } from '../mission/mission-store.js';
import { MissionScheduler } from '../engine/scheduler.js';
import { createMission } from '../engine/mission-factory.js';
import { recoverMission } from '../engine/recovery.js';
import { decideApproval, loadApprovals } from '../policy/approvals.js';
import { isTerminal } from '../mission/state-machine.js';
import { MissionState } from '../types.js';
import type { MissionSpec, AgentConfig, Policy } from '../types.js';
import { logger } from '../logger.js';

/**
 * Local control API — the machine-readable surface for ai-cli-editor and the
 * agentloop CLI.
 *
 * Versioned under /v1. Binds loopback by default; binding elsewhere requires
 * a bearer token. Approvals decided here are written to the same approvals
 * ledger the runner polls — there is no separate "approve as human" path.
 */

export interface ControlApiOptions {
  host?: string;
  port?: number;
  token?: string;
  /** repos the API serves: repoRoot → {store, policy} */
  repos: Map<string, { store: MissionStore; policy: Policy }>;
  scheduler: MissionScheduler;
  version: string;
  startedAt: number;
}

const API_PREFIX = '/v1';
const MAX_BODY = 64 * 1024;

export class ControlApi {
  private server: Server | null = null;

  constructor(private readonly opts: ControlApiOptions) {}

  get url(): string {
    return `http://${this.opts.host ?? '127.0.0.1'}:${this.opts.port ?? 3210}`;
  }

  async start(): Promise<void> {
    const host = this.opts.host ?? '127.0.0.1';
    const port = this.opts.port ?? 3210;
    const nonLoopback = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
    if (nonLoopback && !this.opts.token) {
      throw new Error('Refusing to bind control API beyond loopback without a token (daemon.token or --token)');
    }

    this.server = createServer((req, res) => void this.handle(req, res).catch(err => {
      logger.warn('control api error', { error: err instanceof Error ? err.message : String(err) });
      this.json(res, 500, { error: 'internal error' });
    }));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => resolve()).on('error', reject);
    });
    logger.info(`Control API listening on ${this.url}${nonLoopback ? ' (token auth)' : ''}`);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private json(res: ServerResponse, code: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  }

  private async body(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c: Buffer) => {
        data += c.toString();
        if (data.length > MAX_BODY) { reject(new Error('body too large')); req.destroy(); }
      });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); }
        catch { reject(new Error('invalid JSON body')); }
      });
      req.on('error', reject);
    });
  }

  private authed(req: IncomingMessage): boolean {
    if (!this.opts.token) return true;
    const header = req.headers.authorization ?? '';
    return header === `Bearer ${this.opts.token}`;
  }

  private findMission(id: string): { store: MissionStore; mission: import('../types.js').Mission } | null {
    for (const { store } of this.opts.repos.values()) {
      const m = store.load(id);
      if (m) return { store, mission: m };
    }
    return null;
  }

  /** Public mission summary shape (bounded, no prompts/logs). */
  private summarize(m: import('../types.js').Mission) {
    return {
      id: m.id,
      kind: m.kind,
      state: m.state,
      objective: m.spec.objective.slice(0, 200),
      repo: m.repository.path,
      agent: { type: String(m.agent.type), name: m.agent.name },
      worktree: m.workspace.path,
      branch: m.workspace.branch,
      usage: m.usage,
      pendingApprovals: m.approvals.filter(a => a.status === 'pending').map(a => ({ id: a.id, gate: a.gate, detail: a.detail })),
      checkpoints: m.checkpoints.length,
      outcome: m.outcome,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt
    };
  }

  // ── router ─────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (!this.authed(req)) {
      return this.json(res, 401, { error: 'unauthorized' });
    }

    const url = new URL(req.url ?? '/', this.url);
    const path = url.pathname;
    const parts = path.split('/').filter(Boolean); // ['v1', 'missions', ':id', ...]

    if (path === `${API_PREFIX}/status` && req.method === 'GET') {
      return this.json(res, 200, {
        status: 'ok',
        version: this.opts.version,
        uptimeMs: Date.now() - this.opts.startedAt,
        scheduler: this.opts.scheduler.status(),
        repos: [...this.opts.repos.keys()]
      });
    }

    if (path === `${API_PREFIX}/missions` && req.method === 'GET') {
      const missions = [...this.opts.repos.values()]
        .flatMap(r => r.store.list())
        .map(m => this.summarize(m));
      return this.json(res, 200, { missions });
    }

    if (path === `${API_PREFIX}/missions` && req.method === 'POST') {
      const body = await this.body(req) as Record<string, unknown>;
      const repo = typeof body.repo === 'string' ? body.repo : [...this.opts.repos.keys()][0];
      const entry = this.opts.repos.get(repo);
      if (!entry) return this.json(res, 404, { error: `unknown repo: ${repo}` });

      const spec = body.spec as MissionSpec | undefined;
      if (!spec?.objective || !spec?.acceptanceCriteria?.length) {
        return this.json(res, 400, { error: 'spec.objective and spec.acceptanceCriteria[] are required' });
      }
      const agent = (body.agent as AgentConfig) ?? { name: 'default', type: 'qwen' };
      const mission = createMission({
        repoPath: repo,
        spec,
        agent: agent as AgentConfig,
        policy: entry.policy,
        kind: body.kind === 'maintenance' ? 'maintenance' : 'objective',
        workspaceMode: body.inPlace ? 'in-place' : 'worktree'
      }, entry.store);
      this.opts.scheduler.enqueue(repo, mission.id, typeof body.priority === 'number' ? body.priority : 100);
      return this.json(res, 201, { mission: this.summarize(mission) });
    }

    // /v1/missions/:id[/action]
    if (parts[0] === 'v1' && parts[1] === 'missions' && parts[2]) {
      const id = parts[2];
      const found = this.findMission(id);
      if (!found) return this.json(res, 404, { error: `mission not found: ${id}` });
      const { store, mission } = found;
      const action = parts[3];

      if (!action && req.method === 'GET') {
        return this.json(res, 200, { mission: this.summarize(mission), tasks: mission.tasks });
      }

      if (action === 'events' && req.method === 'GET') {
        return this.json(res, 200, { events: store.events(id) });
      }

      if (action === 'pause' && req.method === 'POST') {
        if (!this.opts.scheduler.pause(id)) {
          // Not running under this scheduler — pause via state transition
          if (mission.state === MissionState.RUNNING || mission.state === MissionState.VALIDATING || mission.state === MissionState.REPAIRING) {
            store.transition(mission, MissionState.PAUSED, 'paused via control api');
          }
        }
        return this.json(res, 200, { mission: this.summarize(store.mustLoad(id)) });
      }

      if (action === 'resume' && req.method === 'POST') {
        const recovered = await recoverMission(store, id);
        this.opts.scheduler.enqueue(store.repoRoot, id);
        return this.json(res, 200, { mission: this.summarize(recovered) });
      }

      if (action === 'cancel' && req.method === 'POST') {
        if (!this.opts.scheduler.cancel(id) && !isTerminal(mission.state)) {
          store.transition(mission, MissionState.CANCELLED, 'cancelled via control api');
        }
        return this.json(res, 200, { mission: this.summarize(store.mustLoad(id)) });
      }

      if (action === 'approvals' && req.method === 'GET') {
        return this.json(res, 200, { approvals: loadApprovals(store.dir(id)) });
      }

      if (action === 'approvals' && parts[4] && req.method === 'POST') {
        const body = await this.body(req) as { decision?: string; by?: string };
        const decision = body.decision === 'denied' ? 'denied' : 'approved';
        const updated = decideApproval(store.dir(id), id, parts[4], decision, body.by ?? 'control-api');
        if (!updated) return this.json(res, 409, { error: 'approval not pending or not found' });
        store.emit(id, 'approval_decided', { gate: updated.gate, status: decision, by: body.by ?? 'control-api' });
        return this.json(res, 200, { approval: updated });
      }
    }

    this.json(res, 404, { error: `not found: ${req.method} ${path}` });
  }
}
