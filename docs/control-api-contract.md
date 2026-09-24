# Control API contract — v1 (frozen)

This document is the versioned contract for the loopback control API served by
`agentloop daemon` (`src/daemon/control-api.ts`). It is the machine-readable
surface consumed by ai-cli-editor and operator tooling. Every statement here is
verified against code and pinned by `src/__tests__/control-api-contract.test.ts`
plus `control-api-auth.test.ts` / `control-api-events-follow.test.ts` /
`control-api-address.test.ts` / `control-api-socket.test.ts` — a shape or
status change must update this doc and the contract tests in the same commit.

## Versioning policy

- All routes live under `/v1`. Responses carry `schemaVersion: 1` either at the
  top level (read endpoints) or inside `mission`/`approval` objects (action
  endpoints).
- Additive changes (new optional response fields, new routes, new event types)
  are permitted within v1 — consumers MUST ignore unknown fields.
- Removing or renaming fields, changing a status code, or changing envelope
  shapes is breaking and requires `/v2`. There is no `/v2` today.
- Paths are exact: trailing slashes are NOT normalized (`/v1/missions/` → 404).
- MCP (`agentloop mcp`) is a separate stdio surface, not part of this contract;
  it deliberately exposes no approval-decision tool.

## Transport and authentication

- HTTP/1.1 JSON over loopback. Default bind `127.0.0.1:3210`; port `0` means
  OS-assigned (read the real URL from `.agentloop/daemon.json`).
- Binding to a non-loopback address without a configured token refuses to
  start.
