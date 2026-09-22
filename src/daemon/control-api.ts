import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { join } from 'path';
import { MissionStore } from '../mission/mission-store.js';
import { MissionScheduler } from '../engine/scheduler.js';
import { createMission } from '../engine/mission-factory.js';
import { recoverMission } from '../engine/recovery.js';
import { decideApproval, loadApprovals } from '../policy/approvals.js';
import { isTerminal } from '../mission/state-machine.js';
import { MissionState } from '../types.js';
import type { MissionSpec, AgentConfig, Policy } from '../types.js';
import { MissionEventFollower, resolveFollowLimits } from './event-follow.js';
import type { FollowLimits } from './event-follow.js';
import { logger } from '../logger.js';

/**
 * Local control API — the machine-readable surface for ai-cli-editor and the
 * agentloop CLI.
 *
 * Versioned under /v1. Binds loopback by default; binding elsewhere requires
 * a bearer token. Approvals decided here are written to the same approvals
 * ledger the runner polls — there is no separate "approve as human" path.
 *
 * Security posture (honest — see docs/threat-model.md):
 * - EVERY request requires a bearer token. If the operator doesn't configure
 *   one, the daemon generates an ephemeral token at startup and stores it in
 *   .agentloop/daemon.json for local tooling. This stops network/browser
 *   attackers; it is NOT a boundary against a local agent running as the
 *   same OS user (documented advisory limit).
 * - Host header must match the bound host — rejects DNS-rebinding probes.
 * - No CORS headers are emitted unless daemon.corsOrigins lists the Origin.
 * - Responses carry schemaVersion/revision/timestamps; never secrets.
 * - Events are paginated via ?after=<seq>&limit=<n>, or tailed live with
 *   ?follow (NDJSON; see daemon/event-follow.ts for the line contract).
 */

export interface ControlApiOptions {
  host?: string;
  port?: number;
  token?: string;
  /** Allowed CORS origins (exact match on Origin header). Default: none. */
  corsOrigins?: string[];
  /** Bounds for ?follow event streams. Defaults in event-follow.ts. */
  follow?: FollowLimits;
  /** Max concurrent ?follow streams. Default 32. */
  maxFollowers?: number;
  /** repos the API serves: repoRoot → {store, policy} */
  repos: Map<string, { store: MissionStore; policy: Policy }>;
  scheduler: MissionScheduler;
  version: string;
  startedAt: number;
}

const API_PREFIX = '/v1';
const API_SCHEMA = 1;
const MAX_BODY = 64 * 1024;
const MAX_EVENTS_PER_PAGE = 500;
const MAX_FOLLOWERS_DEFAULT = 32;

export class ControlApi {
  private server: Server | null = null;
  /** Resolved bearer token — always set after start() (generated if needed). */
  private token = '';
  /** Open ?follow streams — bounded by maxFollowers, closed on stop(). */
  private followers = new Set<MissionEventFollower>();

  constructor(private readonly opts: ControlApiOptions) {}

  private get port(): number {
    const address = this.server?.address();
    return address && typeof address !== 'string' ? address.port : this.opts.port ?? 3210;
  }

  private get authorityHost(): string {
    const host = this.opts.host ?? '127.0.0.1';
    return host.includes(':') ? `[${host}]` : host;
  }

  get url(): string {
    return `http://${this.authorityHost}:${this.port}`;
  }

  /** The token callers must present — generated when not configured. */
  get bearerToken(): string { return this.token; }