- **Socket transport (opt-in):** `daemon.socketPath` config or
  `agentloop daemon --socket <path>` replaces the TCP listener with a Unix
  domain socket (POSIX — absolute path, ≤103 chars) or a Windows named pipe
  (`\\.\pipe\<name>`). `daemon.json` then publishes `transport`
  (`"unix"`/`"pipe"`) + `socketPath` and **no `url` field** — consumers that
  only speak TCP must treat the daemon as unreachable over HTTP and fall
  back. POSIX socket files are created mode `0600` and unlinked on stop; a
  stale socket file is reclaimed on start, while a live peer on the endpoint
  refuses the bind (`socket already in use`). Clients connect with
  `socketPath` + any `http://localhost` URL and send `Host: localhost`
  (Node's default; an optional port suffix is accepted). Every other
  contract rule below is unchanged — the socket narrows network exposure, it
  is not an authentication mechanism.
- **Every data route requires** `Authorization: Bearer <token>` — including
  loopback. Token sources, in order: `daemon.token` config →
  `AGENTLOOP_API_TOKEN` env → generated ephemeral `alr_<48 hex>` persisted in
  `.agentloop/daemon.json` (mode 0600 where supported).
- The comparison is constant-time; malformed schemes (`Basic`, `bearer`,
  wrong length) all get 401.
- **Host header must match the bound host:port** (anti-DNS-rebinding) → else
  403, checked before auth. On a socket transport the accepted authority is
  `localhost[:port]` — the same gate, with nothing to rebind.
- The ONLY unauthenticated response is `OPTIONS *` → `204` with empty body
  (CORS preflight). CORS headers (`Access-Control-Allow-Origin`, `Vary`,
  allowed methods `GET,POST,OPTIONS`, allowed headers
  `Content-Type,Authorization`) are emitted only when `daemon.corsOrigins`
  lists the exact request `Origin`. No cookies, no sessions.
- Unauthenticated probes cannot enumerate routes: every path returns 401, and
  the 401 body never echoes the requested path.

## Common envelopes

Success bodies are JSON (`Content-Type: application/json`), except `?follow`
streams which are `application/x-ndjson; charset=utf-8`.

Error envelope — ALWAYS a single field:

```json
{ "error": "human-readable message" }
```

| Status | Meaning | Examples |
|---|---|---|
| 400 | request validation failed | missing `spec.objective`/`acceptanceCriteria`, objective >4096 chars, in-place without sign-off, `createMission` domain errors |
| 401 | missing/wrong bearer | `unauthorized: bearer token required` |
| 403 | Host header mismatch | `host header does not match the bound interface` |
| 404 | unknown route or resource | `not found: GET /v1/nope`, `mission not found: <id>`, `unknown repo: <path>` |
| 409 | state conflict | `resume` on non-recoverable mission; deciding a non-pending/unknown approval |
| 429 | too many open `?follow` streams | `too many open event streams` |
| 500 | handler threw | `internal error` — NOTE: a malformed/oversized JSON body (>64 KiB) currently surfaces as 500, not 400 (pinned behavior) |

Timestamps are ISO-8601 strings. `at` fields are server-clock generation time.
Responses never contain secrets, full prompts, or log payloads.

## Shared object: `MissionSummary`

The bounded public projection of a mission (never the raw record — spec, tasks,
passes, env are not exposed). Exact key set:

```json
{
  "schemaVersion": 1,
  "id": "msn_…",
  "kind": "objective" | "maintenance" | "continuous",
  "state": "<MissionState>",
  "revision": 3,
  "policyHash": "0123abcd…",
  "objective": "first 200 chars of the objective",
  "repo": "/abs/repo/root",
  "agent": { "type": "qwen", "name": "default" },
  "worktree": "/abs/workspace/path",
  "workspaceMode": "worktree" | "in-place",
  "branch": "agentloop/msn_…",            // absent until prepared
  "usage": {
    "agentInvocations": 0,
    "repairPasses": 0,
    "wallTimeMs": 0,
    "approvalWaitMs": 0,                  // optional
    "startedAt": "…"                      // optional
  },
  "pendingApprovals": [
    { "id": "ap_…", "gate": "push", "detail": "…",
      "paths": ["src/x"], "commands": [["git","push"]] }   // paths/commands only when bound
  ],
  "checkpoints": 2,                        // count, not the objects
  "lastRecovery": { … },                   // absent unless a crash audit ran
  "outcome": { … },                        // absent unless terminal
  "createdAt": "…", "updatedAt": "…", "at": "…"
}
```

`pendingApprovals` mirrors `mission.approvals` (what the runner recorded). The
authoritative operator-facing ledger is the `approvals` route below — approvals
requested directly on the ledger appear there even when the mirror is empty.

`state` values (`MissionState`): `created`, `prepared`, `running`, `paused`,
`waiting_for_approval`, `validating`, `repairing`, `blocked`, `stale`,
`completed`, `failed`, `cancelled`. Terminal: `completed`, `failed`,
`cancelled`.

## Routes

### `GET /v1/status` → 200

```json
{
  "schemaVersion": 1, "status": "ok", "version": "<pkg version>",
  "uptimeMs": 1234,
  "scheduler": {
    "queued": 0, "running": ["msn_…"],
    "admission": { "deferred": false }
    // when deferred: { "deferred": true, "reason": "…", "since": "…", "sample": {…} }
  },
  "repos": ["/abs/repo1", "…"],
  "corrupt": [{ "id": "msn_…", "error": "…" }],
  "at": "…"
}
```

`corrupt` lists mission directories whose `mission.json` exists but is
unparseable (bytes are preserved for inspection, not auto-repaired).

### `GET /v1/missions` → 200

```json
{ "schemaVersion": 1, "missions": [ <MissionSummary>, … ] }
```

Missions across every registered repo, newest `createdAt` first.

### `POST /v1/missions` → 201

Request body:

```json
{
  "repo": "/abs/repo",              // optional — defaults to the first registered repo
  "spec": {
    "objective": "…",               // required, ≤4096 chars
    "acceptanceCriteria": ["…"],    // required, non-empty
    "scope": ["src/**"], "nonGoals": ["…"],
    "verificationCommands": ["npm test"], "riskConstraints": ["…"]
  },
  "agent": { "name": "…", "type": "codex", "model": "…", "args": ["…"],
             "additionalArgs": ["…"], "command": "/path/exe", "env": {"K":"V"} },
                                    // optional — defaults {"name":"default","type":"qwen"}
  "kind": "maintenance",            // optional — only "maintenance" is honored;
                                    // any other value (incl. "continuous") → "objective"
  "inPlace": true,                  // optional — default worktree mode
  "inPlaceApproved": true,          // REQUIRED when inPlace — the same two-flag
                                    // rule as the CLI; missing → 400
  "priority": 50                    // optional — lower admits earlier (default 100)
}
```

Response `201`: `{ "mission": <MissionSummary> }` — no top-level
`schemaVersion` on action responses. The mission is persisted (`created`) and
enqueued; a registered scheduler starts a runner.

Errors: `400` validation/domain errors (incl. the in-place two-flag rule and
`createMission` failures), `404` unknown `repo`, `500` malformed JSON body.

### `GET /v1/missions/:id` → 200 / 404

```json
{ "schemaVersion": 1, "mission": <MissionSummary>, "tasks": [ <TaskNode>, … ] }
```

`tasks` is the full task DAG array (id, title, dependsOn, status, result…).
`:id` is looked up across all registered repos.

### `GET /v1/missions/:id/events` → 200 / 404 — paged mode

Query params: `after=<seq>` (events with `seq > after`; non-numeric → 0),
`limit=<n>` (default 100, clamped to `[1, 500]`).

```json
{
  "schemaVersion": 1, "missionId": "msn_…",
  "events": [ <RuntimeEvent>, … ],
  "skippedLines": 0,
  "nextAfter": 17,
  "hasMore": false
}
```

Poll pattern: request with `after=<nextAfter>` until `hasMore` is false.
`skippedLines` counts torn/corrupt log lines (diagnostics, not failure).

`RuntimeEvent`: `{ "id": "evt_…", "seq": 12, "type": "<type>", "at": "…",
"missionId": "msn_…", "data": { … } }` — `id`, `seq`, `data` are optional.
Known `type` values: `mission_created`, `mission_prepared`, `task_started`,
`task_finished`, `agent_started`, `agent_finished`, `file_activity_summary`,
`validation_started`, `validation_finished`, `review_finished`,
`approval_required`, `approval_decided`, `checkpoint_created`, `state_changed`,
`mission_completed`, `mission_failed`, `mission_cancelled`, `mission_blocked`,
`mission_deferred`, `mission_stale`, `runner_heartbeat`, `runner_claimed`,
`lease_lost`, `recovery_audit`, `orphan_process_killed`, `approval_unverified`,
`work_interrupted`, `workspace_cleaned`.

### `GET /v1/missions/:id/events?follow` → 200 NDJSON stream

`?follow`, `?follow=1`, `?follow=true` opt in; `?follow=0|false|no` stays in
paged mode. `?after=<seq>` applies to the replayed backlog; `limit` is ignored
in follow mode.

Headers: `Content-Type: application/x-ndjson; charset=utf-8`,
`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.

Line contract — one JSON object per `\n`-terminated line:

```jsonl
{"meta":"begin","missionId":"msn_…","state":"running","after":0,"at":"…"}
{"id":"evt_…","seq":9,"type":"agent_started","at":"…","missionId":"msn_…","data":{…}}
{"meta":"heartbeat","at":"…"}
{"meta":"end","reason":"terminal","state":"completed","skippedLines":0,"at":"…"}
```

- First line is always `{"meta":"begin",…}` with the mission's state at open.
- Event lines are the exact persisted `events.jsonl` records (with `seq`), in
  append order — replayed backlog first, then live appends.
- `{"meta":"heartbeat","at":…}` keepalives arrive on an idle stream.
- The final line is `{"meta":"end",…}`; `reason` is one of `terminal`
  (mission reached a terminal state — `state` present after a short drain
  window), `limit` (per-connection `maxDurationMs` cap hit — no `state`),
  `shutdown` (daemon stop or client disconnect — the end line may not arrive
  on disconnect), `gone` (mission record unreadable — no `state`), `error`
  (internal failure — no `state`).
- Bounds (config `daemon.eventFollow`): `pollMs` 500, `heartbeatMs` 15000,
  `maxDurationMs` 30 min, `maxConnections` 32 (429 beyond), per-poll read cap
  512 KiB, max line 256 KiB (oversized lines counted into `skippedLines`).
  The stream ALWAYS ends — consumers must still handle reconnect via `after`.

### `POST /v1/missions/:id/pause` → 200

`{ "mission": <MissionSummary> }`. If the scheduler owns a live runner it is
asked to pause (async); otherwise a `running`/`validating`/`repairing` mission
is transitioned to `paused` directly. Other states are left unchanged — the
route always answers 200 for a known mission.

### `POST /v1/missions/:id/resume` → 200 / 409

`{ "mission": <MissionSummary> }` on success — recovery runs and the mission is
re-enqueued. `409 {error}` when the mission is not recoverable (e.g. `created`,
terminal, or recovery validation failed).

### `POST /v1/missions/:id/cancel` → 200

`{ "mission": <MissionSummary> }`. Live runners are cancelled; a non-terminal
mission not owned by the scheduler is transitioned to `cancelled`. Terminal
missions return their current summary.

### `GET /v1/missions/:id/approvals` → 200 / 404 / 409

```json
{ "schemaVersion": 1, "approvals": [ <ApprovalRequest>, … ] }
```

Reads the per-mission approvals ledger (`approvals.json`) — the authoritative
operator-facing record. `409 {error}` when the ledger is corrupt or malformed
(`CorruptApprovalsError` — the file is preserved for operator repair); an
unreadable ledger is never reported as an empty one.

`ApprovalRequest`: `{ "id": "ap_…", "gate": "<gate>", "detail": "…",
"commands": [["git","push"]], "paths": ["src/x"], "policyHash": "…",
"worktree": "…", "status": "pending|approved|denied", "requestedAt": "…",
"decidedAt": "…", "decidedBy": "…", "sig": "<hmac>" }` — `commands`, `paths`,
`policyHash`, `worktree`, `decidedAt`, `decidedBy`, `sig` are optional. `sig`
exists only when `AGENTLOOP_APPROVAL_KEY` is configured. Gates:
`scope-expansion`, `dangerous-command`, `push`, `pull-request`, `merge`,
`dependency-change`, `deployment`, `policy-change`, `in-place-execution`.

### `POST /v1/missions/:id/approvals/:approvalId` → 200 / 409

Body: `{ "decision": "approved" | "denied", "by": "operator-name" }` — **any
`decision` value other than `"denied"` (including absent) means `approved`**;
`by` defaults to `"control-api"`.

Response `{ "approval": <ApprovalRequest> }` with `status`, `decidedAt`,
`decidedBy` filled. `409 {error}` when the approval is not pending or not
found, or when the ledger is corrupt (`CorruptApprovalsError`). The decision
is written to the ledger the runner polls — there is no separate human
channel. Emits an `approval_decided` event.

## Consumer guidance (ai-cli-editor)

1. Read `url` + `token` from `<repo>/.agentloop/daemon.json` (or
   `AGENTLOOP_HOME/daemon.json`); treat the token as a secret — never pass it
   to an agent. When `transport` is `"unix"`/`"pipe"` there is no `url` —
   connect to `socketPath` with `Host: localhost`, or treat the daemon as
   unreachable over TCP and fall back.
2. Poll `GET /v1/missions/:id/events?after=<seq>` or hold a `?follow` stream;
   on stream end (`limit`/`gone`/`error`) reconnect with the last seen `seq`.
3. Ignore unknown fields and unknown event types — additive changes are legal
   within v1.
4. Drive missions via `POST /v1/missions` + `pause`/`resume`/`cancel`;
   approvals are decided by the operator through this API or
   `agentloop approve` — MCP clients get no such tool.