  async start(): Promise<void> {
    const host = this.opts.host ?? '127.0.0.1';
    const port = this.opts.port ?? 3210;
    const nonLoopback = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
    this.token = this.opts.token || `alr_${randomBytes(24).toString('hex')}`;
    if (nonLoopback && !this.opts.token) {
      throw new Error('Refusing to bind control API beyond loopback without a token (daemon.token or --token)');
    }
    if (!this.opts.token) {
      logger.info('Control API using generated ephemeral token (stored in daemon.json)');
    }

    this.server = createServer((req, res) => void this.handle(req, res).catch(err => {
      logger.warn('control api error', { error: err instanceof Error ? err.message : String(err) });
      // A streaming (?follow) response may already hold the socket — writing a
      // JSON error after headers were sent would throw inside this catch.
      if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
      this.json(res, 500, { error: 'internal error' });
    }));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => resolve()).on('error', reject);
    });
    logger.info(`Control API listening on ${this.url} (bearer auth)`);
  }

  async stop(): Promise<void> {
    // Open follow streams would otherwise keep server.close() waiting.
    for (const f of this.followers) f.end('shutdown');
    this.followers.clear();
    if (!this.server) return;
    // close() alone waits out the keep-alive timeout on idle sockets — drop
    // them so shutdown is prompt (active follow streams were ended above).
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
      this.server!.closeIdleConnections();
    });
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

  /** Constant-time bearer check. A token always exists after start(). */
  private authed(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const given = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /**
   * Host-header check: the request must target the bound host:port. Rejects
   * DNS-rebinding attempts where a browser page at evil.com resolves to
   * 127.0.0.1 — the Host header would be 'evil.com', not ours.
   */
  private hostOk(req: IncomingMessage): boolean {
    const host = req.headers.host ?? '';
    const bound = this.opts.host ?? '127.0.0.1';
    const port = this.port;
    const ok = [`${this.authorityHost}:${port}`, bound, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];
    return ok.includes(host);
  }

  /** Emit CORS headers only for explicitly configured origins. */
  private cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    const allowed = this.opts.corsOrigins ?? [];
    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    }
  }

  private findMission(id: string): { store: MissionStore; mission: import('../types.js').Mission } | null {
    for (const { store } of this.opts.repos.values()) {
      let m;
      try { m = store.load(id); } catch { m = null; } // corrupt → keep searching
      if (m) return { store, mission: m };
    }
    return null;
  }

  /** Public mission summary shape (bounded, no prompts/logs/secrets). */
  private summarize(m: import('../types.js').Mission) {
    return {
      schemaVersion: API_SCHEMA,
      id: m.id,
      kind: m.kind,
      state: m.state,
      revision: m.revision ?? 0,
      policyHash: m.policyHash,
      objective: m.spec.objective.slice(0, 200),
      repo: m.repository.path,
      agent: { type: String(m.agent.type), name: m.agent.name },
      worktree: m.workspace.path,
      workspaceMode: m.workspace.mode,
      branch: m.workspace.branch,
      usage: m.usage,
      pendingApprovals: m.approvals.filter(a => a.status === 'pending').map(a => ({ id: a.id, gate: a.gate, detail: a.detail })),
      checkpoints: m.checkpoints.length,
      lastRecovery: m.lastRecovery,
      outcome: m.outcome,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      at: new Date().toISOString()
    };
  }

  // ── router ─────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (!this.hostOk(req)) {
      return this.json(res, 403, { error: 'host header does not match the bound interface' });
    }
    if (!this.authed(req)) {
      return this.json(res, 401, { error: 'unauthorized: bearer token required' });
    }

    const url = new URL(req.url ?? '/', this.url);
    const path = url.pathname;
    const parts = path.split('/').filter(Boolean); // ['v1', 'missions', ':id', ...]

    if (path === `${API_PREFIX}/status` && req.method === 'GET') {
      return this.json(res, 200, {
        schemaVersion: API_SCHEMA,
        status: 'ok',
        version: this.opts.version,
        uptimeMs: Date.now() - this.opts.startedAt,
        scheduler: this.opts.scheduler.status(),
        repos: [...this.opts.repos.keys()],
        corrupt: [...this.opts.repos.values()].flatMap(r => r.store.listCorrupt()),
        at: new Date().toISOString()
      });
    }

    if (path === `${API_PREFIX}/missions` && req.method === 'GET') {
      const missions = [...this.opts.repos.values()]
        .flatMap(r => r.store.list())
        .map(m => this.summarize(m));
      return this.json(res, 200, { schemaVersion: API_SCHEMA, missions });
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
      if (spec.objective.length > 4096) {
        return this.json(res, 400, { error: 'spec.objective too large' });
      }
      const agent = (body.agent as AgentConfig) ?? { name: 'default', type: 'qwen' };
      try {
        const mission = createMission({
          repoPath: repo,
          spec,
          agent: agent as AgentConfig,
          policy: entry.policy,
          kind: body.kind === 'maintenance' ? 'maintenance' : 'objective',
          workspaceMode: body.inPlace ? 'in-place' : 'worktree',
          // The API enforces the same two-flag rule as the CLI — a remote
          // caller must explicitly assert operator sign-off for in-place work.
          inPlaceApproved: body.inPlaceApproved === true
        }, entry.store);
        this.opts.scheduler.enqueue(repo, mission.id, typeof body.priority === 'number' ? body.priority : 100);
        return this.json(res, 201, { mission: this.summarize(mission) });
      } catch (err) {
        return this.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // /v1/missions/:id[/action]
    if (parts[0] === 'v1' && parts[1] === 'missions' && parts[2]) {
      const id = parts[2];
      const found = this.findMission(id);
      if (!found) return this.json(res, 404, { error: `mission not found: ${id}` });
      const { store, mission } = found;
      const action = parts[3];

      if (!action && req.method === 'GET') {
        return this.json(res, 200, {
          schemaVersion: API_SCHEMA,
          mission: this.summarize(mission),
          tasks: mission.tasks
        });
      }

      if (action === 'events' && req.method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? 0) || 0;
        if (this.wantsFollow(url)) {
          return this.followEvents(res, store, mission, after);
        }
        // Paginated: ?after=<seq> returns events with seq > after; ?limit caps
        // the page. Consumers poll with nextAfter for incremental reads.
        const limit = Math.min(
          Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1),
          MAX_EVENTS_PER_PAGE
        );
        const { events, skippedLines } = store.readEvents(id);
        const page = events.filter(e => (e.seq ?? 0) > after).slice(0, limit);
        const nextAfter = page.length ? (page.at(-1)!.seq ?? after) : after;
        return this.json(res, 200, {
          schemaVersion: API_SCHEMA,
          missionId: id,
          events: page,
          skippedLines,
          nextAfter,
          hasMore: events.some(e => (e.seq ?? 0) > nextAfter)
        });
      }

      if (action === 'pause' && req.method === 'POST') {
        if (!this.opts.scheduler.pause(id)) {
          // Not running under this scheduler — pause via state transition
          if (mission.state === MissionState.RUNNING || mission.state === MissionState.VALIDATING || mission.state === MissionState.REPAIRING) {
            store.transition(mission, MissionState.PAUSED, 'operator pause requested');
          }
        }
        return this.json(res, 200, { mission: this.summarize(store.mustLoad(id)) });
      }

      if (action === 'resume' && req.method === 'POST') {
        try {
          const recovered = await recoverMission(store, id);
          this.opts.scheduler.enqueue(store.repoRoot, id);
          return this.json(res, 200, { mission: this.summarize(recovered) });
        } catch (err) {
          return this.json(res, 409, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (action === 'cancel' && req.method === 'POST') {
        if (!this.opts.scheduler.cancel(id) && !isTerminal(mission.state)) {
          store.transition(mission, MissionState.CANCELLED, 'cancelled via control api');
        }
        return this.json(res, 200, { mission: this.summarize(store.mustLoad(id)) });
      }

      if (action === 'approvals' && req.method === 'GET') {
        return this.json(res, 200, { schemaVersion: API_SCHEMA, approvals: loadApprovals(store.dir(id)) });
      }

      if (action === 'approvals' && parts[4] && req.method === 'POST') {
        const body = await this.body(req) as { decision?: string; by?: string };
        const decision = body.decision === 'denied' ? 'denied' : 'approved';
        // decidedBy records the API caller — the signature over the decision
        // still requires the operator key when one is configured.
        const updated = decideApproval(store.dir(id), id, parts[4], decision, body.by ?? 'control-api');
        if (!updated) return this.json(res, 409, { error: 'approval not pending or not found' });
        store.emit(id, 'approval_decided', { gate: updated.gate, status: decision, by: body.by ?? 'control-api' });
        return this.json(res, 200, { approval: updated });
      }
    }

    this.json(res, 404, { error: `not found: ${req.method} ${path}` });
  }

  // ── event following (?follow) ──────────────────────────────────────────

  /** `?follow`, `?follow=1`, `?follow=true` opt in; `?follow=0/false/no` don't. */
  private wantsFollow(url: URL): boolean {
    if (!url.searchParams.has('follow')) return false;
    const v = (url.searchParams.get('follow') ?? '').toLowerCase();
    return !['0', 'false', 'no'].includes(v);
  }

  /**
   * Upgrade the events route to a bounded NDJSON tail (see event-follow.ts).
   * Replays persisted events with seq > after, then streams appends until
   * the mission is terminal, the follow limit is reached, or the peer goes
   * away. `limit` is a paging concept and is ignored in follow mode.
   */
  private followEvents(
    res: ServerResponse,
    store: MissionStore,
    mission: import('../types.js').Mission,
    after: number
  ): void {
    const maxFollowers = this.opts.maxFollowers ?? MAX_FOLLOWERS_DEFAULT;
    if (this.followers.size >= maxFollowers) {
      return this.json(res, 429, { error: 'too many open event streams' });
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      // Disables proxy buffering for self-hosted gateways in front of the API.
      'X-Accel-Buffering': 'no'
    });
    const follower = new MissionEventFollower({
      res,
      missionId: mission.id,
      eventsPath: join(store.dir(mission.id), 'events.jsonl'),
      afterSeq: after,
      // Fresh load each poll: the state check must observe cross-process
      // runners (a mission owned by another process still terminates here).
      loadState: () => store.load(mission.id)?.state ?? null,
      limits: resolveFollowLimits(this.opts.follow),
      onDone: f => { this.followers.delete(f); }
    });
    this.followers.add(follower);
    follower.start(mission.state);
  }
}
