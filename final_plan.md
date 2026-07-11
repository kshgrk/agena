# Agena v1 — Final Architecture Plan

> This document supersedes `docs/archive/claude_plan.md` and `docs/archive/codex_plan.md`; it is the single authoritative plan for Agena v1, synthesized from eight section drafts and four adversarial reviews. Every name, path, port, event type, and error code in this file is canonical; if code disagrees with this file, the code is wrong.

## Table of Contents

1. [Executive Summary & Product Shape](#1-executive-summary--product-shape)
2. [Non-Negotiable Invariants](#2-non-negotiable-invariants)
3. [System Architecture Overview](#3-system-architecture-overview)
4. [Monorepo & Codebase Structure](#4-monorepo--codebase-structure)
5. [Wire Protocol](#5-wire-protocol)
6. [Event Handling Pipeline](#6-event-handling-pipeline)
7. [Database Schema & Event Store](#7-database-schema--event-store)
8. [Pi Runtime Integration](#8-pi-runtime-integration)
9. [Daemon: Transport, Concurrency, Lifecycle](#9-daemon-transport-concurrency-lifecycle)
10. [Docker, Filesystem & Cloud Path](#10-docker-filesystem--cloud-path)
11. [Client: CLI, TUI & Shell Attach](#11-client-cli-tui--shell-attach)
12. [Extensibility Surface (.agena/)](#12-extensibility-surface-agena)
13. [Testing Strategy & Quality Gates](#13-testing-strategy--quality-gates)
14. [Build Milestones & Acceptance Criteria](#14-build-milestones--acceptance-criteria)
15. [Problem Register](#15-problem-register)
16. [Risk Register](#16-risk-register)
17. [V1 Non-Goals](#17-v1-non-goals)
18. [Open Decisions with Recommendations](#18-open-decisions-with-recommendations)

---

# 1. Executive Summary & Product Shape

## 1.1 One-liner and promise

**Agena is a local-feeling terminal harness for AI coding whose runtime, files, sessions, and agent state live in a persistent containerized workspace — Docker in v1, a cloud workspace later, with zero client changes in between.**

The promise: start work anywhere, resume anywhere; same session, same branch, same files, same tools, same machine. Kill the TUI mid-stream and reopen it on another laptop: it catches up in under a second and keeps streaming. Everything the agent does — every message, tool call, model switch, approval, shell attach — is durable, inspectable, and replayable.

## 1.2 System spine

- A compiled `agena` CLI/TUI on the local machine (Bun, provisional per INV-13 / P18) renders only normalized Agena events and frames — never Pi types (P17).
- One multiplexed WebSocket per client at `GET /v1/ws` carries session subscriptions, commands (with `requestId` ack/error), durable events, and ephemeral frames; Hono HTTP carries request/response APIs; a separate dedicated binary WebSocket per PTY at `GET /v1/ptys/:id/ws` carries `agena shell` bytes. (P4, P5, P13)
- A Node daemon inside a Docker container embeds the Pi SDK (`@earendil-works/pi-coding-agent`, `createAgentSession` per session) behind a `RuntimeAdapter` port defined in `packages/core` and implemented only in `packages/runtime-pi`. Pi's protocol never crosses the network. (P11, P16)
- Durable events are appended to a SQLite event store under `/var/lib/agena` (outside `/workspace`), with per-session monotonic `seq` assigned in the append transaction, projections updated in the same transaction, and fanout strictly after commit. (P1, P6)
- High-frequency deltas are ephemeral frames (`afterSeq`), streamed live and never persisted. (P12)
- `/workspace` is the agent's and the user's shared filesystem; `agena shell` is a raw PTY into it; snapshots capture `/workspace` only and never touch session history. (P1)

**Build stance:** the first milestone is a walking skeleton proving the full loop (prompt → stream → kill TUI → reconnect) with an explicit **in-memory, daemon-lifetime event log** (`InMemoryEventStore` in `packages/core`); SQLite persistence arrives in Milestone 2 behind the same port. Nobody builds throwaway persistence, and every milestone ships with explicit acceptance criteria mapped to the FL requirements below. (P8, P19)

## 1.3 Daily flow

A personal-first harness the user lives inside every day: type `agena`, keep working. Claude and Codex histories are imported once as searchable, resumable context (`agena import`); Pi powers the runtime internally; Agena — not Pi's JSONL, not any provider transcript — owns the source of truth.

```bash
agena                          # open the TUI, resume where you left off
agena new "fix the flaky auth test"
agena resume                   # picker; or: agena resume <sessionId> / --last
agena sessions                 # list; agena search "jwt refresh"
agena shell                    # a real terminal inside /workspace
agena files ls src/            # browse/read/get/put files without the TUI
agena snapshot create "before refactor"
agena import claude            # one-time backfill
agena info                     # diagnostics: daemon, versions, .agena/ discovery
```

## 1.4 Feels-local requirements (FL-1 … FL-9)

These are product acceptance requirements; milestone acceptance criteria (§14) map to them by number.

| # | Requirement | Concrete target |
|---|---|---|
| FL-1 | Instant open | `agena` paints the TUI before the WS connects (< 200 ms cold on a local container); connection state shown in the status bar, never a blocking spinner. |
| FL-2 | Live streaming | Assistant text/thinking and tool output stream as ephemeral frames with < 30 ms added transport latency over the model's own latency. |
| FL-3 | Reconnect is invisible | Kill the TUI mid-stream, reopen: durable replay from `fromSeq` + in-flight snapshot + live frames resumes in < 1 s. No "forever pending" message may ever render (P2). |
| FL-4 | Same filesystem | A file created in `agena shell` is immediately visible to the agent, and vice versa — one `/workspace`, zero sync. |
| FL-5 | Real terminal | `agena shell` keystroke echo is indistinguishable from `docker exec -it`: raw bytes on a dedicated WS, no JSON envelope (P5). |
| FL-6 | Device switching | Any client subscribing with `{sessionId, fromSeq}` reconstructs identical state; client keeps only its cursor + draft input locally. |
| FL-7 | Nothing hidden | Tool calls, approvals, model switches, shell attaches, snapshots are all visible in the TUI stream because they are durable events. |
| FL-8 | Fail fast, never hang | Daemon down ⇒ every command errors within 2 s with an actionable message (`daemon unreachable at <url> — is the container running? try: agena info`). |
| FL-9 | History survives everything | Container restart, daemon crash, snapshot restore — the event log is intact and sessions resume (P1, P2). |

## 1.5 CLI command surface (v1) — the single canonical list

`agena` is the only user entry point. This table is the one owner of the v1 verb list; no other section may add or remove verbs.

| Command | What it does | Transport |
|---|---|---|
| `agena` | Open the TUI. Resumes the most recent session for the current project/cwd scope, or shows that scoped picker if none. Flags: `--profile <name>`, `--session <id>`, `--global`, `--all-projects`. | HTTP list + main WS |
| `agena new "<task>"` | Create a session (`POST /v1/sessions`) in the current project/cwd scope, attach the TUI, send the task as the first prompt. Flags: `--model`, `--detach`, `--no-tui` (print id, stream plain output), `--global`, `--cwd <path>`. | HTTP + main WS |
| `agena resume [id \| --last]` | Attach to an existing session: fetch projections over HTTP, then `subscribe {sessionId, fromSeq}` on the main WS. No arg ⇒ current-project picker; `--all-projects` broadens it. ULID prefix match accepted. | HTTP + main WS |
| `agena sessions` | List sessions (`GET /v1/sessions`). Default is current project/cwd scope. Flags: `--all-projects`, `--global`, `--archived`, `--source native\|claude\|codex`, `--json`. | HTTP |
| `agena search "<query>"` | FTS5 search over titles + message text (`GET /v1/search?q=`). Default is current project/cwd scope; `--all-projects` searches the whole workspace. Prints session/message hits with seq anchors; `--json`. | HTTP |
| `agena shell [-- <cmd>]` | Open a PTY in the session cwd when `--session <id>` is provided, otherwise in the current project/cwd scope (or workspace root for `--global`). Detach from the TUI with `Ctrl+J`; standalone shells propagate exit code. With `--session <id>`, appends `terminal.session.started/ended` durable events to that session; **without a session association no durable events are emitted** (no session context exists). | dedicated PTY WS |
| `agena files ls [path]` / `cat <path>` / `get <path> [local]` / `put <local> <path>` | Browse, read, download, upload workspace files. `get -r <dir>` streams a tar.zst via `GET /v1/files/archive`. The container FS is the manifest in v1 — no file index table. There is **no separate `agena cp`**; `files get/put` (plus `get -r`) is the v1 file-movement surface. | HTTP |
| `agena ports list` / `expose <port>` / `hide <port>` | Manage remote workspace preview URLs. `expose 3000` creates an authenticated browser URL for the service listening inside the workspace, e.g. `https://<workspace>-3000.preview.agena.dev`. This is **not** local port forwarding; it does not make laptop `localhost:3000` work. | HTTP + preview ingress |
| `agena snapshot create <name>` / `list` / `restore <id>` | Tarball `/workspace` (mechanically excludes `/var/lib/agena`). Restore replaces files only and appends `snapshot.restored` to the workspace control session; it NEVER rolls back the event store (P1). | HTTP |
| `agena approvals` | List pending approvals across sessions (`GET /v1/approvals?pending=1`, derived from durable events). | HTTP |
| `agena approve <approvalId> [--option <id> \| --input <text> \| --input-file <path> \| --deny]` | Respond to an approval headlessly (same command path as the TUI modal; `--input-file` serves `editor`-kind approvals). | HTTP + main WS |
| `agena import claude` / `agena import codex [--path <dir>]` | CLI reads local `~/.claude` / `~/.codex` data, streams a tar to `POST /v1/imports`; daemon writes the raw archive under `/var/lib/agena/raw-imports/`, normalizes into events (`source.kind: "importer"`), generates resume-ready summaries. Idempotent per `source_ref`. `--dry-run` supported. | HTTP |
| `agena info` | Diagnostics: daemon health/version, protocol version, pinned Pi version, workspace path, DB/event counts, `.agena/` discovery report with per-descriptor errors (P20), auth status. `--json`. | HTTP `GET /v1/diagnostics` |
| `agena rebuild` | Drop and rebuild ALL projections — messages, tool_calls, **and the FTS5 index** — from the event log (`POST /v1/admin/rebuild`). Safe to run anytime (P7). Requires `--yes` in non-TTY. | HTTP |
| `agena workspace init [--git <url> \| --from-local <path>]` / `open <name>` / `stop <name>` / `rm <name> [--purge]` / `logs <name>` | Provision/manage workspace containers: mints `workspaceId` + auth token, renders the compose project, seeds `/workspace`. `rm` keeps volumes unless `--purge` (typed-name confirmation). §10.4. | local Docker + HTTP |
| `agena login --url <url> [--token <t>]` | Register a profile pointing at an existing/remote daemon (the bridge to the cloud deployment — profile management under INV-12, not a new auth mechanism). | local config |

Deliberately **absent** from v1 (each is a decision, see §17): `agena share` (parked, P9 — the verb is **not registered**; no stub), `agena cp`/`agena sync` (`files get/put` covers v1), `agena plugins install` (v1 plugins are authored in `.agena/`).

Global flags: `--profile <name>`, `--url <daemonUrl>` (override), `--project <id-or-name>`, `--cwd <path>`, `--global`, `--all-projects`, `--json`, `--no-color`, `--log-level`, `--config <path>`. Stable exit codes: `0` ok · `1` failure · `2` usage · `3` feature deferred · `4` connection failure · `5` auth failure · `6` not found · `7` protocol version mismatch. Non-TTY: the TUI never starts; `agena new "task" --no-tui | tee log` must work.

## 1.6 Project/cwd session scoping

Default session selection is local-folder aware. The CLI resolves the host cwd through the active profile to a workspace-relative cwd and project root, then sends that scope in `POST /v1/sessions` and list/search filters. A plain `agena` from `/repo-a` must not resume a `/repo-b` session unless the user passes `--all-projects`, a direct `--session`, or chooses from the all-project picker.

Rules:

1. The daemon stores `projectId`, `scope`, and workspace-relative `cwd` on the session. Runtime sessions and PTYs start from that durable cwd; they never trust the client's current host cwd after creation.
2. `scope="project"` is the default. The project root is the nearest registered root for the current cwd; if none exists, the CLI registers one lazily using the detected git root or the cwd itself.
3. `scope="global"` is explicit (`--global`) and means "not tied to a project"; global sessions are hidden from project-local defaults.
4. Host absolute paths are hints only (`hostCwdHint`) for diagnostics and local profile resolution. Cloud clients use the same `projectId` + workspace-relative cwd without host-path semantics.
5. A session cwd must stay inside its project root unless the session is global/control. `..` traversal and symlink escapes are rejected at the daemon boundary.

## 1.7 Remote development networking

Remote Agena workspaces do **not** try to make remote ports appear as local machine `localhost` in v1. The workspace shell, agent runtime, Docker/Compose services, and dev servers all run inside the remote workspace/container; `localhost` there means the workspace, not the user's laptop.

The v1 browser-access surface is **preview URLs**:

```text
workspace shell starts:  vite --host 0.0.0.0 --port 3000
Agena exposes:          https://<workspace>-3000.preview.agena.dev
```

Rules:

1. Preview URLs are authenticated/private by default and work from any browser, including phones.
2. The user can always use `agena shell` or the TUI embedded shell for command-line work inside the workspace.
3. Agena does not promise `http://localhost:3000` on the user's laptop unless a future local forwarding feature is explicitly added.
4. Local VPN/DNS, SSH-style port forwarding, and callback-tunnel products (stable webhook URLs, request logs, replay) are post-v1 unless pulled forward by a concrete integration need.
5. Docker/Compose services talk to each other inside the workspace network by normal service names (`api` → `db:5432`). Only user-facing web/API ports should get preview URLs.

---

# 2. Non-Negotiable Invariants

Every section must comply; a design that violates one of these is wrong by definition.

**INV-1 — Agena protocol first.** Clients speak only the Agena protocol defined in `packages/protocol` (Zod schemas, versioned). Pi RPC, Pi SDK events, and Pi JSONL never cross the network; `packages/runtime-pi` is the only package importing Pi, and `packages/core` defines the `RuntimeAdapter`/`RuntimeSession`/`EventStore` ports it implements. A fake runtime implements the same ports so everything above the adapter is testable with zero model calls. (P11, P16)

**INV-2 — Events are truth.** The durable event log is the only source of truth. Every other table (messages, tool_calls, FTS5, session summary fields) is a projection rebuildable by `agena rebuild`, including the FTS index. Raw archives (Pi JSONL, import archives, runtime capture tees) are debug artifacts, never read paths for product features. (P7, P15)

**INV-3 — Two-tier events.** Durable events are persisted with a per-session monotonic `seq` assigned inside the append transaction. High-frequency deltas (`message.assistant.text.delta`, `tool.call.output.delta`, …) are ephemeral frames carrying `afterSeq` and are **never persisted as event rows**. Durable replay alone must reconstruct correct final UI state; frames only improve liveness. (P12)

**INV-4 — No forever-pending states.** Everything that starts durably must end durably. Terminal-event sets are fixed: `message.assistant.completed | aborted | failed`, `tool.call.completed | failed | aborted | denied`, `run.completed | aborted | failed`, `approval.responded | expired | cancelled`, `terminal.session.ended`. Abort events carry partial content from the runtime's in-flight snapshot; the daemon's boot recovery pass closes any still-open work before accepting connections (crash-case payloads in §5.6). Replay can therefore never show a spinner forever. (P2)

**INV-5 — Fanout strictly after commit.** `appendEvents` (the single durable write path) assigns `seq`, writes events, and updates projections inside one SQLite transaction; the store invokes its `onCommitted` listeners only after that transaction commits, ordered by `seq`. The daemon's `FanoutHub` is registered as an `onCommitted` listener — **the store's hook is the one fanout seam** (§6.2). Clients can never observe an event that could roll back. (P6)

**INV-6 — One multiplexed WS per client.** All session traffic — subscriptions, commands, durable events, ephemeral frames — flows over a single WebSocket per client at `GET /v1/ws`. Subscription is a command: `subscribe {sessionId, fromSeq}` / `unsubscribe {sessionId}`. No per-session sockets; no `fromSeq` in the URL. (P4)

**INV-7 — Commands are correlated and retry-safe.** Every client→daemon command carries a client-generated `requestId` (ULID) and receives exactly one `ack` or `error` referencing it. The daemon keeps a connection-independent `requestId → result` dedupe map (TTL 5 min): a duplicate `requestId` re-acks the original result without re-executing, which makes post-reconnect retry of unacked commands safe. Errors carry stable machine-readable codes from the single `ErrorCode` enum in `packages/protocol` (§5.9). (P13)

**INV-8 — Terminal bytes are out-of-band.** PTY byte streams flow only over a dedicated binary WebSocket per PTY (`GET /v1/ptys/:id/ws`), no JSON envelope. Only lifecycle markers (`terminal.session.started/ended`) are durable events. Terminal-observation frames on the main channel are explicitly **future/optional**, not v1. (P5)

**INV-9 — Provenance on every event.** `AgenaEvent.source` is required in the protocol and has matching explicit columns in the events DDL (`source_kind`, `source_runtime`, `source_client_id`):

```ts
type EventSource = {
  kind: "user" | "daemon" | "runtime" | "terminal" | "filesystem" | "importer";
  runtime?: "pi";       // set when kind === "runtime" (and for importer-normalized runtime events)
  clientId?: string;    // set when kind === "user": which client issued the command
};
```
(P3)

**INV-10 — Daemon state, workspace files, and user environment are separate.** Daemon state lives under `/var/lib/agena`; project files and reproducible environment intent live under `/workspace` (including `/workspace/.agena/environment.toml`); user-level tools, dotfiles, and CLI credentials live under `/home/agena`. Workspace snapshots capture `/workspace` only, so restore never touches the event store or credentials. (P1)

**INV-11 — Branch replay contract.** Branch is a column on events; each branch records `parent_branch_id` and `forked_from_seq`. Replaying a branch walks the parent chain root-ward, taking each ancestor's events up to that ancestor's `forked_from_seq`, then the branch's own events, in `seq` order. v1 ships single-branch sessions on this exact model. (P10)

**INV-12 — Auth is always on.** Every HTTP request and every WS upgrade (main and PTY) requires a bearer token in the `Authorization` header, even on localhost — a container port is not a trust boundary. The token is minted by the CLI at `agena workspace init`, injected as `AGENA_AUTH_TOKEN`, persisted by the daemon to `/var/lib/agena/config/token` (0600, auto-generated only as a fallback when the env is absent), and stored client-side in `~/.config/agena/credentials.json` (0600). This is the same mechanism that later becomes real auth against a cloud workspace.

**INV-13 — Runtime split.** Daemon runs on Node (node-pty safety, Pi SDK stability); the compiled CLI targets Bun, **provisionally** — spike at M1, formal gate at end of M3 (§18-OD1); Node fallback is a distribution change, not a rewrite. Monorepo is pnpm workspaces; Drizzle, Zod-in-protocol, Vitest, Biome, strict TypeScript everywhere. (P18)

**INV-14 — Daemon is the single arbiter.** Exactly one daemon process owns a workspace and its event store (single writer). All session commands from all clients serialize through it; clients are thin views holding only cursor and draft state.

---

# 3. System Architecture Overview

## 3.1 Diagram

```
┌─────────────────────────── local machine ───────────────────────────┐
│  terminal                                                           │
│   └── agena CLI (apps/cli, Bun — provisional)                       │
│        ├── TUI (packages/tui — pi-tui first)                        │
│        └── client SDK (packages/client)                             │
│              │                                                      │
│              │ 1× multiplexed WS  GET /v1/ws                        │
│              │   subscribe {sessionId, fromSeq} · cmd{requestId}    │
│              │   durable events · ephemeral frames                  │
│              │ Hono HTTP  /v1/*  (sessions, search, files, blobs,   │
│              │   snapshots, imports, approvals, diagnostics, admin) │
│              │ N× dedicated PTY WS  GET /v1/ptys/:id/ws (binary)    │
└──────────────┼──────────────────────────────────────────────────────┘
               ▼  bearer token on every HTTP request + WS upgrade
┌────────────────────────── Docker container ─────────────────────────┐
│  Agena daemon (apps/daemon, Node) — port 7777, host 127.0.0.1:≥7700 │
│   ├── WS gateway + Hono routes            (fanout AFTER commit)     │
│   ├── packages/core: sessions, approvals, projections,             │
│   │     EventStore / RuntimeAdapter / RuntimeSession ports          │
│   ├── packages/storage-sqlite ──► /var/lib/agena/db/agena.db       │
│   │     (daemon state volume — NEVER inside /workspace)             │
│   ├── PTY manager (node-pty)                                        │
│   └── RuntimeAdapter port                                           │
│         └── packages/runtime-pi (ONLY package importing Pi)         │
│               └── Pi SDK, in-process (createAgentSession,           │
│                     session.subscribe, SessionManager)              │
│                     └──► /workspace  (repo files + .agena/)         │
│                            (workspace volume — snapshot target)     │
└──────────────────────────────────────────────────────────────────────┘
```

Two planes, one box in v1: the daemon (control plane: identity, events, approvals, search, snapshots) and the workspace (execution plane: files, PTYs, the Pi runtime) share one container but are separated by the protocol boundary and by storage geography (§3.3) — exactly what lets the daemon move to a cloud workspace unchanged later.

## 3.2 Canonical constants (single source of truth)

Every other section references these values; **no section may restate different ones.**

| Constant | Value |
|---|---|
| In-container daemon port | `7777` (env `AGENA_PORT`) |
| Host publish | `127.0.0.1:<first free port ≥ 7700>` (never non-loopback in v1) |
| Main WS endpoint | `GET /v1/ws`, subprotocol `agena.v1` |
| PTY WS endpoint | `GET /v1/ptys/:id/ws` |
| Auth token env | `AGENA_AUTH_TOKEN` |
| Token file (daemon side) | `/var/lib/agena/config/token` (0600) |
| State/workspace/home env | `AGENA_STATE_DIR=/var/lib/agena`, `AGENA_WORKSPACE_DIR=/workspace`, `HOME=/home/agena` |
| Raw-capture switch | `rawCapture.enabled` in `daemon.json` / env `AGENA_RAW_CAPTURE=1` — the only v1 switches; no CLI verb (§1.5 owns the verb list) |
| Client config root | `~/.config/agena/` (XDG); profiles in `config.json`, tokens in `credentials.json` (0600) |
| Profile selector flag | `--profile <name>` |
| Inline payload cap | 64 KiB (then blob spill) |
| Post-spill hard cap | 128 KiB (`PAYLOAD_TOO_LARGE`) |
| Max wire envelope | 1 MiB |
| Prompt text cap | 256 KiB |
| Frame coalesce watermark | 1 MiB `bufferedAmount` |
| Frame drop watermark | 4 MiB |
| Durable backlog disconnect | 16 MiB or 15 s no progress → close `4429` |
| Heartbeat | daemon → client ping every 15 s; 2 missed pongs → close `1001` |
| Command ack timeout (client) | 30 s |
| requestId dedupe window | 5 min (connection-independent LRU) |
| PTY idle reap | 15 min unattached (`pty.idleTimeoutMs: 900_000`) |
| PTY scrollback ring | 256 KiB |
| Runtime session idle eviction | 30 min |
| Client render throttle | 40 ms tick |
| SIGTERM budget | drain 10 s + flush 3 s, under `stop_grace_period: 30s` |
| In-memory store name | `InMemoryEventStore` (packages/core) |
| Protocol upcast module | `packages/protocol/src/upcasts.ts` |
| HTTP schema module | `packages/protocol/src/http.ts` |

## 3.3 Storage geography — three roots, never mixed (solves P1)

The normative on-disk tree (all other sections reference this; the daemon builds every path through one `paths.ts` module):

```
/var/lib/agena/               # DAEMON STATE — named volume "agena-state-<workspaceId>"
  config/
    daemon.json               #   daemon config incl. workspaceId (Zod-validated)
    token                     #   bearer token, 0600 (persisted from AGENA_AUTH_TOKEN)
    secrets.env               #   optional provider keys file, 0600 (env takes precedence)
    mcp.json                  #   normalized source-neutral MCP definitions; never secrets
    mcp-secrets.enc           #   encrypted static MCP API keys/tokens
    mcp-oauth/                #   Agena-owned OAuth client registrations + rotating tokens
  db/
    agena.db                  #   SQLite event store (+ -wal, -shm)
  blobs/
    sha256/ab/cd/abcd…        #   content-addressed spill for >64 KiB payloads (immutable)
  captures/
    <sessionId>/<startedAt>.jsonl   # OPT-IN raw runtime event tee (P15) — files, never a table
  pi/
    sessions/                 #   Pi JSONL raw archive layer (SessionManager redirected here)
    auth.json                 #   Pi AuthStorage, 0600; Settings-managed API keys + OAuth tokens
  skills/                     #   Agena-managed skill packages; durable across image replacement
  raw-imports/
    claude/<machine-id>/<imported-at>/   # untouched import archives
    codex/<machine-id>/<imported-at>/
  snapshots/
    <snapshotId>.tar.zst      #   completed snapshots (immutable after rename)
    tmp/                      #   in-progress staging; swept at boot
    restore.journal           #   exists only while a restore is in flight
  logs/
    daemon.log
  daemon.pid

/workspace/                   # WORKSPACE — named volume "agena-ws-<workspaceId>"
  <repo / user files>         #   repo root IS the workspace root
  .agena/                     # user-authored extensibility (P20)
    config.json  environment.toml  tools/  skills/  hooks/
    .types/agena.d.ts         #   the ONE daemon-regenerated exception (documented carve-out, §12)

/home/agena/                  # USER ENVIRONMENT — named volume "agena-home-<workspaceId>"
  .config/                    #   gh and other non-provider CLI config/credentials
  .local/bin/                #   user-installed binaries
  .local/share/              #   pnpm, pipx, Go, and tool data
  .cargo/                    #   Cargo-installed tools
```

Consequences, all load-bearing:

- Snapshots capture `/workspace` and therefore mechanically exclude the DB, captures, Pi's JSONL, logs, and secrets — structural, not an exclude-list. Restore swaps files; session history is untouchable by it. (P1)
- All three roots are named Docker volumes; the container image is disposable, the volumes are not. `docker rm` + recreate loses nothing.
- `/home/agena` is private to the workspace and excluded from workspace snapshots/exports. `HOME`, XDG data/config, npm, pnpm, pipx, Cargo, and Go paths are pinned there; caches default to `/tmp/agena-cache` so rebuildable bytes do not grow durable storage without bound.
- `/workspace/.agena/environment.toml` is reproducible intent, not live package state. Its v1 grammar is deliberately only `[packages] system = ["debian-package", ...]`. Successful privileged `apt`/`apt-get` mutations update that list from `apt-mark showmanual`; the next workspace-image build uses the normalized list as a cached apt layer. Direct `/usr/bin/apt`, `dpkg -i`, `curl | sh`, and `/usr/local` mutations are not promised persistence.
- Pi's home is redirected into daemon state (`PI_DIR=/var/lib/agena/pi`, verified at boot), so Pi's raw JSONL archive layer exists without polluting the workspace or snapshots.
- **Provider credentials (decided):** Pi's `pi/auth.json` (`AuthStorage`, 0600) is the single persistent credential source for Settings-managed API keys and subscription OAuth tokens. Process env and the optional `config/secrets.env` remain supported deployment inputs and are reported only as configured credential sources; Agena never copies their values into responses. Pi owns file locking, OAuth refresh, and provider-scoped configuration. The file and optional input are excluded from snapshots by construction, redacted in logs/diagnostics, and never appear in SQLite, `/workspace`, event payloads, frames, or captures.
- **MCP credentials:** MCP definitions and import status are non-secret daemon state. Static API keys are imported only with explicit user consent and encrypted under `config/mcp-secrets.enc`; OAuth tokens are never copied from Claude or Codex. Agena starts a fresh authorization, owns that client registration and refresh-token family under `config/mcp-oauth/`, and persists every rotated refresh token before reuse. MCP secrets never enter SQLite, `/workspace`, renderer state, events, frames, captures, config responses, or logs.

## 3.4 Failure-mode stances (anticipated new problems)

| Scenario | Stance |
|---|---|
| **Concurrent clients prompting one session** | Per-session command serialization in the orchestrator. `prompt` while a turn is active ⇒ `error SESSION_BUSY` (hint: steer/followUp); `steer`/`followUp` allowed only during a turn (`TURN_NOT_ACTIVE` when idle). All clients see the identical `seq`-ordered stream. Approval responses are first-write-wins; losers get `APPROVAL_NOT_PENDING`. Legality matrix in §5.4. |
| **Daemon crash mid-generation** | Boot recovery pass (before accepting connections) closes every dangling `message.assistant.started`, `tool.call.started`, `run.started`, `approval.requested`, and `terminal.session.started` with the canonical crash payloads (§5.6). "Resume" = log intact, interrupted turn visibly marked, user re-prompts. In-flight tokens not committed before the crash are lost by design. |
| **Graceful shutdown (SIGTERM)** | Stop accepting commands → abort runtime turns → append `message.assistant.aborted {reason:"daemon_shutdown"}` with partial content → commit → close WSs with `1001` → exit. Budget fits `stop_grace_period: 30s`. |
| **WS backpressure under fast deltas** | Frames are droppable/coalescible per connection; durable events are never dropped — bounded backlog (16 MiB / 15 s stall) then close `4429`; client heals via `subscribe {fromSeq}` replay. |
| **Oversized payloads** | 64 KiB inline cap with blob spill (`BlobRef`), 128 KiB post-spill hard reject, 1 MiB envelope cap, edge caps on HTTP bodies. |
| **Malformed data** | Zod validation at every boundary; invalid Pi data → capture tee + warn, never appended raw. |
| **Container restart / volume persistence** | All three roots are named volumes; container is cattle. Losing `agena-state` loses history; losing `agena-home` loses user-installed tools and CLI logins — v1 mitigation: documented backup guidance; offsite backup post-v1. |
| **Secrets / provider keys** | §3.3 secrets stance. PTY shells do not inherit provider keys unless `pty.exposeProviderKeys: true`. |
| **Pi version churn** | Exact-version pin; recorded JSONL fixtures replayed through the `runtime-pi` mapper in CI; nightly canary vs `@latest`; upgrade playbook. (P16) |
| **Multi-workspace** | v1: one container = one workspace = one daemon = one event store. CLI profiles (`agena --profile <name>` → URL + token in `~/.config/agena/`) select daemons client-side. Boot-fatal `workspaceId` mismatch check catches mis-wired volumes. |
| **Project/cwd scope** | Within one workspace, sessions are scoped by project and cwd. The CLI derives the default scope from the host cwd mapped into `/workspace`; `--global` creates/list sessions not tied to a project; `--all-projects` is an explicit broad query. Runtime and PTY sessions start from the durable session cwd, never from a client-local guess. |

## 3.5 Glossary (normative)

- **Session** — the durable unit of agent work. ULID-identified, owned by the single workspace, independent of any client/process lifetime. Ordered event log (`seq` from 1), one or more branches; `status: active | idle | archived`; `source: native | claude | codex`.
- **Project** — a stable scope inside one workspace, normally a repo or folder. A project has a daemon-owned `projectId`, a display name, a workspace-relative root, and optional host-path hints used only by local CLI profile resolution. Project identity is durable; host absolute paths are not product truth.
- **Session cwd** — the workspace-relative directory where a session's runtime and PTYs start. It is stored on the session at creation and must stay inside the project root unless the session is explicitly global. A client may open from any host path, but commands execute from the durable session cwd.
- **Branch** — a line of history within a session: a column on every event plus a `branches` row with `parent_branch_id` and `forked_from_seq`. Every session has a root branch (`forked_from_seq` NULL).
- **Durable event** — an `AgenaEvent`: persisted, `seq`-numbered, versioned, provenance-attributed record of a semantic state change. Sufficient alone to rebuild correct UI state.
- **Ephemeral frame** — an `AgenaFrame`: live, non-persisted delta carrying `afterSeq`. Droppable and coalescible; never required for correctness.
- **Projection** — a derived read model (messages, tool_calls, FTS5) maintained inside the append transaction and rebuildable via `agena rebuild`. Dropped and rebuilt, never migrated.
- **Workspace** — `/workspace` inside the container: the filesystem the runtime, `agena shell`, and file APIs all share. What a snapshot captures and what later moves to the cloud.
- **Global session** — a native session with no project binding. It is hidden from project-local default listings and appears only under `--global`, `--all-projects`, or a direct `--session`.
- **Control session** — the singleton hidden session per workspace (created at first boot, excluded from default listings) that carries workspace-scoped durable events (`snapshot.*`, `workspace.initialized`) through the normal `appendEvents` path.
- **Snapshot** — a point-in-time `tar --zstd` capture of `/workspace` only. Restoring replaces workspace files and appends a durable event; it never modifies the event store.
- **Runtime adapter** — an implementation of core's `RuntimeAdapter`/`RuntimeSession` ports driving a concrete agent runtime. `runtime-pi` is the v1 adapter; `FakeRuntimeAdapter` is its test twin.
- **Daemon state** — everything under `/var/lib/agena` (§3.3). Survives container replacement; invisible to snapshots.
- **Turn** — one prompt→terminal-event cycle (user prompt through `message.assistant.completed|aborted|failed`). Used by concurrency rules and milestone tests.

---

# 4. Monorepo & Codebase Structure

## 4.1 Full tree

pnpm workspaces (`pnpm-workspace.yaml` globs `apps/*`, `packages/*`). Node ships the daemon; Bun (provisional, §18-OD1) compiles the CLI.

```text
agena/
├── package.json                    # root scripts: build, test, lint, typecheck, check:boundaries
├── pnpm-workspace.yaml
├── pnpm-lock.yaml                  # committed; CI uses --frozen-lockfile
├── .npmrc                          # save-exact=true, engine-strict=true
├── biome.json                      # single root config
├── tsconfig.base.json              # strict flags (§13.2); packages extend, never weaken
├── vitest.workspace.ts
├── .github/workflows/
│   ├── ci.yml                      # per-push pipeline (§13.4)
│   └── pi-canary.yml               # nightly: mapper fixtures vs latest Pi, allowed to fail
├── scripts/
│   ├── check-boundaries.mjs        # dependency-rule enforcement; CI-blocking
│   ├── record-fixture.ts           # promotes a raw capture JSONL to a scrubbed fixture (P15)
│   └── release.mjs                 # builds CLI binaries + daemon image
├── docker/
│   ├── Dockerfile                  # multi-stage daemon image (§10.2) — owned by §10
│   └── compose.yml                 # two NAMED volumes (no bind mounts); rendered per workspace (§10.3)
├── docs/
│   ├── architecture.md
│   ├── protocol.md                 # generated from packages/protocol schemas
│   └── decisions/                  # ADRs: 0001-pi-tui-first (P17), 0002-bun-cli-gate (P18),
│                                   #       0003-pi-extension-bridge-temporary (P20), 0004-share-parked (P9)
├── apps/
│   ├── cli/                        # the `agena` binary. Bun target, provisional (P18)
│   │   └── src/
│   │       ├── main.ts             # arg parse, profile resolution, command dispatch
│   │       ├── commands/           # default.ts (TUI), new.ts, resume.ts, sessions.ts, search.ts,
│   │       │                       # shell.ts, files.ts, snapshot.ts, approvals.ts, approve.ts,
│   │       │                       # import.ts, info.ts, rebuild.ts, workspace.ts, login.ts
│   │       ├── shell/              # raw-mode passthrough, resize propagation, exit restore
│   │       └── config/             # ~/.config/agena profile/credential/cursor IO
│   └── daemon/                     # Node daemon; runs in the container
│       ├── src/
│       │   ├── main.ts             # entry: env → config → bootstrap() → serve
│       │   ├── bootstrap.ts        # composition root (§9.2)
│       │   ├── config.ts           # Zod-validated DaemonConfig, env overlay
│       │   ├── paths.ts            # THE only module building /var/lib/agena paths (§3.3)
│       │   ├── server.ts           # Node http.Server + Hono app + WS upgrade router
│       │   ├── http/               # middleware/{auth,limits,errors}.ts; routes/{health,sessions,
│       │   │                       #   files,snapshots,ptys,blobs,imports,approvals,admin,diagnostics}.ts
│       │   ├── ws/                 # gateway.ts, connection.ts (backpressure), replay.ts, coalesce.ts
│       │   ├── pty/                # manager.ts (node-pty), attach.ts (binary WS bridge)
│       │   ├── importers/          # claude.ts / codex.ts / common.ts — raw archive → normalize → summarize
│       │   ├── extensibility/      # .agena/ discovery host + module-alias loader (§12)
│       │   ├── observability/      # logger.ts (pino + redaction), diagnostics.ts
│       │   ├── shutdown.ts         # SIGTERM drain sequence (§9.7)
│       │   └── recovery.ts         # boot-time crash recovery scan (§9.8)
│       └── test/
│           ├── integration/        # real WS + real SQLite (tmpdir) + FakeRuntime
│           └── e2e/                # spawned daemon driven via @agena/client (P16)
├── packages/
│   ├── protocol/                   # @agena/protocol — THE contract; imports zod only
│   │   └── src/
│   │       ├── index.ts / version.ts   # PROTOCOL_VERSION (integer), MIN_SUPPORTED
│   │       ├── envelope.ts         # WireEnvelope discriminated union (§5.2)
│   │       ├── commands.ts         # ClientCommand catalog + ack result schemas (§5.4)
│   │       ├── events/             # one module per domain (session, branch, message, run, tool,
│   │       │                       #   model, compaction, approval, terminal, snapshot, workspace,
│   │       │                       #   import, runtime) + events/index.ts registries
│   │       ├── frames.ts           # ephemeral frame catalog (§5.7)
│   │       ├── content.ts          # ContentBlock union, BlobRef, size limits
│   │       ├── snapshot.ts         # wire InFlightSnapshot (§5.8)
│   │       ├── errors.ts           # AgenaError, ErrorCode enum, WS close codes (§5.9)
│   │       ├── http.ts             # request/response Zod schemas + the authoritative route table (§9.3)
│   │       ├── pty.ts              # PTY control-frame schemas (resize/exit)
│   │       ├── upcasts.ts          # per-event-type upcast chains
│   │       └── limits.ts           # wire limits (mirrors §3.2 constants)
│   ├── core/                       # @agena/core — domain logic + the ports (P11)
│   │   └── src/
│   │       ├── runtime/types.ts    # RuntimeAdapter, RuntimeSession, RuntimeEvent,
│   │       │                       #   RuntimeInFlightSnapshot (defined HERE)
│   │       ├── events/store.ts     # EventStore port + AppendEventsInput/Result (defined HERE)
│   │       ├── events/reducers.ts  # pure projection reducers shared by live append + rebuild (P7)
│   │       ├── sessions/           # SessionOrchestrator/SessionRegistry, per-session serialization
│   │       ├── replay/             # branch-chain replay helpers (P10)
│   │       ├── approvals/          # pending-approval state machine (P14)
│   │       ├── workspaces/resolve-path.ts   # the single file-API path gate (§10.6)
│   │       ├── extensibility/      # defineTool/defineSkill/defineHook + descriptor discovery (P20)
│   │       ├── memory-store.ts     # InMemoryEventStore: M1 store AND permanent test double (P8)
│   │       ├── ids.ts / clock.ts   # ULID generation, injectable clock
│   │       └── testing/            # FakeRuntimeAdapter (P16); subpath export @agena/core/testing
│   ├── runtime-pi/                 # @agena/runtime-pi — the ONLY package importing the Pi SDK
│   │   ├── src/
│   │   │   ├── index.ts            # exports PiRuntimeAdapter, PI_SDK_VERSION
│   │   │   ├── adapter.ts          # session registry, hydrate/evict, dispose
│   │   │   ├── session.ts          # PiRuntimeSession: lifecycle, control methods, event pump
│   │   │   ├── event-map.ts        # PURE (MapperState, PiEvent) -> RuntimeEvent[]; the churn firewall
│   │   │   ├── correlation.ts      # ULID minting, echo suppression, pi-id ↔ agena-id maps
│   │   │   ├── inflight.ts         # mirror buffer + RuntimeInFlightSnapshot builder
│   │   │   ├── approvals.ts        # extension_ui_request bridge, pending-resolver registry (P14)
│   │   │   ├── tools.ts            # AgenaToolDescriptor -> Pi defineTool bridge
│   │   │   ├── bridge-extension.ts # "agena-bridge" Pi extension — INTERNAL + TEMPORARY (P20)
│   │   │   ├── capture.ts          # opt-in raw JSONL tee writer with rotation (P15) — owned HERE
│   │   │   └── versions.ts         # PI_SDK_VERSION + UPGRADING.md pointer
│   │   └── test/fixtures/pi/<pi-version>/<scenario>.jsonl (+ .expected.json)
│   ├── storage-sqlite/             # @agena/storage-sqlite — implements core's EventStore
│   │   └── src/
│   │       ├── schema.ts           # Drizzle tables (DDL: §7)
│   │       ├── store.ts            # SqliteEventStore: appendEvents tx (§7.5)
│   │       ├── projections/        # executes core's reducer ops incl. explicit FTS writes (P7)
│   │       ├── rebuild.ts          # drop + rebuild ALL projections INCLUDING messages_fts (P7)
│   │       ├── blobs.ts            # >64 KiB payload spill to content-addressed files
│   │       └── migrations/
│   ├── client/                     # @agena/client — typed SDK; depends on protocol only
│   │   └── src/
│   │       ├── client.ts           # AgenaClient facade
│   │       ├── socket.ts           # AgenaSocket: multiplexed WS, reconnect, requestId correlation
│   │       ├── subscription.ts     # SessionSubscription: cursor, replay, gap healing
│   │       ├── http.ts             # typed fetch bound to protocol http.ts schemas
│   │       ├── shell.ts            # ShellConnection: dedicated PTY WS client
│   │       ├── transport/ws.ts     # Bun WebSocket vs `ws` on Node (the only Bun-specific file)
│   │       ├── state.ts            # cursor/config file IO (used by apps/cli)
│   │       └── errors.ts
│   └── tui/                        # @agena/tui — pi-tui frontend (P17); depends on client + protocol
│       └── src/
│           ├── app.ts              # composition root, focus, embedded shell split wiring
│           ├── store/              # PURE reducers: AgenaEvent/AgenaFrame → view state
│           ├── views/              # SessionView, SessionPicker, ApprovalModal, Palette, StatusBar
│           ├── components/         # MessageBlock, ToolCallBlock, InProgressTail, Toast
│           ├── renderer/           # ALL pi-tui imports live here
│           ├── keymap.ts
│           └── shell-bridge.ts
```

## 4.2 Dependency rules (P11) — mechanically enforced

Allowed edges — anything not listed is forbidden:

| Package | May depend on (workspace) | External notes |
|---|---|---|
| `@agena/protocol` | — (nothing internal) | zod only |
| `@agena/core` | protocol | Defines `RuntimeAdapter`, `RuntimeSession`, `RuntimeEvent`, `EventStore` ports. No Pi, no SQLite, no HTTP. |
| `@agena/runtime-pi` | core, protocol | **Only** package importing `@earendil-works/pi-coding-agent` / `pi-ai` / `pi-agent-core`. Implements core's ports. |
| `@agena/storage-sqlite` | core, protocol | Implements core's `EventStore`. Drizzle + better-sqlite3. |
| `@agena/client` | protocol | No core import — clients never see domain internals. |
| `@agena/tui` | client, protocol | **Only** package importing `@earendil-works/pi-tui`. |
| `apps/daemon` | core, protocol, runtime-pi, storage-sqlite | Composition root; Hono, node-pty live here. |
| `apps/cli` | client, tui, protocol | Never imports core, storage, or runtime-pi. |

`scripts/check-boundaries.mjs` runs in CI and fails the build if (a) any `package.json` declares a workspace dependency outside this table, or (b) a source grep finds `@earendil-works/pi-coding-agent|pi-ai|pi-agent-core` outside `packages/runtime-pi`, `@earendil-works/pi-tui` outside `packages/tui`, `drizzle|better-sqlite3` outside `packages/storage-sqlite`, or `node-pty` outside `apps/daemon`.

## 4.3 Naming conventions (binding)

- Durable events and frames: `dot.case` `domain.entity.action` — `message.assistant.completed`, `tool.call.failed`, `message.assistant.text.delta`.
- Commands: `camelCase` verbs — `prompt`, `respondToApproval`.
- Core `RuntimeEvent` variants: kebab-case (`assistant-text-delta`) — visibly distinct from wire names.
- All ids (`sessionId`, `branchId`, `messageId`, `toolCallId`, `approvalId`, `terminalId`, `snapshotId`, `requestId`, `clientId`, `runId`) are ULIDs. Event identity **on the wire** is the pair `(sessionId, seq)` — the wire `AgenaEvent` has no id field; storage keeps an internal ULID `id` column (never serialized) for importer dedupe and debugging.
- Timestamps: ISO-8601 UTC strings with millisecond precision.

---

# 5. Wire Protocol

`packages/protocol` is the load-bearing package: it imports nothing internal (only `zod`), and every other package compiles against it. **It is the sole owner of**: the envelope union, the command catalog, the durable-event and frame registries, error codes, WS close codes, the PTY control-frame schemas, the wire `InFlightSnapshot`, and (via `http.ts`) the authoritative HTTP route schemas. The daemon and client sections describe behavior only; every name they use is defined here.

`events/index.ts` exports the two registries the daemon and clients both use:

```ts
export const durableEventSchemas: Record<DurableEventType, z.ZodTypeAny>;  // DURABLE_EVENT_TYPES
export const frameSchemas: Record<FrameType, z.ZodTypeAny>;               // FRAME_TYPES
```

## 5.1 Versioning & handshake

Two independent version axes:

1. **Protocol version** — one integer `PROTOCOL_VERSION` (v1 ships `1`) covering envelope, commands, frames. Negotiated at connect time on the WS; HTTP relies on the same welcome-time check (there is **no per-request `X-Agena-Protocol` header enforcement in v1** — one client, one version; the header check returns when a second client version exists).
2. **Payload version** — the per-event `v` integer, handled by `upcasts.ts` (§5.10).

**Connect sequence** (main channel `GET /v1/ws`, subprotocol `agena.v1`):

1. Client opens the WS with `Authorization: Bearer <token>` on the upgrade request (the only auth path for both WS types; there is no first-message token variant). Auth is checked **before** the handshake completes — failure is a refused upgrade (raw HTTP `401`, per §9.4; no WS close code is ever observable).
2. The **client sends `hello` first**. Any other envelope before `welcome` → error `NOT_READY`, then close `4400` on repeat. No `hello` within 10 s → close `4408`.
3. Daemon replies `welcome` (or `error` + close `4400`).

```ts
type HelloEnvelope = {
  kind: "hello";
  protocolVersion: number;          // client's integer PROTOCOL_VERSION
  client: { name: string; version: string; platform: string };
  clientId: string;                 // stable ULID per installed client, persisted locally;
                                    // becomes EventSource.clientId on user-issued events (P3)
};

type WelcomeEnvelope = {
  kind: "welcome";
  protocolVersion: number;          // daemon's PROTOCOL_VERSION
  daemonVersion: string;
  serverTime: string;
  limits: WireLimits;               // maxEnvelopeBytes, maxPromptBytes, maxSubscriptions
};
```

Compatibility: proceed iff `MIN_SUPPORTED_PROTOCOL_VERSION <= client.protocolVersion <= daemon.PROTOCOL_VERSION`; mismatch → `error PROTOCOL_MISMATCH` (both versions + human hint), close `4400`. CLI exit code 7. *(Reserved, not implemented in v1: `welcome.capabilities` feature list and `SubscribeCmd.includeFrames` — names are reserved so nobody repurposes them, but no v1 code gates on them.)*

## 5.2 WireEnvelope

Every JSON message on the main WS is one `WireEnvelope`. Terminal PTY bytes are never on this socket (P5).

```ts
type WireEnvelope =
  | HelloEnvelope                                   // client -> daemon, first message only
  | WelcomeEnvelope                                 // daemon -> client, handshake reply
  | { kind: "cmd";  requestId: string; name: CommandName; payload: unknown }   // client -> daemon
  | { kind: "ack";  requestId: string; result?: unknown }                      // daemon -> client
  | { kind: "error"; requestId?: string; error: AgenaError }                   // daemon -> client
  | { kind: "event"; event: AgenaEvent; replayed: boolean }                    // durable, seq order
  | { kind: "frame"; frame: AgenaFrame }                                       // ephemeral
  | { kind: "sync"; sessionId: string; branchId: string; upToSeq: number }     // end-of-replay marker
  | { kind: "snapshot"; snapshot: InFlightSnapshot }                           // in-flight state after sync
  | { kind: "ping"; ts: string }                                               // daemon -> client, 15 s
  | { kind: "pong"; ts: string };
```

There is **no** `caughtUp`, `replay.start`, `replay.end`, or `notice` envelope — earlier drafts' variants are superseded by `sync` + `snapshot`, and "daemon restarting" UX is keyed off close code `1001`.

Rules:

- **requestId correlation (P13):** every `cmd` carries a client-minted ULID `requestId` and receives exactly one terminal `ack` or `error`. Acks for state-changing commands are sent only after their durable events commit. The daemon keeps a **connection-independent dedupe map** `requestId → {result | error}` with a 5-minute TTL: a re-sent `requestId` (same or new connection) is re-acked from the map without re-execution. This is the single retry mechanism — there is no separate `idempotencyKey` field and no `DUPLICATE_REQUEST_ID` error. Client SDKs re-send unacked commands with their **original** requestId after reconnect and enforce a 30 s per-command timeout.
- `event` envelopes for a session are delivered in strict `seq` order, gap-free, per subscription. `replayed: true` marks replay so the TUI renders history without animation.
- `frame` envelopes are ordered relative to the durable stream by `afterSeq` and may be dropped or coalesced under backpressure (§6.4).
- Malformed inbound data: unparseable JSON → `error INVALID_PAYLOAD` (no requestId); >5 malformed messages per connection → close `4400`. Parseable `cmd` with invalid payload → `error INVALID_PAYLOAD` with the Zod issue list.
- Oversized inbound envelopes (> 1 MiB) → `error PAYLOAD_TOO_LARGE`; repeated → close `4413`.
- Liveness: daemon pings every 15 s; two missed pongs → close `1001`. Clients do not ping; a client seeing no ping for 45 s treats the socket as dead and reconnects.

## 5.3 AgenaEvent

```ts
type AgenaEvent<TType extends DurableEventType = DurableEventType, TPayload = unknown> = {
  sessionId: string;
  branchId: string;
  seq: number;                // per-session monotonic, assigned inside the append tx
  type: TType;                // dot.case
  v: number;                  // payload schema version for this type
  payload: TPayload;
  createdAt: string;
  source: EventSource;        // INV-9 shape; queryable columns in DDL (P3)
};
```

**Binding requirement on storage (P3):** the `events` table carries explicit columns `source_kind TEXT NOT NULL`, `source_runtime TEXT`, `source_client_id TEXT`. The wire event has no `id` field; storage's internal `id` column is never serialized.

### Content model & payload size

```ts
type BlobRef = {
  blob: `sha256:${string}`;   // content address
  sizeBytes: number;
  mimeType?: string;
  preview?: string;           // optional short text preview for lazy-fetch UX
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; toolCallId: string; name: string; args: unknown }
  | { type: "image"; ref: BlobRef; alt?: string }
  | { type: "file"; ref: BlobRef; path?: string };
```

This is the **only** BlobRef shape (the `$blob`-wrapped and `{blob,size,mediaType}` variants from earlier drafts are dead). No durable payload exceeds 64 KiB inline: the append path spills oversized spillable fields to `/var/lib/agena/blobs/` and stores a `BlobRef`; clients fetch via `GET /v1/blobs/:hash`. Post-spill payloads still over 128 KiB are rejected `PAYLOAD_TOO_LARGE` (§7.7).

## 5.4 Client command catalog

The complete WS command set — daemon and client implement exactly these names and payloads. Session/branch lifecycle (create, resume, fork, archive, list) and blob fetch are HTTP (§9.3), not WS commands.

| Command | Legal when | Ack result | Emits (durable) | Errors |
|---|---|---|---|---|
| `subscribe` | always | `{ lastSeq, branchId, replayCount }` | — | `SESSION_NOT_FOUND`, `SUBSCRIPTION_LIMIT`, `ALREADY_SUBSCRIBED` |
| `unsubscribe` | always | `{}` | — | `NOT_SUBSCRIBED` |
| `prompt` | idle only | `{ messageId, seq }` | `message.user.created` (then runtime events) | `SESSION_BUSY`, `SESSION_READ_ONLY`, `PAYLOAD_TOO_LARGE` |
| `steer` | active turn only | `{ messageId, seq }` | `message.user.created {queued:"steer"}` | `TURN_NOT_ACTIVE`, `SESSION_READ_ONLY` |
| `followUp` | active turn only | `{ messageId, seq }` | `message.user.created {queued:"followUp"}` | `TURN_NOT_ACTIVE`, `SESSION_READ_ONLY` |
| `abort` | always on native sessions (idempotent; no-op ack when idle) | `{}` | `message.assistant.aborted` + `tool.call.aborted` + `run.aborted` | `SESSION_READ_ONLY` |
| `setModel` | idle only (v1 keeps mid-generation switches off the table) | `{ model }` | `model.changed` | `SESSION_BUSY`, `MODEL_UNAVAILABLE`, `SESSION_READ_ONLY` |
| `setThinkingLevel` | idle only | `{ thinkingLevel }` | `thinking.level.changed` | `SESSION_BUSY`, `INVALID_PAYLOAD`, `SESSION_READ_ONLY` |
| `respondToApproval` | approval pending; first-write-wins | `{ approvalId }` | `approval.responded` | `APPROVAL_NOT_PENDING`, `APPROVAL_NOT_FOUND` |
| `compact` | idle only | `{ compactionSeq }` | `compaction.created` | `SESSION_BUSY`, `SESSION_READ_ONLY` |

This legality matrix is the one statement of per-command concurrency policy (`followUp` when idle is **rejected** with `TURN_NOT_ACTIVE` — use `prompt`; earlier drafts' "followUp anytime" is dead). Payloads:

```ts
type SubscribeCmd  = { sessionId: string; fromSeq: number; branchId?: string };
// fromSeq is EXCLUSIVE: replay returns seq > fromSeq; fromSeq = 0 replays everything.
// One subscription per (connection, sessionId); resubscribe requires unsubscribe first.
type UnsubscribeCmd = { sessionId: string };
type PromptCmd     = { sessionId: string; content: ContentBlock[] };
type SteerCmd      = { sessionId: string; content: ContentBlock[] };
type FollowUpCmd   = { sessionId: string; content: ContentBlock[] };
// v1: prompt/steer/followUp content is restricted to {type:"text"} blocks (schema-enforced;
// any other block type is rejected INVALID_PAYLOAD). Core concatenates the text blocks into
// the RuntimeSession port's `text` (§8.2). Widening to other block types is a v2 concern.
type AbortCmd      = { sessionId: string; reason?: string };
type SetModelCmd   = { sessionId: string; model: { provider: string; id: string } };
type SetThinkingLevelCmd = { sessionId: string; level: "off"|"minimal"|"low"|"medium"|"high"|"xhigh" };
type RespondToApprovalCmd = {
  sessionId: string;
  approvalId: string;
  response:
    | { kind: "confirm"; accepted: boolean }
    | { kind: "select"; optionId: string }
    | { kind: "input"; value: string }
    | { kind: "editor"; value: string };
};
type CompactCmd    = { sessionId: string; instructions?: string };
```

**Concurrent clients (decided):** the daemon serializes commands per session. If a turn is active, `prompt` from *any* client fails `SESSION_BUSY` (hint: steer/followUp). All subscribed clients see every durable event regardless of who issued it; `source.clientId` attributes it. `respondToApproval` is first-response-wins: losers get `APPROVAL_NOT_PENDING` and, having already received the `approval.responded` event, render the resolved state. Sessions with `source != 'native'` (imported) reject all mutating commands with `SESSION_READ_ONLY`.

## 5.5 Durable event catalog (complete, v1)

Every payload is `v: 1`. This registry is exhaustive — `appendEvents` rejects any type not listed (P12), and a CI conformance test asserts every event name appearing in the Pi mapping table (§8.4) exists here.

### session.*

```ts
// session.created — source: user (native) | importer | daemon (control session)
type SessionCreated = {
  workspaceId: string;
  title?: string;
  runtime: "pi";
  origin: "native" | "import.claude" | "import.codex" | "control";
  scope: "project" | "global" | "control";
  projectId?: string;          // required when scope === "project"
  projectRoot?: string;        // workspace-relative, e.g. "." or "apps/api"
  cwd?: string;                // workspace-relative runtime cwd
  hostCwdHint?: string;        // diagnostics only; never used by daemon execution
  rootBranchId: string;
};
type SessionTitleChanged  = { title: string; previousTitle?: string };
type SessionStatusChanged = { status: "active" | "idle" | "archived"; previous: string };
// Archiving is session.status.changed {status:"archived"} — there is NO session.archived type.
```

### branch.*

```ts
type BranchCreated  = { branchId: string; parentBranchId?: string; forkedFromSeq?: number; name?: string };
type BranchSwitched = { fromBranchId: string; toBranchId: string };
```

### run.* (durable — anchors P2 crash repair and dispatch failures)

```ts
type RunStarted   = { runId: string; trigger: "prompt" | "steer" | "followUp"; triggerMessageId: string };
type RunCompleted = { runId: string; usage?: UsageTotals };
type RunAborted   = { runId: string; reason: "user_abort" | "daemon_shutdown" };
type RunFailed    = {
  runId: string;
  error: { code: string; message: string };     // code "daemon_restart" from the boot sweep
  phase?: "dispatch";                           // set when prompt/steer/followUp dispatch failed
  triggerMessageId?: string;                    // set for dispatch failures: which user message it orphans
};
```

### message.*

```ts
type MessageUserCreated = {
  messageId: string;
  content: ContentBlock[];
  queued?: "steer" | "followUp";   // absent for a plain prompt
};
type MessageAssistantStarted = {
  messageId: string;
  runId: string; turnId: string;   // replay grouping without durable turn events
  model: { provider: string; id: string };
  inResponseTo: string;            // user messageId
};
type MessageAssistantCompleted = {
  messageId: string;
  content: ContentBlock[];
  model: { provider: string; id: string };
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
};
// ---- P2 canonical terminal payloads (the ONLY spellings; used verbatim by runtime, store,
// ---- daemon shutdown, and boot recovery) ----
type MessageAssistantAborted = {
  messageId: string;
  partialContent: ContentBlock[];  // from the in-flight snapshot; [] if nothing streamed
  reason: "user_abort" | "daemon_shutdown";
};
type MessageAssistantFailed = {
  messageId: string;
  partialContent: ContentBlock[];  // [] when lost (crash case)
  error: { code: string; message: string };   // code: "daemon_restart" | "runtime_error" | provider codes
  recovered?: boolean;             // true when appended by boot-time recovery
};
// message.runtime.created — generic runtime-surfaced non-assistant message; collapses Pi's
// CustomMessage / BashExecutionMessage / BranchSummaryMessage into ONE type
type MessageRuntimeCreated = {
  messageId: string;
  runtimeType: "custom" | "bash" | "branch-summary";
  role?: string;
  content: ContentBlock[];
  meta?: { command?: string; exitCode?: number | null; customType?: string };
};
```

### tool.*

The tool terminal set is `completed | failed | aborted | denied` — the taxonomy: `failed` = runtime/tool error, `aborted` = interruption (user abort, shutdown, crash) with partial output, `denied` = approval refused. (`tool.call.interrupted` and `tool.call.failed{code:"interrupted"}` from earlier drafts are dead.)

```ts
type ToolCallStarted = {
  toolCallId: string; messageId: string; runId: string; turnId: string;
  name: string; args: unknown;                 // blob-spilled like all payloads
  runtimeToolCallId?: string;                  // Pi's own id, for raw-layer cross-referencing
};
type ToolCallCompleted = { toolCallId: string; result: ContentBlock[]; durationMs: number };
type ToolCallFailed    = { toolCallId: string; error: { code: string; message: string };
                           partialOutput?: ContentBlock[]; durationMs?: number };
type ToolCallAborted   = { toolCallId: string; partialOutput: ContentBlock[];   // [] in crash case
                           reason: "user_abort" | "daemon_shutdown" | "daemon_restart" | "runtime_error" };
type ToolCallDenied    = { toolCallId: string; approvalId?: string;
                           reason: "user_denied" | "approval_expired" | "policy" | "hook_denied" };
```

### model.* / thinking.*

```ts
type ModelChanged = { from?: { provider: string; id: string }; to: { provider: string; id: string };
                      reason: "user_selected" | "fallback" | "auto" };
type ThinkingLevelChanged = { from: string; to: string };   // the ONE name (model.thinking.changed is dead)
```

### compaction.*

```ts
type CompactionCreated = {
  compactionId: string;            // minted by core at compaction_end
  summary: ContentBlock[];         // core wraps the runtime's summary string into [{type:"text",…}]
  replacesUpToSeq: number;         // core stamps: last committed seq at compaction start
  tokensBefore?: number; tokensAfter?: number;
  trigger: "user" | "auto";
};
type CompactionFailed = { compactionId: string; error: { code: string; message: string } };
```

Compaction affects context assembly, never the log — replay shows full history; renderers may collapse the summarized range.

### approval.* (P14)

Pi's `extension_ui_request/response` are mapped inside `runtime-pi` and never leak to clients.

```ts
type ApprovalRequested = {
  approvalId: string;
  kind: "confirm" | "select" | "input" | "editor";
  title?: string; message: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  defaultValue?: string;
  toolCallId?: string;             // set when gating a tool call
  expiresAt?: string;              // absent = no timeout (v1 default: none)
};
type ApprovalResponded = { approvalId: string; response: RespondToApprovalCmd["response"];
                           respondedBy: string /* == EventSource.clientId of the winner */ };
type ApprovalExpired   = { approvalId: string };
type ApprovalCancelled = { approvalId: string;
                           reason: "turn_aborted" | "daemon_shutdown" | "daemon_restart" | "runtime_cancelled" };
```

Pending-approval invariant: pending iff `approval.requested` has no terminal sibling. Durable events survive reconnect by construction; the in-flight snapshot additionally restates `pendingApprovals`.

### terminal.*

```ts
type TerminalSessionStarted = { terminalId: string; shell: string; cols: number; rows: number;
                                startedBy: string /* clientId */ };
type TerminalSessionEnded   = { terminalId: string; exitCode: number | null;
                                reason?: "exit" | "killed" | "daemon_restart"; durationMs?: number };
```

(`terminal.pty.opened/closed` from the daemon draft are dead.) Emitted only for PTYs with a `sessionId` association; standalone PTYs produce no durable events.

### snapshot.* / workspace.* (appended to the workspace control session)

```ts
type SnapshotCreated = {
  snapshotId: string; workspaceId: string; name?: string;
  kind: "manual" | "auto" | "pre_tool" | "pre_restore";
  storage: { backend: "tar"; path: string; sha256: string; sizeBytes: number }   // "git" backend reserved
          | { backend: "git"; ref: string };
  fileCount?: number;
  triggeredBySessionId?: string;
};
type SnapshotRestored      = { snapshotId: string; safetySnapshotId: string; triggeredBySessionId?: string };
type SnapshotRestoreFailed = { snapshotId: string; safetySnapshotId?: string;
                               error: { code: string; message: string } };
type SnapshotDeleted       = { snapshotId: string };
type WorkspaceInitialized  = { workspaceId: string; name: string; seeded: "git" | "local" | "empty" };
```

(`workspace.snapshot.restored` is dead; the name is `snapshot.restored` everywhere.)

### import.* / runtime.*

```ts
type ImportSummaryCreated = {
  importId: string; sourceRef: string;
  summary: { title: string; goal?: string; keyFiles: string[]; commands: string[];
             models: string[]; openTodos: string[]; continuationPrompt: string };
};
type RuntimeExtensionFailed = { extensionRef: string; error: { code?: string; message: string } };
```

### Reserved (named, never emitted in v1)

`share.link.created` (P9 — parked), `terminal.output.recorded`, `workspace.file.changed` (v1.1 fs-watcher; `EventSource.kind:"filesystem"` exists today for it).

## 5.6 The terminal-event matrix (P2, canonical)

One table; every writer (runtime adapter, orchestrator, shutdown, boot recovery) quotes these payloads verbatim. Reason spellings are exactly `user_abort`, `daemon_shutdown`, `daemon_restart`, `runtime_error` — no other spelling exists.

| Cause \ entity | assistant message | tool call | run | approval | terminal |
|---|---|---|---|---|---|
| **User abort** | `message.assistant.aborted {partialContent, reason:"user_abort"}` | `tool.call.aborted {partialOutput, reason:"user_abort"}` | `run.aborted {reason:"user_abort"}` | `approval.cancelled {reason:"turn_aborted"}` | — |
| **Runtime error mid-stream** | `message.assistant.failed {partialContent, error:{code:"runtime_error",…}}` | `tool.call.aborted {reason:"runtime_error"}` (open tools) / `tool.call.failed` (the erroring tool) | `run.failed {error}` | `approval.cancelled {reason:"runtime_cancelled"}` | — |
| **Graceful shutdown (SIGTERM)** | `message.assistant.aborted {partialContent, reason:"daemon_shutdown"}` | `tool.call.aborted {partialOutput, reason:"daemon_shutdown"}` | `run.aborted {reason:"daemon_shutdown"}` | `approval.cancelled {reason:"daemon_shutdown"}` | `terminal.session.ended {exitCode:null, reason:"killed"}` |
| **Hard crash (boot recovery, source {kind:"daemon"})** | `message.assistant.failed {partialContent: [], error:{code:"daemon_restart", message}, recovered:true}` | `tool.call.aborted {partialOutput: [], reason:"daemon_restart"}` | `run.failed {error:{code:"daemon_restart"}}` | `approval.cancelled {reason:"daemon_restart"}` | `terminal.session.ended {exitCode:null, reason:"daemon_restart"}` |

Graceful cases carry real partial content from the in-flight mirror; the crash case carries `[]` (deltas are never persisted — P12). A fixture test feeds every recovery payload through the protocol schemas (they must validate, or recovery boot-loops — the exact failure the reviews flagged).

## 5.7 Ephemeral frame catalog (P12)

Frames carry `afterSeq` (highest committed seq at emit time), are never persisted, and are droppable/coalescible. This is the complete v1 list (merged; `tool.output.delta` and `status.transient` are dead — the spellings below are the only ones):

```ts
type AgenaFrame<TType extends FrameType = FrameType, TPayload = unknown> = {
  type: TType; sessionId: string; branchId: string; afterSeq: number;
  payload: TPayload; emittedAt: string;
};
```

| Frame | Payload | Notes |
|---|---|---|
| `message.assistant.text.delta` | `{messageId, blockIndex, delta}` | coalesce by concat |
| `message.assistant.thinking.delta` | `{messageId, blockIndex, delta}` | coalesce by concat; first dropped |
| `message.assistant.toolcall.delta` | `{messageId, blockIndex, delta}` | partial JSON args text |
| `message.assistant.block.started` | `{messageId, blockIndex, blockType}` | |
| `message.assistant.block.ended` | `{messageId, blockIndex}` | |
| `tool.call.output.delta` | `{toolCallId, delta, reset?: boolean}` | suffix-diffed; `reset:true` = replace |
| `turn.started` / `turn.ended` | `{runId, turnId, index?/usage?}` | turn boundaries are frames, not events |
| `session.status.updated` | `{state: "idle"\|"thinking"\|"generating"\|"tool_running"\|"compacting"\|"retrying"\|"custom", detail?}` | keep-latest; also carries extension setStatus (`state:"custom"`) |
| `session.queue.updated` | `{steerCount, followUpCount}` | keep-latest |
| `session.notice` | `{level: "info"\|"warn"\|"error", text}` | extension notify, model-fallback notes |
| `session.widget.updated` | `{widget: unknown \| null}` | keep-latest |
| `compaction.started` | `{trigger}` | "Compacting…" indicator |
| `run.retry.started` / `run.retry.ended` | `{runId, attempt, maxAttempts, delayMs, errorSummary}` / `{runId, outcome}` | |

Frame rules: frames are pure animation over durable truth — the terminal durable event carries the authoritative full content and replaces any client-accumulated buffer. A renderer starting mid-message waits for the snapshot/terminal event rather than guessing. No terminal-byte frames on this channel (P5); `terminal.output.chunk` is reserved future/optional.

## 5.8 Reconnect contract & wire InFlightSnapshot

The client persists, per `(sessionId, branchId)`, the last durable `seq` applied. On (re)connect:

```text
1. WS connect + hello/welcome
2. cmd subscribe { sessionId, fromSeq: lastSeq, branchId }
3. <- ack { lastSeq: <daemon head seq>, branchId, replayCount }
4. <- event* (replayed: true)   branch-lineage-filtered, seq > fromSeq, strict order, chunked (~500)
5. <- sync { sessionId, branchId, upToSeq }
6. <- snapshot { … }            ALWAYS sent (assistant/toolCalls null when idle; pendingApprovals may be non-empty)
7. <- event*/frame*             live tail (fanout-after-commit ordering)
```

```ts
// packages/protocol/src/snapshot.ts — the WIRE shape. Core's richer runtime-facing
// RuntimeInFlightSnapshot (§8.2) is mapped into this by core at subscribe time.
type InFlightSnapshot = {
  sessionId: string; branchId: string;
  afterSeq: number;                          // == sync.upToSeq
  assistant: {
    messageId: string;
    model: { provider: string; id: string };
    blocks: ContentBlock[];                  // partial content accumulated so far
  } | null;
  toolCalls: Array<{ toolCallId: string; name: string; args: unknown; partialOutput?: string }>;
  pendingApprovals: ApprovalRequested[];     // full payloads (core joins pendingApprovalIds with
                                             // the durable approval.requested payloads)
  retry: { attempt: number; maxAttempts: number; nextAttemptAt: string } | null;
  queue: { steerCount: number; followUpCount: number };
  status: { state: string; detail?: string };   // matches session.status.updated shape
};
```

Failure handling: **gap detection** — an event with `seq > lastApplied + 1` triggers silent unsubscribe + resubscribe `{fromSeq: lastApplied}` (post-commit seq-ordered fanout guarantees replay fills it exactly). Duplicates (`seq <= lastApplied`) are dropped; apply is idempotent by seq. Frames before `sync` are discarded defensively. Fresh devices subscribe `fromSeq: 0`, or page `GET /v1/sessions/:id/events` first and subscribe from the last loaded seq — replay and cold read return identical `AgenaEvent` shapes. Milestone 1 backs this identical contract with `InMemoryEventStore` (P8).

## 5.9 Error model & close codes (single registry)

```ts
type AgenaError = { code: ErrorCode; message: string; retryable: boolean; details?: unknown };

type ErrorCode =
  | "UNAUTHORIZED" | "PROTOCOL_MISMATCH" | "NOT_READY" | "TIMEOUT"
  | "INVALID_PAYLOAD" | "PAYLOAD_TOO_LARGE"
  | "SESSION_NOT_FOUND" | "SESSION_BUSY" | "SESSION_READ_ONLY" | "TURN_NOT_ACTIVE"
  | "ALREADY_SUBSCRIBED" | "NOT_SUBSCRIBED" | "SUBSCRIPTION_LIMIT"
  | "APPROVAL_NOT_PENDING" | "APPROVAL_NOT_FOUND"
  | "MODEL_UNAVAILABLE" | "RUNTIME_UNAVAILABLE" | "DAEMON_SHUTTING_DOWN"
  | "CONFLICT" | "NOT_FOUND" | "PATH_ESCAPES_WORKSPACE" | "PRECONDITION_FAILED"
  | "RATE_LIMITED" | "INSUFFICIENT_STORAGE" | "INTERNAL";
```

The same `AgenaError` shape is the HTTP error body. Dead code names from drafts: `E_*` anything, `VALIDATION_FAILED` (→ `INVALID_PAYLOAD`), `SESSION_IDLE`/`TURN_ACTIVE` (→ `TURN_NOT_ACTIVE`/`SESSION_BUSY`), `APPROVAL_ALREADY_RESOLVED` (→ `APPROVAL_NOT_PENDING`), `DUPLICATE_REQUEST_ID`, `RUNTIME_ERROR` (→ `RUNTIME_UNAVAILABLE` or event-level errors).

WS close codes (registered in `errors.ts`, the only registry): `1000` normal · `1001` daemon shutdown/idle (client shows "daemon restarting", slower backoff) · `4400` protocol violation or version mismatch · `4401` reserved for post-handshake auth invalidation (not used in v1 — upgrade-time auth failure is a raw HTTP `401`, §9.4) · `4408` handshake timeout · `4409` PTY already attached (PTY socket only) · `4413` oversized messages · `4429` slow consumer / backpressure disconnect. (Daemon-draft codes `4001`/`4008` are dead.)

## 5.10 Payload versioning & upcasts

- Each durable type carries `v`; the Zod registry holds only the latest schema; `upcasts.ts` holds per-type chains (`v(n) → v(n+1)`). Additive optional fields don't bump `v`; renames/removals/semantic changes do, with an upcast in the same PR (CI: latest `v == 1 + chain length`). Stored rows are never rewritten.
- **Upcasting happens daemon-side at the read boundary**: storage returns raw rows; core applies chains before replay fanout and projection rebuild. `agena rebuild` therefore rebuilds from upcast payloads and rewrites FTS in the same pass (P7). **Clients only ever see latest-`v` payloads** and contain zero upcast logic.
- New event *types* are additive (no protocol bump); clients render unknown types as a generic row. Removing/repurposing a type or command bumps `PROTOCOL_VERSION`.
- Raw runtime capture (P15) is orthogonal: an opt-in JSONL tee of Pi-native events to `/var/lib/agena/captures/`, never a table, never versioned by this scheme, never read at runtime.

## 5.11 Conformance tests (Vitest, packages/protocol)

1. Every durable event and frame type has a schema, a registry entry, and `latest v == 1 + upcasts.length`.
2. Round-trip encode → parse for every envelope kind and command/ack pair.
3. Upcast chains: fixtures at each historical `v` upgrade to latest-valid payloads.
4. Size limits: post-spill payloads > 128 KiB rejected; envelope codec rejects > 1 MiB. (Schemas do **not** reject pre-spill 64 KiB–128 KiB payloads — the spiller runs first; §7.7.)
5. Replay-order property test: any interleaving of sessions on one socket preserves per-session seq monotonicity and gap-freedom.
6. Recovery-payload test: every §5.6 matrix cell validates against its schema.
7. Cross-doc registry test: every dot.case name in the §8.4 mapping table exists in the registries.

---

# 6. Event Handling Pipeline

## 6.1 The chain

```
Pi SDK event
  → runtime-pi event pump: raw-capture tee (opt-in, P15) → mapPiEvent() → RuntimeEvent (kebab-case, core-owned union)
  → core's per-session actor consumes RuntimeSession.events() sequentially (single consumer)
      ├── durable-classified  → store.appendEvents()   [one tx: seq + events + projections + FTS]
      │                          └── onCommitted → FanoutHub.publishCommitted (STRICTLY after commit, P6)
      └── frame-classified    → FanoutHub.publishFrame (never persisted, P12)
  → per-connection outbound queues → WS envelopes → client store (applyEvent / applyFrame)
```

The adapter never assigns `seq`, never touches the store, never fans out. Durable-vs-frame classification is fixed per `RuntimeEvent` variant (§8.4); core performs the final translation and stamps `source: {kind:"runtime", runtime:"pi"}` (P3). Core fully processes one `RuntimeEvent` (including committing the append tx for durable ones) before pulling the next — this single decision makes fanout-after-commit trivially correct and gives the adapter natural pull-based backpressure.

## 6.2 The fanout seam (P6) — one seam, decided

The **store's `onCommitted` hook is the fanout seam**. `appendEvents` invokes registered listeners synchronously after commit, in seq order, inside its per-session queue's critical section. At bootstrap the daemon registers exactly one listener: `FanoutHub.publishCommitted(sessionId, events)`. The orchestrator never calls fanout directly (the daemon-draft variant is dead). Frames are published straight to `FanoutHub.publishFrame`, which routes them through the same per-session FIFO dispatch queue as committed events, so relative order (frame-after-append ⇒ dispatched-after-those-events) is preserved end-to-end. Listeners must be non-blocking enqueuers; a listener throwing is caught and logged and can never un-commit anything.

## 6.3 Subscribe: cold/live splice (no gaps, no duplicates)

On `subscribe {sessionId, fromSeq}`:

1. Validate session → else `error SESSION_NOT_FOUND`. Send `ack` (replay follows).
2. Register the subscription in **buffering** mode: committed events arriving from `FanoutHub` are buffered (bounded at 5,000; overflow restarts the cold read from the new head); frames during buffering are dropped (droppable by contract; the snapshot covers what they carried).
3. Cold-read `store.readEvents(sessionId, branchId, fromSeq, limit)` in pages, sending `event {replayed:true}` in strict seq order.
4. Drain the buffer (only `seq >` last replayed), send `sync`, then `snapshot` (always), then flip to **live**.

## 6.4 Backpressure: droppable frames, undroppable events

Per-connection outbound handling (`ws/connection.ts`), tuned on `ws.bufferedAmount` — these numbers are the one policy set (owned by daemon config; §3.2):

1. Writer loop drains the outbound FIFO while `bufferedAmount < 1 MiB`.
2. Above 1 MiB, incoming **frames** merge into per-stream coalescing slots keyed by `(sessionId, messageId|toolCallId, channel)`: text/thinking deltas concatenate; `tool.call.output.delta` replaces-with-latest; keep-latest frames (`session.status.updated`, `session.queue.updated`, `session.widget.updated`) supersede.
3. Above 4 MiB: thinking slots discarded; text slots keep the coalesced pending frame only; tool-output latest-only. Counters (`framesCoalesced`, `framesDropped`) exported to diagnostics.
4. **Durable events are never dropped, reordered, or coalesced.** Durable backlog above 16 MiB, or no socket progress for 15 s → close `4429`. Nothing is lost: the client reconnects and resubscribes with `fromSeq` — replay is the recovery path, which is why the store never blocks on delivery.

There are exactly **two** throttling tiers in the whole system: this gateway valve (correctness-critical) and the client's 40 ms render tick (§11.4). The runtime-draft's adapter-level coalescing (25 ms tick, 256-entry merge, `runtime-overrun` abort) is **deleted** — the adapter sits in front of a single in-process pull-based consumer with natural backpressure, and killing a healthy generation over a local queue depth was the wrong remedy.

## 6.5 Validation at every boundary

- Commands: Zod at the WS gateway (`INVALID_PAYLOAD` with issue list).
- Runtime events: defensive narrowing in `event-map.ts`; a Pi event failing narrowing is treated as unknown (warn + counter + capture tee, never a crash).
- Events: Zod-validated against `durableEventSchemas` before the append tx; frame types rejected with `not_a_durable_event` (P12).
- Old rows: `v` + upcast chains at the read boundary (§5.10).

---

# 7. Database Schema & Event Store

Owner packages: `packages/storage-sqlite` (implementation), `packages/core` (the `EventStore` port and projection reducers). `packages/protocol` owns all payload shapes. Nothing outside `storage-sqlite` writes SQL; nothing outside `core` decides what a projection contains.

## 7.1 Governing invariants

1. **Events are truth; everything else is disposable.** Every table except `events`, `sessions`/`branches` identity columns, `imports`/`imported_sessions`, `snapshots`, `blobs`, and `meta` is a projection rebuildable from `events`. Projection schema changes are drop → rebuild, never data migrations.
2. **`appendEvents` is the only durable write path** — session service, importer, PTY lifecycle, approvals, snapshots (control session) all go through it. Seq assignment, event insert, projection updates (including FTS5) in one transaction; `onCommitted` fanout strictly after commit (P6).
3. **One monotonic `seq` per session**, assigned inside the append tx from `sessions.last_seq`. `fromSeq` replay is exclusive (`seq > fromSeq`; `0` = everything).
4. **Branch is a column on events**; all branches share the session's seq space; branch replay per INV-11 (P10).
5. **Streaming deltas are never rows** (P12): `appendEvents` rejects any type not in `DURABLE_EVENT_TYPES` with `not_a_durable_event`.
6. **Payload shape belongs to protocol** — Zod-validated (post-spill) before the tx; `v` column + upcasts isolate Pi churn from stored shape.
7. **Every `*.started` gets a terminal event** per the §5.6 matrix (P2); the boot sweep (§7.8) enforces it after a crash — including `run.started` and `terminal.session.started`.
8. **Daemon state under `/var/lib/agena`, never `/workspace`** (P1); snapshot restore never touches the event store.
9. **Payloads over 64 KiB spill to content-addressed blobs**; over 128 KiB post-spill rejected.
10. **Clients never see an event that can roll back**: fanout is post-commit, and `synchronous=FULL` means post-commit is durable across power loss.

## 7.2 SQLite configuration

```sql
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = FULL;      -- commit == durable; required because fanout follows commit (P6)
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

`DELETE` over `WAL`: Agena v1 has one daemon writer and clients read through the daemon API. WAL sidecar files are brittle for local live inspection on Docker bind mounts and add operational ambiguity for volume snapshots/backups. If read concurrency later becomes a real bottleneck, move the store behind the same `EventStore` port to Postgres or revisit WAL with a daemon-owned inspection/export path. `FULL` over `NORMAL`: with `NORMAL` a power loss can drop a committed tx; clients that received the fanout would hold seqs the store lost — protocol-level corruption. Durable-event volume is low (deltas excluded), so the fsync cost is irrelevant. Driver: **better-sqlite3** via Drizzle (synchronous transactions — no async interleaving inside the tx body). Graceful shutdown closes the SQLite handle after draining runtime work.

## 7.3 DDL ownership by milestone

STRICT everywhere; enums as CHECKs; timestamps ISO-8601 UTC TEXT; ids ULIDs. DB path: `/var/lib/agena/db/agena.db`.

Schema lands with the feature that first needs it. M2 owns only the durable replay core: `sessions`, `branches`, `events`, `messages`, and `tool_calls` projections. Later milestones extend the same database in place:

- **M4 project/cwd scope:** `projects`, `sessions.scope`, `sessions.project_id`, `sessions.cwd`, `sessions.host_cwd_hint`, and project-scoped list/search filters.
- **M5 search/snapshots/session management:** `messages_fts`, `snapshots`, control-session metadata (`meta.control_session_id`, `sessions.is_control`), and session status/archive fields.
- **M6 importers:** `imports`, `imported_sessions`, importer source fields, imported-session read-only metadata, and `pi_session_path`/raw archive pointers where needed.
- **M7 tool execution/blob spill:** `blobs` metadata plus the blob file layout and `GET /v1/blobs/:hash`. The `BlobRef` wire shape exists earlier as protocol vocabulary, but no milestone must implement blob storage until a feature can actually emit oversized tool output.

The complete v1 target schema is shown below for consistency; milestone deliverables in §14 decide when each table/column becomes required.

```sql
-- ── meta ────────────────────────────────────────────────────────
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,          -- 'workspace_id', 'control_session_id', 'daemon_instance_id', 'created_at'
  value TEXT NOT NULL
) STRICT;
-- v1: one container = one workspace = one database. workspace_id minted by the CLI at
-- `agena workspace init`, validated against env at boot (fatal mismatch); workspace_id
-- columns below future-proof multi-workspace without schema change.

-- ── source of truth ─────────────────────────────────────────────
CREATE TABLE projects (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  name                TEXT NOT NULL,
  root                TEXT NOT NULL,                         -- workspace-relative, "." allowed
  host_path_hint      TEXT,                                  -- diagnostics/profile resolution only
  fingerprint         TEXT,                                  -- git remote/root hash when available
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (workspace_id, root)
) STRICT;

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  scope            TEXT NOT NULL DEFAULT 'project'
                     CHECK (scope IN ('project','global','control')),
  project_id       TEXT REFERENCES projects(id),             -- NULL for global/control sessions
  cwd              TEXT NOT NULL DEFAULT '.',                -- workspace-relative runtime cwd
  host_cwd_hint    TEXT,                                     -- diagnostics only; not execution truth
  title            TEXT,
  status           TEXT NOT NULL DEFAULT 'active'          -- M5 session archive/list filters
                     CHECK (status IN ('active','idle','archived')),
  source           TEXT NOT NULL DEFAULT 'native'          -- M6 imported/read-only sessions
                     CHECK (source IN ('native','claude','codex')),
  is_control       INTEGER NOT NULL DEFAULT 0,            -- M5: singleton workspace control session
  runtime          TEXT NOT NULL DEFAULT 'pi',
  active_branch_id TEXT,                                  -- validated in code (circular FK avoided)
  pi_session_path  TEXT,                                  -- M6/import diagnostics: pointer to Pi/raw JSONL
  last_seq         INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
) STRICT;
CREATE INDEX idx_sessions_scope
  ON sessions(workspace_id, scope, project_id, updated_at DESC);
-- session.created.origin 'import.claude'|'import.codex' maps to source 'claude'|'codex';
-- 'native' and 'control' map to source 'native' (control rows also set is_control = 1).
-- project_id is required when scope='project'; cwd must stay under the project root in code.

CREATE TABLE branches (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  parent_branch_id TEXT REFERENCES branches(id),
  forked_from_seq  INTEGER,                               -- NULL iff root branch
  name             TEXT,
  created_at       TEXT NOT NULL,
  CHECK ((parent_branch_id IS NULL) = (forked_from_seq IS NULL))
) STRICT;
CREATE INDEX idx_branches_session ON branches(session_id);

CREATE TABLE events (
  session_id       TEXT    NOT NULL REFERENCES sessions(id),
  seq              INTEGER NOT NULL,                      -- per-session, assigned in the append tx
  id               TEXT    NOT NULL,                      -- internal ULID; importer dedupe + debugging;
                                                          -- NEVER serialized to the wire
  branch_id        TEXT    NOT NULL REFERENCES branches(id),
  type             TEXT    NOT NULL,                      -- dot.case, from DURABLE_EVENT_TYPES
  v                INTEGER NOT NULL DEFAULT 1,
  source_kind      TEXT    NOT NULL
                     CHECK (source_kind IN ('user','daemon','runtime','terminal','filesystem','importer')),
  source_runtime   TEXT,                                  -- 'pi' when source_kind = 'runtime'
  source_client_id TEXT,                                  -- clientId when source_kind = 'user' (P3)
  payload          TEXT    NOT NULL CHECK (json_valid(payload)),
  created_at       TEXT    NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT;
CREATE UNIQUE INDEX idx_events_id ON events(id);
CREATE INDEX idx_events_type      ON events(session_id, type, seq);
CREATE INDEX idx_events_branch    ON events(session_id, branch_id, seq);

-- ── projections (rebuildable — never migrated, only rebuilt) ────
CREATE TABLE messages (
  id         TEXT PRIMARY KEY,                            -- messageId from the payload
  session_id TEXT NOT NULL,
  branch_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,                            -- the terminal event's seq
  role       TEXT NOT NULL CHECK (role IN ('user','assistant','runtime')),
  model      TEXT,
  status     TEXT NOT NULL DEFAULT 'completed'
               CHECK (status IN ('completed','aborted','failed')),   -- P2: partials visible
  error      TEXT,                                        -- JSON, when status = 'failed'
  content    TEXT NOT NULL CHECK (json_valid(content)),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_messages_session ON messages(session_id, branch_id, seq);

CREATE TABLE tool_calls (
  id          TEXT PRIMARY KEY,                           -- toolCallId
  session_id  TEXT NOT NULL,
  branch_id   TEXT NOT NULL,
  message_id  TEXT,
  name        TEXT NOT NULL,
  args        TEXT CHECK (args IS NULL OR json_valid(args)),
  result      TEXT CHECK (result IS NULL OR json_valid(result)),    -- may contain BlobRefs
  status      TEXT NOT NULL
                CHECK (status IN ('running','ok','error','aborted','denied')),  -- P2
  started_seq INTEGER NOT NULL,
  ended_seq   INTEGER,
  created_at  TEXT NOT NULL
) STRICT;
CREATE INDEX idx_tool_calls_session ON tool_calls(session_id, branch_id, started_seq);

-- M5: FTS over message text → agena search (P7: explicit writes, no triggers).
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  session_id UNINDEXED, branch_id UNINDEXED, message_id UNINDEXED,
  tokenize = 'unicode61 tokenchars ''_-.'''     -- OD3; trigram benchmarked in M6, switch via rebuild
);

-- M7: blob spill metadata for oversized tool args/results and file/image blocks.
CREATE TABLE blobs (
  hash       TEXT PRIMARY KEY,                            -- 'sha256:<hex>'
  size_bytes INTEGER NOT NULL,
  mime       TEXT,
  created_at TEXT NOT NULL
) STRICT;

-- M6: import layer.
CREATE TABLE imports (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,                              -- 'claude' | 'codex' (open set)
  machine_id  TEXT,
  raw_path    TEXT NOT NULL,                              -- /var/lib/agena/raw-imports/...
  stats       TEXT CHECK (stats IS NULL OR json_valid(stats)),
  imported_at TEXT NOT NULL
) STRICT;

CREATE TABLE imported_sessions (
  import_id      TEXT NOT NULL REFERENCES imports(id),
  source_ref     TEXT NOT NULL,                           -- IDENTITY: original session id/path
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  content_hash   TEXT,                                    -- CHANGE DETECTION: sha256 of source content
  resume_summary TEXT CHECK (resume_summary IS NULL OR json_valid(resume_summary)),
  PRIMARY KEY (import_id, source_ref)
) STRICT;
CREATE INDEX idx_imported_sessions_session ON imported_sessions(session_id);

-- M5: workspace snapshots (metadata; artifact on disk).
CREATE TABLE snapshots (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id   TEXT,                                      -- triggeredBySessionId, optional
  name         TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('manual','auto','pre_tool','pre_restore')),
  storage_path TEXT NOT NULL,                             -- /var/lib/agena/snapshots/<ulid>.tar.zst
  sha256       TEXT NOT NULL,
  size_bytes   INTEGER,
  status       TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','deleted')),
  created_at   TEXT NOT NULL
) STRICT;
```

Deferred tables (deliberately not v1): `share_links` (P9 parked), `devices`/`device_cursors` (cursors are client-side), `model_switches` (it's an event type), `audit_event`, `workspace_file_manifest` (the container FS is the manifest).

## 7.4 The EventStore port (packages/core)

```ts
// packages/core/src/events/store.ts
import type { AgenaEvent, EventSource } from '@agena/protocol';

export interface NewEvent {
  id?: string;                 // internal ULID; store mints if absent; importers pre-supply for dedupe
  type: string;                // must be in DURABLE_EVENT_TYPES (P12)
  v: number;
  source: EventSource;
  payload: unknown;            // validated against protocol schema for type@v AFTER blob spill
}

export interface AppendEventsInput { sessionId: string; branchId: string; events: NewEvent[]; }
// NOTE: no expectedLastSeq/OCC in v1 — the per-session FIFO queue plus the single-daemon
// single-writer invariant (INV-14) already serialize appends; seq_conflict guarded a race
// that cannot occur in-process. Reserved for the Postgres multi-writer path.

export interface AppendEventsResult { events: AgenaEvent[]; lastSeq: number; }

export interface ReadEventsPage { events: AgenaEvent[]; nextFromSeq: number | null; }
export interface BranchSegment { branchId: string; uptoSeq: number | null }   // null = unbounded (tip)

export type SessionScope =
  | { kind: "project"; projectId: string; projectRoot: string; cwd: string; hostCwdHint?: string }
  | { kind: "global"; cwd?: string; hostCwdHint?: string }
  | { kind: "control"; cwd?: string };

export interface CreateSessionInput {
  workspaceId: string;
  title?: string;
  source?: EventSource;
  scope: SessionScope;
}

export interface SessionFilter {
  workspaceId?: string;
  projectId?: string;
  scope?: "project" | "global" | "control";
  allProjects?: boolean;
  includeArchived?: boolean;
}

export interface EventStore {
  createSession(input: CreateSessionInput): Promise<SessionRecord>;   // row + root branch + session.created, one tx
  createBranch(input: CreateBranchInput): Promise<BranchRecord>;      // row + branch.created
  getSession(sessionId: string): Promise<SessionRecord | null>;
  listSessions(filter?: SessionFilter): Promise<SessionRecord[]>;

  appendEvents(input: AppendEventsInput): Promise<AppendEventsResult>;   // the ONLY durable write path

  // PAGED replay — matches GET /v1/sessions/:id/events; no unbounded reads exist
  readEvents(sessionId: string, branchId: string, fromSeq: number, limit: number): Promise<ReadEventsPage>;
  resolveBranchChain(sessionId: string, branchId: string): Promise<BranchSegment[]>;

  // THE fanout seam (P6): invoked after commit, in strict seq order (§6.2)
  onCommitted(listener: (batch: AppendEventsResult & { sessionId: string }) => void): () => void;

  readBlob(hash: string): Promise<Uint8Array | null>;
  search(query: string, opts?: { sessionId?: string; projectId?: string; allProjects?: boolean; limit?: number }): Promise<SearchHit[]>;

  rebuildProjections(sessionId?: string): Promise<RebuildReport>;
  reconcileOpenWork(): Promise<ReconcileReport>;          // boot sweep (P2, §7.8)
  close(): Promise<void>;                                 // drain queues, wal_checkpoint(TRUNCATE)
}
```

Companion ports: `ImportStore` (`createImport`, `recordImportedSession`, `findImportedSession(source, sourceRef)`) and `SnapshotStore` (`recordSnapshot`, `listSnapshots`, `getSnapshot`).

**Milestone 1 uses `InMemoryEventStore`** — a ~150-line implementation of this exact interface in `packages/core` (daemon-lifetime only). SQLite arrives in Milestone 2 behind the same port; nothing above the port changes (P8). The in-memory store is also what FakeRuntime tests run against (P16).

## 7.5 The appendEvents transaction

Order of operations, exactly. M2 validates and stores inline durable payloads only. The blob-spill pre-pass is inserted into step 3 when M7 introduces oversized tool/file payloads; until then, any payload over the inline hard cap is rejected before the transaction.

```ts
// packages/storage-sqlite/src/store.ts — shape, not final code (better-sqlite3: tx body is synchronous)
async appendEvents(input: AppendEventsInput): Promise<AppendEventsResult> {
  return this.queues.for(input.sessionId).run(() => {          // 1. per-session FIFO serialization
    const prepared = input.events.map(e => {
      assertDurableType(e.type);                                // 2. reject frame types (P12)
      const normalized = maybeSpillLargePayloads(e);            // 3. M7; M2 is identity
      return validatePayload(normalized);                       // 4. protocol Zod validation
    });

    const committed = this.db.transaction(() => {               // BEGIN IMMEDIATE (write lock up front)
      const session = selectSession(input.sessionId);           // 5. read last_seq under the lock
      if (!session) throw storeError('session_not_found');
      let seq = session.lastSeq;
      const rows = prepared.map(e => toRow(e, input, ++seq));   // 6. assign seqs
      insertEvents(rows);                                       // 7. events (+ M7 INSERT OR IGNORE blobs rows)
      applyProjections(this.db, rows);                          // 8. messages/tool_calls (+ M5 FTS5)
      updateSession(input.sessionId, seq, now());               // 9. last_seq, updated_at, derived title/status
      return rows;
    })();                                                       // COMMIT (synchronous=FULL → durable)

    const result = { sessionId: input.sessionId, events: committed.map(toAgenaEvent),
                     lastSeq: last(committed).seq };
    this.emitCommitted(result);                                 // 10. onCommitted listeners — the P6 seam
    return result;
  });
}
```

- The per-session FIFO (step 1) is the primary concurrency answer; the session orchestrator's serialization is the sole policy mechanism (no OCC).
- Projections update inside the tx (step 8) via core's shared reducers — an event and its projection can never disagree on disk.
- Typed errors: `session_not_found`, `branch_not_found`, `not_a_durable_event`, `invalid_payload` (Zod issues attached), `payload_too_large`.

## 7.6 Projections and FTS5 (P7)

Projection logic lives in `packages/core` as pure reducers — `(event) => ProjectionOps[]` — used identically by live appends and rebuild, so the paths cannot drift. M2 owns `messages` and `tool_calls`; M5 adds `messages_fts` and snapshot rows; M6 adds importer rows; M7 exercises blob-bearing tool output. Event → projection map (covers every type in §5.5; unlisted types touch `sessions.updated_at` only and are queried off `idx_events_type`):

| Durable event | messages | tool_calls | messages_fts | sessions (derived) |
|---|---|---|---|---|
| `message.user.created` | insert `completed`, role `user` | — | **INSERT** | `updated_at` |
| `message.runtime.created` | insert `completed`, role `runtime` | — | **INSERT** | `updated_at` |
| `message.assistant.completed` | insert `completed` | — | **INSERT** | `updated_at` |
| `message.assistant.aborted` | insert `aborted` w/ partial content (P2) | — | **INSERT** | `updated_at` |
| `message.assistant.failed` | insert `failed` w/ partial content + error (P2) | — | **INSERT** | `updated_at` |
| `tool.call.started` | — | insert `running` | — | — |
| `tool.call.completed` | — | update → `ok`, result, ended_seq | — | — |
| `tool.call.failed` | — | update → `error`, ended_seq | — | — |
| `tool.call.aborted` | — | update → `aborted`, ended_seq (P2) | — | — |
| `tool.call.denied` | — | update → `denied`, ended_seq | — | — |
| `session.title.changed` | — | — | — | `title` |
| `session.status.changed` | — | — | — | `status` |
| `snapshot.created` / `.deleted` | — | — | — | snapshots row insert / status='deleted' |
| `run.*`, `branch.*`, `model.changed`, `thinking.level.changed`, `compaction.*`, `approval.*`, `terminal.session.*`, `snapshot.restored/.restore.failed`, `workspace.initialized`, `import.summary.created`, `runtime.extension.failed` | — | — | — | `updated_at` only |

FTS writes are **explicit statements emitted by the reducer, executed inside the append tx** — no SQLite triggers:

```sql
INSERT INTO messages_fts (content, session_id, branch_id, message_id)
VALUES (:searchText, :sessionId, :branchId, :messageId);
```

`searchText` = `extractSearchText(contentBlocks)` in core (text blocks concatenated; thinking and blob-spilled content not indexed in v1). Messages are insert-only (a row appears once, at its terminal event), so live FTS maintenance is INSERT-only; DELETEs occur only during rebuild. `search()` combines `messages_fts MATCH` (+`snippet()`) with a `LIKE` scan over `sessions.title`.

Approvals need no projection: pending = events scan for `approval.requested` without a terminal sibling (`idx_events_type`), which also backs `GET /v1/approvals`.

**`agena rebuild`** (`POST /v1/admin/rebuild`; offline `agena-daemon --rebuild`): per session — hold the append queue → one tx: DELETE the projection rows owned by the current milestone (`messages`/`tool_calls` in M2; add `messages_fts` in M5) → stream events (upcast) through the same reducers → verify `sessions.last_seq = MAX(events.seq)` → commit, release, return a `RebuildReport`. Byte-identical to live appends by construction.

## 7.7 Blob spill (M7, 64 KiB inline cap)

Blob spill is not an M2 storage prerequisite. It lands with M7 tool execution because that is the first feature expected to produce large tool args/results. Until then, oversized durable payloads are rejected before append and no committed event may reference a missing blob.

- **Trigger:** a payload whose serialized JSON exceeds 64 KiB has its protocol-marked `spillable` string fields (tool result output, oversized content blocks) replaced with the §5.3 `BlobRef`.
- **Write path (before the tx), race-safe:** compute sha256 → write to `blobs/sha256/<hh>/<hash>.<ulid>.tmp` (**unique tmp name** — two concurrent identical spills never share a tmp file) → fsync → atomic rename; **if the final path already exists, skip the rename** (content-addressed idempotency). The `blobs` metadata row is inserted in the referencing event's tx with `INSERT OR IGNORE` (second event referencing the same hash is a no-op). A committed event therefore never references a missing file.
- **Hard cap:** still over **128 KiB** post-spill → `payload_too_large` before the tx. (The daemon-draft's "256 KiB" reference is dead; 128 KiB is the number everywhere.)
- **Read path:** `readEvents` returns `BlobRef`s unresolved; clients fetch lazily via `GET /v1/blobs/:hash`.
- **Crash orphans:** a blob written for a tx that never commits is a harmless orphaned file (content-addressed, reusable). `agena rebuild --gc-blobs` is a named future sweep; **no GC in v1** — blobs live as long as events, and events live forever (§7.9).

## 7.8 Crash consistency & the boot sweep (P2)

- **Dies between commit and fanout:** event is durable; clients heal via `subscribe {fromSeq}` replay — the store is the retry mechanism.
- **Dies mid-transaction:** WAL rolls back; no partial events, no seq consumed.
- **Dies mid-generation:** `reconcileOpenWork()` runs at boot before the WS gateway accepts subscriptions. It handles the durable started/pending states introduced up to the current milestone. M2 requires assistant-message and run recovery; M3 adds terminal sessions; M4 adds project/cwd session metadata but no new started states; M4.5 adds approvals and user abort/control states; M7 adds tool execution outputs and hook denials. For every dangling start (no terminal sibling at higher seq on the same branch) it appends the §5.6 **hard-crash column** payloads with `source {kind:"daemon"}`, via the normal `appendEvents` path: `message.assistant.failed {partialContent: [], error:{code:"daemon_restart"}, recovered:true}`, `tool.call.aborted {partialOutput: [], reason:"daemon_restart"}`, `run.failed {error:{code:"daemon_restart"}}`, `approval.cancelled {reason:"daemon_restart"}`, and — for every `terminal.session.started` without an end — `terminal.session.ended {exitCode: null, reason:"daemon_restart"}` once those event families exist. The dangling-message detection SQL (same pattern for runs/tools/approvals/terminals as they land):

  ```sql
  SELECT e.session_id, e.branch_id, json_extract(e.payload,'$.messageId') AS message_id
  FROM events e
  WHERE e.type = 'message.assistant.started'
    AND NOT EXISTS (
      SELECT 1 FROM events t
      WHERE t.session_id = e.session_id
        AND t.type IN ('message.assistant.completed','message.assistant.aborted','message.assistant.failed')
        AND json_extract(t.payload,'$.messageId') = json_extract(e.payload,'$.messageId'));
  ```

  Open tool calls come straight from `tool_calls WHERE status = 'running'`. "Resume" after a crash = full durable history, interrupted turn visibly marked failed, user re-prompts. In-flight tokens are lost by design (P12); the capture tee, if on, has them for debugging only. The sweep is idempotent — against a clean store it appends nothing.
- **Graceful shutdown:** the §5.6 SIGTERM column for every started/pending state implemented so far, with real partial content from the in-flight mirror where available; then drain queues and close the SQLite handle.
- **Power loss:** `synchronous=FULL` — anything fanned out was fsynced first.

## 7.9 Retention & compaction stance

**v1: append-only, delete nothing.** Durable-only volume is small (thousands of rows per heavy session, not millions). Context compaction is an event, never log truncation. No TTL, no pruning. Operational hygiene: optional `agena-daemon --vacuum`. Future retention (reserved design): archive whole sessions — export events + referenced blobs to a JSONL bundle, mark archived, delete rows; per-event redaction is intentionally unsupported (a tombstone event type if ever required).

## 7.10 Drizzle usage & migrations

`schema.ts` uses Drizzle's SQLite builders; FTS5 virtual table, CHECKs Drizzle can't express, and PRAGMAs live in hand-written SQL migrations in the same drizzle-kit chain. Migrations applied by the daemon at boot before serving; refuse-to-boot on schema downgrade (older image + newer DB). Projection migrations are written as drop-and-recreate + a rebuild-on-next-boot flag — never a data migration. Migration tests: full chain on empty DB asserts schema; chain N→head on a previous-release fixture DB asserts rebuild produces identical projections.

## 7.11 Postgres migration path

A new `packages/storage-postgres` behind the same ports. Unchanged: `EventStore`/`ImportStore`/`SnapshotStore` interfaces, protocol schemas, seq semantics, two-tier model, shared reducers, `agena rebuild`, fanout-after-commit. Changed:

| Concern | SQLite (v1) | Postgres (later) |
|---|---|---|
| Payloads | TEXT + `json_valid` CHECK | `jsonb` |
| Search | FTS5, explicit inserts | `tsvector` + GIN; same reducer emits the write |
| Seq assignment | `last_seq` under `BEGIN IMMEDIATE` | `SELECT … FOR UPDATE` (same algorithm; this is where OCC returns) |
| Tx model | synchronous better-sqlite3 | async pg tx — safe: the per-session queue already serializes |
| Blobs | local disk | S3-compatible, identical `sha256:` addressing and BlobRef shape |
| Fanout across daemons | in-process `onCommitted` | LISTEN/NOTIFY or outbox when multi-node is real |

---

# 8. Pi Runtime Integration

`packages/runtime-pi` is the ONLY package importing `@earendil-works/pi-coding-agent` (P16). It touches no SQLite, no WebSockets, no Hono, no TUI. Its entire job: turn Pi SDK calls/events into the runtime-neutral `RuntimeEvent` stream core consumes, and expose runtime control behind core-owned interfaces (P11).

## 8.1 Position and layering

- `packages/core` **defines** `RuntimeAdapter`, `RuntimeSession`, `RuntimeEvent`, `RuntimeInFlightSnapshot`, `AgenaToolDescriptor` in `packages/core/src/runtime/types.ts`. Core depends only on protocol.
- `packages/runtime-pi` **implements** them, depending on core + protocol + Pi only.
- `apps/daemon` instantiates `PiRuntimeAdapter` at bootstrap. Core never mentions Pi except the `source.runtime: 'pi'` provenance string it stamps on runtime-derived durable events (P3).

```
Pi SDK event → RuntimeEvent (core-owned union, runtime-neutral)
            → AgenaEvent (durable; seq assigned in core's append tx) — or —
            → AgenaFrame (ephemeral; afterSeq stamped by core; never persisted)
```

## 8.2 Core-owned port interfaces (exact shapes)

```ts
import type { ContentBlock, ModelRef, ThinkingLevel, ApprovalKind, ApprovalResponse } from '@agena/protocol';

export type RuntimeId = 'pi' | 'fake';

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  readonly version: string;                       // the pinned Pi SDK version
  capabilities(): RuntimeCapabilities;            // steer/followUp/setModel/thinkingLevels/compaction/customTools
  createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSession>;
  openSession(input: OpenRuntimeSessionInput): Promise<RuntimeSession>;   // resume from raw ref
  dispose(): Promise<void>;                       // graceful-shutdown path
}

export interface CreateRuntimeSessionInput {
  sessionId: string;                 // Agena session ULID
  workspaceDir: string;              // '/workspace'
  cwd: string;                       // absolute path inside workspace, derived from durable session cwd
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
  tools: AgenaToolDescriptor[];      // bridged Agena tools (.agena/tools + builtins)
  systemPromptAppendix?: string;
  capture?: RawCaptureConfig;        // opt-in raw event tee (P15)
}
export interface OpenRuntimeSessionInput extends CreateRuntimeSessionInput {
  runtimeSessionRef: string;         // Pi: absolute path to the session JSONL
}

export interface RuntimeSession {
  readonly sessionId: string;
  readonly runtimeSessionRef: string;             // persisted into sessions.pi_session_path
  readonly state: 'idle' | 'running' | 'errored' | 'disposed';

  /** Single-consumer, ordered. Core's per-session actor is the only consumer;
      a second events() call throws. Pull-based — this IS the adapter's backpressure. */
  events(): AsyncIterable<RuntimeEvent>;

  /** Resolves when the run is ACCEPTED, not when it finishes; completion arrives
      as run-completed / run-aborted / run-failed RuntimeEvents. */
  prompt(input: { messageId: string; text: string }): Promise<void>;
  steer(input: { messageId: string; text: string }): Promise<void>;
  followUp(input: { messageId: string; text: string }): Promise<void>;
  abort(reason: 'user' | 'shutdown'): Promise<void>;

  setModel(model: ModelRef): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  compact(): Promise<void>;
  respondToApproval(approvalId: string, response: ApprovalResponse): Promise<void>;

  /** Synchronous — served from adapter-local buffers, never awaits Pi. */
  getInFlightSnapshot(): RuntimeInFlightSnapshot | null;
  dispose(): Promise<void>;
}

export interface AgenaToolDescriptor {
  name: string;                                   // path-derived per P20
  description: string;
  inputSchema: unknown;                           // Zod schema
  execute(args: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
}
```

`messageId` is passed IN by core: core appends `message.user.created` (source `{kind:'user', clientId}`) in its own tx **before** calling `prompt/steer/followUp`, then hands the adapter the same ULID for echo suppression. The port's `text` is core's concatenation of the command's `{type:"text"}` content blocks — v1 restricts `prompt/steer/followUp` content to text blocks (§5.4), so the `ContentBlock[]` → `text` reduction is lossless.

**`RuntimeInFlightSnapshot`** (core-owned; distinct name from the wire type — the earlier same-name collision is dead):

```ts
export interface RuntimeInFlightSnapshot {
  sessionId: string;
  run: { runId: string; startedAt: string; trigger: 'prompt' | 'steer' | 'followUp' } | null;
  assistantMessage: {
    messageId: string; model: ModelRef;
    blocks: Array<{ index: number; type: 'text' | 'thinking' | 'toolcall';
                    text?: string; toolName?: string; argsText?: string }>;
  } | null;
  toolCalls: Array<{ toolCallId: string; name: string; args: unknown; outputSoFar: string; startedAt: string }>;
  pendingApprovalIds: string[];
  retry: { attempt: number; maxAttempts: number; nextAttemptAt: string } | null;
  queue: { steerCount: number; followUpCount: number };
}
```

**Mapping to the wire `InFlightSnapshot` (§5.8) happens in core at subscribe time** (`toWireSnapshot()`): indexed blocks → `ContentBlock[]` (argsText parsed best-effort into `toolCall` blocks), `outputSoFar` → `partialOutput`, and `pendingApprovalIds` joined with the durable `approval.requested` payloads (core owns the pending set) → `pendingApprovals: ApprovalRequested[]`. `retry`/`queue`/`status` pass through.

### RuntimeEvent (closed union, kebab-case)

```ts
export type RuntimeEvent =
  | { type: 'run-started';   runId: string; trigger: 'prompt' | 'steer' | 'followUp'; triggerMessageId: string }
  | { type: 'run-completed'; runId: string; usage?: UsageTotals }
  | { type: 'run-aborted';   runId: string; reason: 'user' | 'shutdown' }
  | { type: 'run-failed';    runId: string; error: RuntimeErrorInfo }
  | { type: 'turn-started';  runId: string; turnId: string; index: number; model: ModelRef }
  | { type: 'turn-ended';    runId: string; turnId: string; usage?: UsageTotals }
  | { type: 'assistant-message-started';   messageId: string; runId: string; turnId: string; model: ModelRef }
  | { type: 'assistant-block-started';     messageId: string; blockIndex: number; blockType: 'text'|'thinking'|'toolcall' }
  | { type: 'assistant-text-delta';        messageId: string; blockIndex: number; delta: string }
  | { type: 'assistant-thinking-delta';    messageId: string; blockIndex: number; delta: string }
  | { type: 'assistant-toolcall-delta';    messageId: string; blockIndex: number; delta: string }
  | { type: 'assistant-block-ended';       messageId: string; blockIndex: number }
  | { type: 'assistant-message-completed'; messageId: string; runId: string; turnId: string; model: ModelRef;
      blocks: ContentBlock[]; usage?: UsageTotals; stopReason: string }
  | { type: 'assistant-message-aborted';   messageId: string; runId: string; partialContent: ContentBlock[];
      reason: 'user' | 'shutdown' }
  | { type: 'assistant-message-failed';    messageId: string; runId: string; partialContent: ContentBlock[];
      error: RuntimeErrorInfo }
  | { type: 'user-message-injected';  messageId: string; blocks: ContentBlock[] }   // e.g. Pi extension sendMessage
  | { type: 'runtime-message-created'; messageId: string; runtimeType: 'custom'|'bash'|'branch-summary';
      role?: string; blocks: ContentBlock[]; meta?: Record<string, unknown> }
  | { type: 'tool-call-started';   toolCallId: string; messageId: string; runId: string; turnId: string;
      name: string; args: unknown; runtimeToolCallId: string }
  | { type: 'tool-output-delta';   toolCallId: string; delta: string; reset?: boolean }   // suffix-diffed
  | { type: 'tool-call-completed'; toolCallId: string; result: ContentBlock[]; durationMs: number }
  | { type: 'tool-call-failed';    toolCallId: string; error: RuntimeErrorInfo; partialOutput?: string; durationMs: number }
  | { type: 'tool-call-aborted';   toolCallId: string; partialOutput: string; reason: 'user'|'shutdown'|'runtime-error' }
  | { type: 'tool-call-denied';    toolCallId: string; approvalId: string }
  | { type: 'approval-requested'; approvalId: string; kind: ApprovalKind; title?: string; message: string;
      options?: ApprovalOption[]; defaultValue?: string; context?: { toolCallId?: string; toolName?: string } }
  | { type: 'model-changed';      from: ModelRef | null; to: ModelRef; origin: 'command' | 'runtime' }
  | { type: 'compaction-started'; trigger: 'auto' | 'user' }
  | { type: 'compaction-completed'; summary: string; tokensBefore: number; tokensAfter: number; trigger: 'auto'|'user' }
  | { type: 'compaction-failed';    error: RuntimeErrorInfo }
  | { type: 'retry-started'; runId: string; attempt: number; maxAttempts: number; delayMs: number; errorSummary: string }
  | { type: 'retry-ended';   runId: string; outcome: 'recovered' | 'exhausted' }
  | { type: 'queue-updated'; steerCount: number; followUpCount: number }
  | { type: 'title-changed'; title: string }
  | { type: 'notice';        level: 'info'|'warn'|'error'; text: string }
  | { type: 'status-updated'; status: string | null }
  | { type: 'widget-updated'; widget: unknown | null }
  | { type: 'extension-failed'; extensionRef: string; error: RuntimeErrorInfo };

export interface RuntimeErrorInfo { message: string; code?: string; retryable?: boolean }
```

## 8.3 Exact Pi SDK usage

```ts
// adapter.ts / session.ts — the only file group that imports Pi
import { createAgentSession, SessionManager, DefaultResourceLoader,
         AuthStorage, ModelRegistry, defineTool, getAgentDir } from '@earendil-works/pi-coding-agent';

const manager = SessionManager.create(input.cwd);                   // new session (persistent JSONL)
const managerResume = SessionManager.open(input.runtimeSessionRef); // resume exact JSONL file

const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
  sessionManager: manager,
  cwd: input.cwd,
  model: resolvedModel,               // resolved via ModelRegistry from the Agena ModelRef
  thinkingLevel: input.thinkingLevel ?? 'off',
  authStorage,                        // /var/lib/agena/pi/auth.json, 0600, Pi-owned credentials
  modelRegistry,
  customTools: input.tools.map(bridgeToDefineTool),
  resourceLoader: new DefaultResourceLoader({
    additionalExtensionPaths: [],                                    // NO filesystem extension discovery
    extensionFactories: [createAgenaBridgeExtension(bridgeDeps)],    // temporary bridge, P20
  }),
});
session.subscribe((piEvent) => this.pump.push(piEvent));
```

Decisions baked in:

- **Pi state under `/var/lib/agena/pi/`, never `/workspace`** (P1): `PI_DIR=/var/lib/agena/pi`, verified against `getAgentDir()` at boot (hard fail if Pi resolves elsewhere). Session JSONL → `pi/sessions/` (path stored in `sessions.pi_session_path`); auth → `pi/auth.json`. Pi's JSONL persistence is always on — it is the raw archive layer, never mutated by Agena, only read for resume and debugging.
- **Filesystem extension auto-discovery disabled**: empty `additionalExtensionPaths`, only our `extensionFactories` — `~/.pi/agent/extensions` and `/workspace/.pi/extensions` are never loaded; a repo's `.pi/` directory is ordinary files, flagged by `agena info`. (M1 task M1-R2 verifies `DefaultResourceLoader` gives this control; fallback is a custom `ResourceLoader`.)
- `extensionsResult` errors → `extension-failed` RuntimeEvents; `modelFallbackMessage` → a `session.notice` frame plus `model-changed {origin:'runtime'}` if the effective model differs.

**Control-surface mapping:** `prompt` → `session.prompt(text)` (not awaited to completion; rejection handler feeds §8.6); `steer`/`followUp` → same-named Pi calls; `abort` → `await session.abort()` then synthesis if Pi stays silent; `setModel` → ModelRegistry + `session.setModel`; `setThinkingLevel`, `compact` → same-named (exact SDK names confirmed in M1); `respondToApproval` → resolves the stored dialog resolver; `getInFlightSnapshot` → `session.agent.state.streamingMessage` + local mirrors.

**Session registry, hydration, eviction:** `Map<sessionId, PiRuntimeSession>`, one `createAgentSession` per Agena session, many concurrent sessions per daemon. Idle runtime sessions (no run, no pending approval, no subscriber demand) evicted after 30 min: `dispose()` the Pi session, keep `pi_session_path`; next command rehydrates via `openSession` — Pi rebuilds context from its own JSONL. Eviction is invisible to clients (Agena's log is the source of truth).

## 8.4 Complete mapping table: Pi event → RuntimeEvent → durable event / frame

Classification is fixed per variant. Durable rows are appended by core with `source {kind:'runtime', runtime:'pi'}` (P3); frame rows are fanned out with `afterSeq` and never persisted (P12). **Every name in columns 3–4 exists in §5.5/§5.7 — enforced by protocol conformance test 7.**

| Pi SDK event | RuntimeEvent | Durable AgenaEvent | Ephemeral AgenaFrame |
|---|---|---|---|
| `agent_start` | `run-started` | `run.started` | — |
| `agent_end` (normal) | `run-completed` | `run.completed` | — |
| `agent_end` (after abort) | `run-aborted` | `run.aborted` | — |
| `agent_end` (after error) | `run-failed` | `run.failed` | — |
| `turn_start` | `turn-started` | — | `turn.started` |
| `turn_end` | `turn-ended` | — | `turn.ended` |
| `message_start` (AssistantMessage) | `assistant-message-started` | `message.assistant.started` | — |
| `message_update` / `text_start`·`thinking_start`·`toolcall_start` | `assistant-block-started` | — | `message.assistant.block.started` |
| `message_update` / `text_delta` | `assistant-text-delta` | — | `message.assistant.text.delta` |
| `message_update` / `thinking_delta` | `assistant-thinking-delta` | — | `message.assistant.thinking.delta` |
| `message_update` / `toolcall_delta` | `assistant-toolcall-delta` | — | `message.assistant.toolcall.delta` |
| `message_update` / `*_end` | `assistant-block-ended` | — | `message.assistant.block.ended` |
| `message_end` (AssistantMessage, normal) | `assistant-message-completed` | `message.assistant.completed` | — |
| `message_end` (AssistantMessage, aborted) | `assistant-message-aborted` | `message.assistant.aborted` (P2) | — |
| `message_end` (AssistantMessage, error) | `assistant-message-failed` | `message.assistant.failed` (P2) | — |
| `message_start/end` (UserMessage, echo of our prompt/steer/followUp) | *suppressed* — core appended `message.user.created` at command time; matched by expected-echo registry | — | — |
| `message_end` (UserMessage, no matching expectation — extension `pi.sendMessage`) | `user-message-injected` | `message.user.created` (source runtime) | — |
| `message_end` (ToolResultMessage) | *suppressed* — `tool_execution_end` is canonical | — | — |
| `message_end` (BashExecutionMessage) | `runtime-message-created {runtimeType:'bash'}` | `message.runtime.created` | — |
| `message_end` (CustomMessage) | `runtime-message-created {runtimeType:'custom'}` | `message.runtime.created` | — |
| `message_end` (BranchSummaryMessage) | `runtime-message-created {runtimeType:'branch-summary'}` | `message.runtime.created` | — |
| `message_end` (CompactionSummaryMessage) | *suppressed* — `compaction_end` is canonical | — | — |
| `tool_execution_start` | `tool-call-started` | `tool.call.started` | — |
| `tool_execution_update` | `tool-output-delta` (suffix-diffed; `reset:true` on non-append rewrite) | — | `tool.call.output.delta` |
| `tool_execution_end` (ok) | `tool-call-completed` | `tool.call.completed` | — |
| `tool_execution_end` (isError) | `tool-call-failed` | `tool.call.failed` | — |
| *(abort/error with tool in flight — synthesized, §8.6)* | `tool-call-aborted` | `tool.call.aborted` (P2) | — |
| *(agena-bridge approval denied)* | `tool-call-denied` | `tool.call.denied` | — |
| `queue_update` | `queue-updated` | — | `session.queue.updated` |
| `compaction_start` | `compaction-started` | — | `compaction.started` |
| `compaction_end` (ok) | `compaction-completed` | `compaction.created` | — |
| `compaction_end` (aborted/error) | `compaction-failed` | `compaction.failed` | — |
| `auto_retry_start` | `retry-started` | — | `run.retry.started` |
| `auto_retry_end` | `retry-ended` | — | `run.retry.ended` |
| `extension_error` | `extension-failed` | `runtime.extension.failed` | — |
| `extension_ui_request` (`confirm`/`select`/`input`/`editor`) | `approval-requested` | `approval.requested` (P14) | — |
| `extension_ui_request` (`notify`) | `notice` | — | `session.notice` |
| `extension_ui_request` (`setStatus`) | `status-updated` | — | `session.status.updated {state:"custom"}` |
| `extension_ui_request` (`setWidget`) | `widget-updated` | — | `session.widget.updated` |
| `extension_ui_request` (`setTitle`) | `title-changed` | `session.title.changed` | — |
| `extension_ui_response` | *suppressed* — correlation cleanup only; the durable record is `approval.responded`, appended by core on the client command (P14) | — | — |
| *(state watch: model differs at turn boundary)* | `model-changed {origin:'runtime'}` | `model.changed` | — |
| unknown Pi event type | *suppressed* + warn log + diagnostics counter + capture tee | — | — |

Turn boundaries are frames on purpose: durable message/tool payloads carry `runId`/`turnId`, so replay reconstructs grouping without two extra rows per model call or a dangling-open-turn repair problem. `run.*` stays durable (two rows per user-visible run) because it anchors abort/failure semantics, usage totals, and dispatch-failure records.

## 8.5 Semantics per area

**Identity & correlation** (`correlation.ts`): mint `messageId` at `message_start`, `toolCallId` at `tool_execution_start` (Pi's id preserved as `runtimeToolCallId`), `runId` at `agent_start`, `approvalId` at `extension_ui_request`. Echo suppression: `prompt/steer/followUp` register `{messageId, textHash}` expectations consumed by the next matching Pi UserMessage. Resolver registry `approvalId → Pi dialog resolver`, cleared on response/cancel/disposal.

**Tool execution:** `tool_execution_update` streams accumulated output; the adapter diffs and emits only the new suffix (`reset:true` full replacement if Pi rewrites earlier output). Adapter hard-caps any single value handed to core at 8 MB with `{truncated:true, originalBytes}` markers; storage's blob spill applies below that.

**Approvals (P14 + P20 bridge):** two sources — (1) Pi extension dialogs (`extension_ui_request` kinds confirm/select/input/editor), (2) Agena tool-approval policy via the internal `agena-bridge` Pi extension (a `pi.on('tool_call')` hook consulting a core-injected policy; deny → `tool-call-denied`). The bridge is **temporary internal plumbing** (ADR-0003). Response path — **order fixed to close the review gap**: (a) core validates the response against **its own pending-approval record** (approvalId known + kind matches the request) *before* anything durable — invalid → command `error INVALID_PAYLOAD`/`APPROVAL_NOT_PENDING`, nothing appended; (b) core appends `approval.responded` in its tx; (c) core calls `runtimeSession.respondToApproval` → adapter resolves the Pi resolver. If the adapter fails *after* the valid append, that is a runtime-error path (`run.failed` / `approval.cancelled {reason:"runtime_cancelled"}`), never a silent rejection — the already-fanned-out response stands. On abort/shutdown/disposal with approvals pending, the adapter cancel-resolves each Pi dialog; core appends `approval.cancelled` per the §5.6 matrix.

**Model switching:** command path — core calls `setModel`; **only after the Pi call resolves** does core append `model.changed {reason:"user_selected"}` (no phantom switches). Runtime path — the adapter watches `session.agent.state.model` at turn boundaries and run start; a difference emits `model-changed {origin:'runtime'}`. Core maps the RuntimeEvent's two-value `origin` to the durable `reason` enum (§5.5): `'command'` → `"user_selected"`; `'runtime'` → `"fallback"` when it stems from `modelFallbackMessage` at session start (§8.3), `"auto"` otherwise. Every `message.assistant.*` payload carries its producing model. Per §5.4, `setModel` is idle-only in v1 — "model switch between turns", not mid-generation.

**Compaction:** user (`compact` command) and Pi auto-compaction surface identically through `compaction_start/end`. Core mints `compactionId` and stamps `replacesUpToSeq` (last committed seq at compaction start) and wraps the summary string into `ContentBlock[]` — closing the field-mapping gap between the runtime event and `CompactionCreated`.

**Steer/followUp/queueing/retries:** queued text is durable as `message.user.created {queued}` (the payload field is `queued` — the runtime draft's `mode` is dead), appended by core at command time. `queue_update` → frame only. Retries → frames only; exhausted retries terminate through `run-failed` + `assistant-message-failed` (durable). Long backoffs visible to reconnecting clients via `snapshot.retry`.

## 8.6 Abort, failure, and crash semantics (P2)

The adapter maintains a **mirror in-flight buffer** (`inflight.ts`): every delta forwarded is also accumulated locally per message/tool. `getInFlightSnapshot()` reads `session.agent.state.streamingMessage` as the authoritative message plus the mirror for tool output; terminal-event *synthesis* uses only the mirror — partial content survives even when the Pi session object is broken.

- **User abort:** `abort('user')` → `await session.abort()`. If Pi emits its own terminal events, map normally; if Pi is silent for 3 s (`runtime.abortGraceMs`), synthesize from the mirror: `tool-call-aborted` per open tool → `assistant-message-aborted {partialContent, reason:'user'}` → `run-aborted`. Late Pi duplicates are deduped by id (terminal events are emit-once per id). Durable outcome: the §5.6 user-abort column.
- **Pi throws mid-generation:** rejection handlers on the un-awaited `prompt()`, wrapped subscribe callbacks, wrapped port methods. Synthesize in order: `tool-call-aborted {reason:'runtime-error'}` per open tool → `assistant-message-failed {partialContent, error}` if streaming → `run-failed`. Cancel-resolve pending dialogs (core appends `approval.cancelled`). Session → `errored`; `events()` completes after the synthesized tail; core disposes and rehydrates from JSONL on the next command.
- **Dispatch failure (the reviewed gap):** if `prompt/steer/followUp` throws **after** `message.user.created` committed (bad model ref, broken extension at hydrate, auth failure), core (a) returns the command error to the issuer, (b) appends durable `run.failed { runId: <minted>, phase:"dispatch", triggerMessageId, error }` so every other client sees why the prompt went nowhere, and (c) clears the echo-suppression expectation for that messageId. `FakeRuntimeAdapter.failNextPrompt` asserts this durable outcome.
- **Graceful shutdown:** `adapter.dispose()` → per active run, the user-abort flow with `reason:'shutdown'`; pending approvals cancelled; capture tees flushed; Pi sessions disposed — all before core closes the store. A cleanly stopped daemon leaves zero pending work in the log.
- **Hard crash:** the adapter cannot help; core's boot sweep (§7.8) closes everything with the §5.6 crash column. Known, tolerated v1 divergence: a message whose Pi-side `message_end` hit JSONL an instant before the append tx would have committed exists in Pi context but not the Agena log; a future reconcile pass can read the JSONL tail.

## 8.7 Opt-in raw capture tee (P15)

Owned by `runtime-pi/src/capture.ts` (it sees raw events pre-mapping — the `core/capture` variant is dead). Enabled via `rawCapture.enabled` in daemon config or `AGENA_RAW_CAPTURE=1` — the only v1 switches; there is no capture CLI verb (§1.5 owns the verb list). Tees **every raw Pi event exactly as received** (including unknown types) as one JSON line to `/var/lib/agena/captures/<sessionId>/<startedAt>.jsonl`:

```
{"ts":"2026-07-05T12:00:00.000Z","sessionId":"01J…","piSdkVersion":"0.x.y","event":{…raw Pi event…}}
```

Rules: rotate at 64 MB; fire-and-forget (tee failure logs and disables capture for the session, never blocks the pump); a disk tee, NOT a table; under `/var/lib/agena`, so outside snapshots by construction. Captures contain conversation content — sensitive, off by default, TTL cleanup provided; stopping capture means clearing the config/env switch. Purposes: fixture generation and "what did Pi actually send" debugging.

## 8.8 Testing: FakeRuntimeAdapter and fixture replay (P16)

**`FakeRuntimeAdapter`** lives in `packages/core` at `src/testing/`, exported via the `@agena/core/testing` subpath (not a separate workspace package) — implements the core-owned interfaces with zero Pi imports, so daemon/storage/client/TUI tests run with zero model calls:

```ts
const fake = new FakeRuntimeAdapter();
const script = fake.scriptSession(sessionId);
script.onPrompt((text) => [
  step.runStarted(),
  step.assistantMessage('Hello, ', 'world', { deltaChunks: true }),
  step.toolCall('read_file', { path: 'a.ts' }, { output: '…', status: 'ok' }),
  step.runCompleted(),
]);
script.onPrompt(() => [step.runStarted(), step.approvalRequest({ kind: 'confirm', message: 'rm -rf?' })]);
fake.failNextPrompt(new Error('provider 500'));    // → §8.6 dispatch-failure durable outcome asserted
fake.crashMidMessage(sessionId);                   // events() ends abruptly → exercises the boot sweep
```

Deterministic, honors the same emit-once terminal-event guarantees, implements `getInFlightSnapshot()` from its script position.

**Fixture replay:** `event-map.ts` is pure, so contract tests fold a recorded capture through `mapPiEvent` and snapshot-compare `RuntimeEvent[]` against `<scenario>.expected.json`. Committed scenarios: plain text; thinking+text; single tool call; parallel tool calls with streamed output; abort mid-text; abort mid-tool; provider error mid-generation; auto-retry then success; compaction (auto+user); approval confirm+deny; extension notify/setStatus/setTitle; steer/followUp queueing; model fallback at start. Recording is a dev-only script (`pnpm --filter @agena/runtime-pi record-fixture -- --scenario tool-call`); CI only replays.

## 8.9 Pi version pinning and upgrade procedure

- All `@earendil-works/*` packages pinned **exact** via `pnpm-workspace.yaml` `overrides` (runtime-pi and tui can never drift apart); the boundary check fails the build on Pi imports outside their sanctioned packages. `versions.ts` exports `PI_SDK_VERSION`, surfaced at `/v1/diagnostics`.
- Upgrade playbook (`packages/runtime-pi/UPGRADING.md`): bump pin on a branch → run fixture replay suite → diff Pi's changelog for new/changed subscribe event types (unknown types are already non-fatal) → re-record fixtures into `fixtures/pi/<new-version>/` where shapes changed → verify `SessionManager.open` on an old JSONL (open succeeds, message count preserved) → run the walking-skeleton e2e.
- Nightly `pi-canary.yml` replays fixtures against `@latest` (allowed to fail) so churn is detected before an upgrade is attempted.

## 8.10 Adapter failure-mode checklist

| Failure | Handling | Durable outcome (§5.6) |
|---|---|---|
| User aborts mid-text | Pi events or 3 s mirror synthesis | `message.assistant.aborted` (partial) + `run.aborted` |
| User aborts mid-tool | open tools closed first | `tool.call.aborted` + `message.assistant.aborted` + `run.aborted` |
| Pi throws mid-generation | synthesis, session → errored, rehydrate on next command | `tool.call.aborted` + `message.assistant.failed` (partial) + `run.failed` |
| Dispatch failure post-commit of user msg | command error + durable record + echo-expectation cleared | `run.failed {phase:"dispatch", triggerMessageId}` |
| Retry backoff, client reconnects | `snapshot.retry` + `run.retry.*` frames | none needed |
| SIGTERM mid-run | abort-with-reason before store close | `…aborted {reason:"daemon_shutdown"}` set |
| kill -9 / OOM | core boot sweep (§7.8) | `…{code/reason:"daemon_restart"}` set; partials lost by design |
| Pending approval at abort/crash | cancel-resolve dialogs / sweep | `approval.cancelled` per pending id |
| Unknown Pi event | warn + counter + capture, no client output | none |
| Oversized tool args/result | 8 MB truncation marker; blob spill below | truncated payload, flagged |
| Capture tee I/O error | disable capture for session, log | none |
| Second `events()` consumer | throws immediately | none |
| Malformed `respondToApproval` | rejected by core's pending-set check BEFORE append | none |

---

# 9. Daemon: Transport, Concurrency, Lifecycle

The daemon (`apps/daemon`, Node) is the single long-lived process in the workspace container: it owns transport (HTTP + WS), hosts core's session orchestration, embeds Pi through the `RuntimeAdapter` port, and manages PTYs. It is the only process touching the event store. The identical binary later runs in a cloud workspace with zero protocol changes.

## 9.1 Process model

One daemon = one workspace = one container (v1). Runtime: Node (node-pty + Pi SDK stability). The container runs under `tini`; `stop_grace_period: 30s` bounds the shutdown budget. Domain logic lives in `packages/core`; the daemon is the composition root plus transport adapters (module tree in §4.1). Core services hosted here:

```ts
// packages/core — one instance per live session
interface SessionOrchestrator {
  readonly sessionId: string;
  state(): "idle" | "generating" | "draining";
  handle(cmd: SessionCommand, ctx: CommandContext): Promise<CommandResult>;   // FIFO, one at a time
  inFlightSnapshot(): Promise<InFlightSnapshot | null>;   // wire shape, via toWireSnapshot()
  dispose(reason: DisposeReason): Promise<void>;
}
interface SessionRegistry {
  get(sessionId: string): SessionOrchestrator | undefined;
  ensure(sessionId: string): Promise<SessionOrchestrator>;   // lazy runtime attach
  active(): SessionOrchestrator[];
}
type CommandContext = { clientId: string };   // from hello; becomes EventSource.clientId (P3)
```

Attribution is `EventSource.clientId` — there is no payload-embedded `connId`/`clientInfo` (that draft variant is dead); `connId` remains a logging correlation field only.

## 9.2 Bootstrap sequence

1. **Config**: read `AGENA_*` env, overlay onto `/var/lib/agena/config/daemon.json`, Zod-validate. Create the state tree (0700). Validate `AGENA_WORKSPACE_ID` against persisted config — **fatal on mismatch** (catches mis-wired volumes). Persist `AGENA_AUTH_TOKEN` to `config/token` (0600); generate one only if absent.
2. **Logger**: pino JSON to stdout + `logs/daemon.log` with the redaction list installed.
3. **Secrets**: load `config/secrets.env` (if present) into `process.env` (env takes precedence); record presence-only metadata.
4. **Store**: per `storage.kind` — `"memory"` (M1: `InMemoryEventStore`, P8) or `"sqlite"`: Drizzle migrations, `PRAGMA quick_check`, WAL. Create the workspace **control session** if absent (id in `meta`); append `workspace.initialized` on true first boot.
5. **Crash recovery**: `reconcileOpenWork()` (§7.8) plus: sweep `snapshots/tmp/`, check `restore.journal` (§10.5), sweep `.agena-tmp-*` upload temps — all **before any client can connect** (P2).
6. **Runtime adapter**: `"pi"` (runtime-pi, capture tee injected when `rawCapture.enabled`) or `"fake"` (@agena/core/testing — the whole daemon boots and passes integration tests with zero model calls, P16).
7. **Core services**: `SessionRegistry`, approval service; register `FanoutHub.publishCommitted` as the store's `onCommitted` listener (§6.2).
8. **Transport**: Hono app + WS upgrade router on one Node `http.Server`; PTY manager.
9. **Listen** on `0.0.0.0:7777` in-container (host publish is loopback-only, §10.3). Write `daemon.pid`; `/health` flips to `ok`.
10. **Signals**: SIGTERM/SIGINT → `shutdown.ts` (§9.7).

If `/workspace` has no `.agena/`, scaffold `/workspace/.agena/{config.json,tools/,skills/,hooks/}` once (never overwrite user content) — this scaffold plus `.agena/.types/` regeneration are the only daemon writes under `/workspace` (documented carve-out, §12).

## 9.3 HTTP route table (authoritative; schemas in `packages/protocol/src/http.ts`)

All routes Zod-validated, return the `AgenaError` envelope on failure, and require `Authorization: Bearer <token>` — except `GET /health`. Cold reads are HTTP; interactive session commands are WS-only. This is the **one** route table; the drafts' `/v1/workspace/*` file family, `/v1/sessions/search`, `/v1/rebuild`, and `/v1/pty/:ptyId` spellings are dead.

| Method | Path | Purpose | Notes |
|---|---|---|---|
| GET | `/health` | Liveness | Unauthenticated. `{status:"ok"\|"starting"\|"draining"\|"restore_incomplete", version, protocolVersion, uptimeMs}` |
| POST | `/v1/sessions` | Create session | `{title?, model?, thinkingLevel?, scope:{kind, projectId?, projectRoot?, cwd?, hostCwdHint?}}`; appends `session.created` |
| GET | `/v1/sessions` | List | `?projectId=&scope=project\|global&allProjects=0|1&status=&source=&limit=&cursor=` (ULID keyset). Control session excluded by default (`?includeControl=1`) |
| GET | `/v1/sessions/:id` | Read one | Includes `lastSeq`, `status`, `activeBranchId`, `source`, `scope`, `projectId`, `cwd` |
| PATCH | `/v1/sessions/:id` | Rename/archive | Appends `session.title.changed` / `session.status.changed` |
| GET | `/v1/sessions/:id/events` | **Cold read with fromSeq** | `?fromSeq=0&limit=500&branchId=` → `{events, nextFromSeq}`; `limit` max 2000; branch reads follow INV-11; identical `AgenaEvent` shape to WS replay |
| POST | `/v1/sessions/:id/fork` | Create branch | `{fromSeq, name?}`; appends `branch.created` (+`branch.switched`) |
| GET | `/v1/search` | Full-text search | `?q=&limit=` → FTS5 hits `{sessionId, messageId, snippet, rank, seq}` (P7) |
| GET | `/v1/approvals` | Pending approvals | `?pending=1` → events-scan-derived list; backs `agena approvals` |
| GET | `/v1/files` | List directory | `?path=/&depth=1&cursor=` → `{name,type,size,mtime,mode}[]`; 10k entries/page |
| GET | `/v1/files/content` | Read file | `?path=` → streamed bytes; ETag; Range supported |
| PUT | `/v1/files/content` | Write file | streamed, atomic tmp+rename; `?mkdirp=1`; `If-Match` honored (`412 PRECONDITION_FAILED`) |
| DELETE | `/v1/files` | Delete | `?recursive=1` required for non-empty dirs |
| POST | `/v1/files/mkdir` | `{path}` | |
| POST | `/v1/files/move` | `{from, to}` | |
| GET | `/v1/files/archive` | Directory download | `?path=` → tar.zst stream (backs `agena files get -r`) |
| POST | `/v1/files/upload` | Upload | `?path=&format=tar\|raw` — tar.zst stream in (backs `agena files put -r` and workspace seeding); cap 512 MiB → `413` |
| GET | `/v1/ports` | List workspace preview ports | Runtime registry: `{port, protocol, label?, state, previewUrl?, visibility}` |
| POST | `/v1/ports/:port/expose` | Create/update preview URL | `{protocol?, label?, visibility?}`; v1 defaults to authenticated/private preview |
| DELETE | `/v1/ports/:port` | Hide preview URL | Does not kill the listening process |
| POST | `/v1/snapshots` | Create snapshot | `{name?, kind?, triggeredBySessionId?}`; §10.5 |
| GET | `/v1/snapshots` | List | |
| POST | `/v1/snapshots/:id/restore` | Restore `/workspace` only | `409 CONFLICT` with blocker list; `{force:true}` aborts turns/PTYs first (with P2 events). **Never touches the event store** |
| DELETE | `/v1/snapshots/:id` | Delete artifact + append `snapshot.deleted` | |
| POST | `/v1/ptys` | Create PTY | `{cols, rows, cwd?, sessionId?, command?, args?}` → `{ptyId, wsPath}`; `sessionId` defaults cwd from the session record |
| GET | `/v1/ptys` | List live PTYs | |
| DELETE | `/v1/ptys/:id` | Kill PTY | SIGHUP, SIGKILL after 5 s |
| GET | `/v1/blobs/:hash` | Fetch spilled blob | streamed; backed by `EventStore.readBlob` |
| POST | `/v1/imports` | Import upload | tar stream + `{source, machineId}`; raw archive → normalize → summarize (§9.6) |
| GET | `/v1/imports/:id` | Import status/stats | |
| GET | `/v1/providers` | List Pi model providers and secret-free auth status | Provider/model availability comes from the pinned Pi registry; no credential values are returned. |
| PUT | `/v1/providers/:id/api-key` | Save or replace a provider API key | Persists through Pi `AuthStorage`; accepts optional provider-scoped configuration values. |
| DELETE | `/v1/providers/:id/auth` | Remove stored provider credentials | Ambient deployment credentials may still make the provider available and are never mutated. |
| POST | `/v1/providers/:id/oauth/start` | Start Pi subscription OAuth | Returns a daemon-owned flow plus the current URL, device-code, prompt, selection, or progress interaction. |
| GET | `/v1/providers/oauth/:flowId` | Read provider OAuth flow status | Secret-free pending/completed/failed/cancelled state. |
| POST | `/v1/providers/oauth/:flowId/respond` | Answer or cancel an OAuth interaction | Handles Pi prompt, manual-code, and selection callbacks; auth URLs are opened by the desktop in the system browser. |
| GET | `/v1/mcps` | List imported MCP definitions/status | Source-neutral; no secret values or source-harness provenance. |
| POST | `/v1/mcps/import` | Import one normalized MCP | OAuth definitions become `needs_authorization`; static secrets are encrypted before registry commit. |
| POST | `/v1/mcps/:id/oauth/start` | Start fresh Agena OAuth | Returns an authorization URL; PKCE/state and client registration stay daemon-owned. |
| POST | `/v1/mcps/:id/oauth/complete` | Complete OAuth callback relay | Electron relays the localhost redirect; daemon validates state and stores rotated credentials. |
| GET | `/v1/skills` | List Agena-managed skills | Source-neutral metadata; package bytes stay under daemon state. |
| POST | `/v1/skills/import` | Import one normalized skill package | Validates paths/frontmatter, deduplicates, installs atomically, then reloads idle runtimes. |
| POST | `/v1/skills/check-updates` | Check managed Git sources | Updates status only; unmanaged/local-only skills remain usable. |
| POST | `/v1/skills/:id/update` | Install the current upstream revision | Staged validation + atomic swap; previous package remains active on failure. |
| POST | `/v1/admin/rebuild` | Rebuild projections + FTS | backs `agena rebuild` (P7) |
| GET | `/v1/diagnostics` | Deep diagnostics | §9.9; the remote half of `agena info` |
| GET | `/v1/ws` | *(upgrade)* main multiplexed WS | §5 |
| GET | `/v1/ptys/:id/ws` | *(upgrade)* dedicated PTY WS | §9.5 |

Global limits (`middleware/limits.ts`): JSON bodies 1 MiB except file routes; request timeout 30 s except streaming; oversized → `413 PAYLOAD_TOO_LARGE`; the store's post-spill cap is **128 KiB** (§7.7).

Settings exposes these routes as a `Providers` section using the same list rows, status dots, badges, fields, and inline progress treatment as the other settings sections. API keys and provider-scoped settings are write-only; OAuth URLs and device verification open in the system browser, with loopback callbacks relayed by Electron to the daemon-owned flow. After every credential mutation the desktop refreshes loaded runtime info. The composer model picker is populated only from Pi's authenticated `ModelRegistry.getAvailable()` result and treats a disconnected current model as unavailable.

Client HTTP typing: `packages/client/src/http.ts` is a small typed fetch wrapper bound to the per-route Zod schemas exported from `protocol/src/http.ts`. (The `hc<AgenaApiType>`/ToSchema conformance machinery from the client draft is dropped — one consumer doesn't justify it; revisit when a second HTTP client exists.)

## 9.4 WS gateway behavior

The gateway implements §5 exactly (envelope, handshake, command catalog, error codes — no local variants). Daemon-specific behavior:

- Auth checked before completing the upgrade (`401` raw HTTP; never a half-open socket). Browser clients are future (`POST /v1/ws-tickets` is the documented path, not built in v1).
- Subscribe uses the buffer-then-splice replay of §6.3.
- requestId dedupe map per INV-7: bounded LRU (per-session cap), TTL 5 min, survives reconnects (it is keyed by requestId, not connection).
- Per-command legality per the §5.4 matrix; the orchestrator's FIFO makes multi-client behavior deterministic.
- Approvals: `approval.requested` fans out to all subscribed clients; `respondToApproval` does a compare-and-set on core's pending map (winner appends `approval.responded`; losers get `APPROVAL_NOT_PENDING`). Pending approvals are rebuilt from events at session load and restated in every `snapshot`.
- Backpressure per §6.4; slow-consumer close is `4429`.

## 9.5 PTY manager: dedicated per-PTY WebSocket (P5)

Terminal bytes flow **only** here. No terminal frames on the main channel in v1 (`terminal.output.chunk` reserved future/optional).

- `POST /v1/ptys` spawns via node-pty: `pty.shell` (default `/bin/bash -l`), cwd = the session's durable cwd when `sessionId` is present, otherwise the validated request cwd/current project scope, falling back to `/workspace` only for global/unscoped shells. `TERM=xterm-256color`, env sanitized (provider keys stripped unless `pty.exposeProviderKeys: true`).
- With `sessionId`: append `terminal.session.started` / `terminal.session.ended` (§5.5 payloads, `source {kind:"terminal"}`) — metadata only, never bytes. Without: no durable events (matches §1.5).
- One interactive attachment at a time; second upgrade → close `4409`.
- **Detach ≠ death**: PTY survives WS disconnect; 256 KiB scrollback ring replayed on reattach; unattached PTYs reaped after 15 min; `DELETE /v1/ptys/:id` kills immediately.
- Framing on `GET /v1/ptys/:id/ws` (schemas in `protocol/src/pty.ts` — the one shape): **binary frames = raw PTY bytes, verbatim, both directions**; text frames = control JSON only — client→daemon `{"type":"resize","cols":211,"rows":52}`, daemon→client `{"type":"exit","exitCode":0,"signal":null}` then close `1000`. Auth: bearer header on the upgrade (same as everything).
- Flow control without loss: terminal bytes are not droppable within a live attachment; `bufferedAmount > 1 MiB` → `pty.pause()`, resume below 256 KiB.
- **Reattach-after-resize:** the client re-sends its current size before ring replay renders; after replay the daemon issues a double-resize nudge (forces SIGWINCH) so full-screen apps repaint. Scrollback rendered for the old width may appear wrapped — documented v1 limitation.
- Boot recovery reconciles the registry: all PTYs died with the process; every session-linked dangling `terminal.session.started` gets `terminal.session.ended {exitCode:null, reason:"daemon_restart"}` (§7.8).

## 9.6 Importers (ownership: apps/daemon/src/importers/ + this section)

The import pipeline (three layers from the direction doc) is owned here; the CLI is a thin local reader/uploader.

- **Wire contract:** `POST /v1/imports` accepts a `tar.zst` stream (body) with query/header params `{source: "claude"|"codex", machineId}`. Response `{importId}`; progress/stats at `GET /v1/imports/:id`.
- **Layer 1 — raw archive:** stream lands untouched at `/var/lib/agena/raw-imports/<source>/<machine-id>/<imported-at>/`; never mutated; never a read path for features.
- **Layer 2 — normalized events:** per source session, parse (Claude: `~/.claude/projects` JSONL conversations; Codex: its session store) and map to Agena events — `session.created {origin:"import.claude"|"import.codex"}`, `message.user.created`, `message.assistant.completed`, `tool.call.started/completed` where reconstructable — appended through the standard `appendEvents` path with `source {kind:"importer"}` (P3). Malformed lines are skipped and counted in `imports.stats`. Perfect replay is explicitly not attempted.
- **Layer 3 — resume summary:** deterministic extraction at import time (title, key files, commands, models — no model call); the LLM continuation summary is generated lazily on first `agena resume` of an imported session and stored as `import.summary.created` (once) — §18-OD4.
- **Idempotency rule (one rule):** `source_ref` is identity (re-import of a known ref is a no-op), `content_hash` is change detection (a changed source re-imports as an update pass).
- **Read-only enforcement:** sessions with `source != 'native'` reject `prompt/steer/followUp/abort/setModel/setThinkingLevel/compact` with `SESSION_READ_ONLY`; `agena resume <imported>` starts a **new native session** seeded with the continuation prompt.
- Importer event ids: pre-supplied `NewEvent.id` ULIDs derived from `(source_ref, position)` make event-level re-import dedupe cheap (unique `idx_events_id`).
- The importer writes nothing to `/workspace` (P1).

### MCP import

The desktop main process scans Claude Code and Codex MCP configuration, normalizes and deduplicates it, and exposes one source-neutral list to the renderer. Harness names and source paths are diagnostic-only local data and never become product identity. Remote identity is the canonical MCP URL; stdio identity is the normalized command, arguments, and non-secret environment-variable names.

- Settings has sibling `Session import` and `MCP import` entries. MCP rows show `not imported`, `imported · not verified`, `changed`, `needs authorization`, `ready`, or `error`; `ready` means credentials are usable, while the adapter connects lazily on first use.
- OAuth imports copy definitions only, then perform a fresh Agena OAuth authorization. Claude/Codex tokens and refresh tokens remain untouched.
- Desktop OAuth always opens in the user's system browser so existing passkeys, password managers, and browser sessions work. Electron main first binds the loopback callback, then opens the URL and relays the complete redirect to the daemon without exposing the authorization code to renderer state. This applies equally to Settings and model-triggered `mcp` authentication. The embedded browser's external-link action opens its current URL in the system browser; it does not create a second Electron window.
- Static API-key/header/env credentials may be copied only after explicit consent, through Electron main directly to the authenticated daemon; secret values never cross renderer state.
- Pi has no built-in MCP. Agena pins and explicitly loads the audited `pi-mcp-adapter` extension while filesystem extension discovery remains disabled. Agena owns registry, secret storage, OAuth callback relay, refresh persistence, and policy; the adapter supplies protocol/transport and the token-efficient `mcp` tool bridge behind `RuntimeAdapter`.
- A successful MCP import reloads extensions in every idle runtime session before the route returns. Busy sessions mark the reload pending and apply it immediately after their current run, so existing chats adopt new MCP definitions without being recreated.
- The default model-facing surface is one discovery proxy tool; explicitly promoted direct tools are an opt-in optimization. MCP connection/auth status is workspace state, not session history.

### Skill import

Electron main scans the enabled Claude Code and Codex skill roots, including
project-local and installed plugin skill directories, and exposes one source-neutral list. Exact
copies are deduplicated before they reach the renderer. A stable upstream Git
URL plus repository-relative skill path is identity when available; otherwise
the canonical package-content hash is identity. A name match alone never merges
different content.

- Settings adds `Skill import` beside session and MCP import. Import is a
  one-time migration: the complete package (`SKILL.md` plus scripts, references,
  templates, and assets) is copied atomically to `/var/lib/agena/skills`, while
  SQLite records identity, content hash, provenance, installed revision, update
  status, and timestamps.
- Skill packages are daemon state on the existing `agena-state` Modal Volume,
  so application image replacement neither removes nor reinstalls them.
  `environment.toml` remains the apt/system-package reconstruction manifest and
  does not duplicate skill state.
- Agena checks recorded Git provenance directly for updates. A failed or
  unavailable upstream check never disables the installed package. Updates are
  staged and validated before the active directory is atomically replaced.
- Pi filesystem discovery stays disabled. `runtime-pi` passes only the
  Agena-managed skill root as an explicit SDK skill path, so imported project or
  harness directories cannot become instructions merely by existing.
- Skill import/update uses the same idle-now, busy-after-turn runtime reload seam
  as MCP import.

## 9.7 Graceful shutdown (SIGTERM/SIGINT) — P2 shutdown case

Budget: 10 s drain + 3 s flush < 30 s `stop_grace_period`. Sequence:

1. `/health` → `draining`; stop accepting new connections.
2. Gateway rejects state-changing commands with `DAEMON_SHUTTING_DOWN`; `abort` and `respondToApproval` stay allowed.
3. Per active generation, concurrently: capture the in-flight snapshot → runtime `abort('shutdown')` → append the §5.6 SIGTERM column (`message.assistant.aborted {reason:"daemon_shutdown", partialContent}`, `tool.call.aborted`, `run.aborted`, `approval.cancelled`).
4. Wait for appends up to 10 s; stragglers force-aborted, their events still append.
5. Fan out the final committed events; flush per-connection queues up to 3 s; close all main WS with `1001`.
6. Kill PTYs: SIGHUP, `{"type":"exit"}` control frame, close; append `terminal.session.ended {reason:"killed"}` for session-linked PTYs.
7. Store: `wal_checkpoint(TRUNCATE)`, close; flush logger; remove `daemon.pid`; exit 0.

A second signal skips to step 7. SIGKILL at any point degrades to boot recovery (§7.8), which restores the same invariant.

## 9.8 Boot recovery

See §7.8 (`reconcileOpenWork`) — runs at bootstrap step 5, before the listener opens, and is idempotent. Also: sweep upload temps, `snapshots/tmp/`, `restore.journal` handling (§10.5), `PRAGMA quick_check`.

## 9.9 Config, logging, diagnostics, secrets

`/var/lib/agena/config/daemon.json`, Zod-validated; env overlays file. Defaults:

```ts
const DaemonConfig = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.number().int().default(7777),
  workspaceDir: z.string().default("/workspace"),
  stateDir: z.string().default("/var/lib/agena"),
  workspaceId: z.string(),                                     // from AGENA_WORKSPACE_ID; boot-fatal mismatch
  auth: z.object({ token: z.string().min(43).optional() }).default({}),
  storage: z.object({ kind: z.enum(["memory", "sqlite"]).default("sqlite") }).default({}),
  runtime: z.object({
    kind: z.enum(["pi", "fake"]).default("pi"),
    pi: z.object({
      defaultModel: z.string().optional(),
      thinkingLevel: z.enum(["off","minimal","low","medium","high","xhigh"]).default("medium"),
      abortGraceMs: z.number().int().default(3_000),
      idleEvictMs: z.number().int().default(1_800_000),
    }).default({}),
  }).default({}),
  rawCapture: z.object({ enabled: z.boolean().default(false) }).default({}),   // P15 tee (the ONE switch)
  approvals: z.object({ timeoutMs: z.number().int().default(0) }).default({}), // 0 = never expire
  pty: z.object({
    shell: z.string().default("/bin/bash"),
    idleTimeoutMs: z.number().int().default(900_000),          // 15 min (the ONE value)
    scrollbackBytes: z.number().int().default(262_144),
    exposeProviderKeys: z.boolean().default(false),
  }).default({}),
  limits: z.object({
    wsMessageBytes: z.number().int().default(1_048_576),
    promptBytes: z.number().int().default(262_144),
    frameSoftWatermark: z.number().int().default(1_048_576),
    frameDropWatermark: z.number().int().default(4_194_304),
    eventHardWatermark: z.number().int().default(16_777_216),
    stallTimeoutMs: z.number().int().default(15_000),
    requestIdDedupeTtlMs: z.number().int().default(300_000),
  }).default({}),
  shutdown: z.object({ drainTimeoutMs: z.number().int().default(10_000),
                       flushTimeoutMs: z.number().int().default(3_000) }).default({}),
  log: z.object({ level: z.enum(["trace","debug","info","warn","error"]).default("info") }).default({}),
});
```

Env overlay: `AGENA_HOST`, `AGENA_PORT`, `AGENA_AUTH_TOKEN`, `AGENA_STATE_DIR`, `AGENA_WORKSPACE_DIR`, `AGENA_WORKSPACE_ID`, `AGENA_LOG_LEVEL`, `AGENA_STORAGE`, `AGENA_RUNTIME`, `AGENA_RAW_CAPTURE=1`. Daemon operational config never lives in `/workspace/.agena/config.json` (that file is the user-authored plugin/workspace config, P20).

**Logging:** pino JSON to stdout + `logs/daemon.log` (rotated 50 MiB × 5); correlation fields `connId`, `sessionId`, `requestId`, `ptyId`; redaction installed at construction (secret env names, Authorization headers, key-shaped strings `sk-…`/`AKIA…`).

**`GET /v1/diagnostics`** returns one JSON document — daemon/protocol/Node versions, runtime kind + pinned `PI_SDK_VERSION` + active runtime sessions, storage stats, gateway counters (`framesCoalesced`, `framesDropped`, `slowConsumerCloses`), generating/idle/pendingApprovals counts, live PTYs, **running processes and listening ports inside the container** (`procps`-derived — the direction-doc visibility item, consciously minimal), rawCapture status, secrets **presence booleans only**, redacted config, last-50 error ring buffer.

**Secrets:** Pi resolves credentials in its documented order: runtime override > `pi/auth.json` > process environment > custom-model fallback. Settings writes only `pi/auth.json`; container env (`provider.env`) and `config/secrets.env` remain deployment-owned inputs. One module maintains the known-key list driving loading, redaction, diagnostics flags, and PTY env stripping. Keys never appear in command payloads, events, frames, config responses, or logs; there is no code path from a secret to `appendEvents`.

**Auth:** `TokenVerifier` interface (`verify(req) → Promise<Principal | null>`), constant-time comparison, 100 ms throttle per remote address after failures; cloud swaps in a JWT/OIDC verifier with zero route changes. `/health` is the only unauthenticated route.

---

# 10. Docker, Filesystem & Cloud Path

## 10.1 The three-volume rule (P1)

Daemon state, workspace files, and the user environment live on **separate named Docker volumes at separate mount points**. Snapshot exclusion of daemon state and credentials is structural, not an exclude-list.

| Mount point | Volume name | Owner | Contents |
|---|---|---|---|
| `/workspace` | `agena-ws-<workspaceId>` | user + agent | repo tree + `.agena/` |
| `/var/lib/agena` | `agena-state-<workspaceId>` | daemon only | §3.3 tree |
| `/home/agena` | `agena-home-<workspaceId>` | user + agent | dotfiles, user-level tools, CLI configuration/credentials |

**Host bind mounts of `/workspace` are not supported in v1** (uid mapping, snapshot semantics, and cloud parity all break); `--from-local` seeds via tar upload, `--git` clones. A `--mount-host` escape hatch is a possible future.

`/workspace` rules: repo root IS the workspace root; `.agena/` may be committed or gitignored and is fully captured by snapshots; Pi's `.pi/` auto-discovery is disabled (§8.3). Agena may scaffold `.agena/`, regenerate `.types/`, and update `environment.toml` after successful package-manager mutations (§12). `/var/lib/agena` and `/home/agena` are 0700 and excluded from workspace snapshots. Known v1 limitation: `agena shell` PTYs run as the same uid and could technically touch daemon state; split-uid hardening is post-v1.

## 10.2 Dockerfile

Multi-stage; multi-arch (`linux/amd64`, `linux/arm64`).

```dockerfile
# docker/Dockerfile
# ---- build stage ----
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/daemon/package.json apps/daemon/
COPY packages/protocol/package.json packages/protocol/
COPY packages/core/package.json packages/core/
COPY packages/runtime-pi/package.json packages/runtime-pi/
COPY packages/storage-sqlite/package.json packages/storage-sqlite/
RUN pnpm install --frozen-lockfile --filter @agena/daemon...
COPY . .
RUN pnpm --filter @agena/daemon... build
RUN pnpm deploy --filter @agena/daemon --prod /out   # carries compiled node-pty .node binaries

# ---- runtime stage ----
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl tini zstd bash ripgrep procps less \
    && rm -rf /var/lib/apt/lists/*
RUN userdel -r node && useradd -m -u 1000 -s /bin/bash agena
COPY --from=build /out /opt/agena
ENV NODE_ENV=production AGENA_STATE_DIR=/var/lib/agena AGENA_WORKSPACE_DIR=/workspace \
    HOME=/home/agena XDG_CONFIG_HOME=/home/agena/.config AGENA_PORT=7777
RUN mkdir -p /var/lib/agena /workspace /home/agena && chown agena:agena /var/lib/agena /workspace /home/agena \
    && chmod 700 /var/lib/agena
USER agena
WORKDIR /workspace
VOLUME ["/workspace", "/var/lib/agena", "/home/agena"]
EXPOSE 7777
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:7777/health || exit 1
ENTRYPOINT ["tini", "--", "node", "/opt/agena/dist/main.js"]
```

There is **no `entrypoint.sh`** — daemon bootstrap step 1 owns directory/token creation. `zstd` backs `tar --zstd`; `tini` reaps orphaned PTY children; `bash/ripgrep/procps/git/less` are the minimal `agena shell` toolset.

## 10.3 compose.yml (rendered per workspace by `agena workspace init`)

```yaml
# docker/compose.yml — project name agena-<name>
name: agena-${AGENA_WORKSPACE_NAME}
services:
  daemon:
    image: ghcr.io/agena/daemon:${AGENA_IMAGE_TAG:-0.1.0}
    build: { context: .., dockerfile: docker/Dockerfile }
    restart: unless-stopped
    ports:
      - "127.0.0.1:${AGENA_HOST_PORT}:7777"        # loopback-only publish, always
    environment:
      AGENA_WORKSPACE_ID: ${AGENA_WORKSPACE_ID}
      AGENA_WORKSPACE_NAME: ${AGENA_WORKSPACE_NAME}
      AGENA_AUTH_TOKEN: ${AGENA_AUTH_TOKEN}         # CLI-generated (INV-12)
      AGENA_LOG_LEVEL: ${AGENA_LOG_LEVEL:-info}
      AGENA_RAW_CAPTURE: ${AGENA_RAW_CAPTURE:-0}
    env_file:
      - path: ./provider.env                        # provider keys; 0600, gitignored
        required: false
    volumes:
      - workspace:/workspace
      - state:/var/lib/agena
      - home:/home/agena
    mem_limit: 4g
    pids_limit: 2048
    stop_grace_period: 30s
volumes:
  workspace: { name: agena-ws-${AGENA_WORKSPACE_ID} }
  state:     { name: agena-state-${AGENA_WORKSPACE_ID} }
  home:      { name: agena-home-${AGENA_WORKSPACE_ID} }
```

Provider keys may be entered through Settings into Pi's persistent `auth.json`; `provider.env` (0600) remains an optional deployment-owned input for `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. §3.3 governs at-rest handling. Known local tradeoff: env inputs are visible via `docker inspect`; `agena shell` does **not** inherit provider credentials by default (`pty.exposeProviderKeys: false`).

## 10.4 Workspace lifecycle

**v1 stance: one workspace = one container = one daemon = one DB = one three-volume set.** `sessions.workspace_id` always equals `AGENA_WORKSPACE_ID`; mismatch is boot-fatal. The client-side registry, not the daemon, knows about multiple workspaces.

Client-side profile registry lives in `~/.config/agena/config.json` (the ONE location — `~/.agena/*` variants are dead):

```jsonc
// ~/.config/agena/config.json          (credentials.json holds tokens, 0600)
{ "v": 1, "defaultProfile": "myapp",
  "profiles": {
    "myapp": { "workspaceId": "01J1XYZ…", "url": "http://127.0.0.1:7701",
               "composeProject": "agena-myapp", "createdAt": "2026-07-05T…" } } }
```

`agena workspace init [--git <url> | --from-local <path>]`:

1. Mint `workspaceId` (ULID); pick first free host port ≥ 7700; generate 256-bit token; write profile + credentials.
2. Render the compose project (+ `provider.env` template) under `~/.config/agena/projects/<name>/`.
3. `docker compose up -d` (volumes created empty).
4. Seed `/workspace`: `--git` → daemon clones; `--from-local` → CLI streams tar to `POST /v1/files/upload?path=/&format=tar`; neither → empty.
5. Daemon first boot (§9.2): validate ids, migrations, sweeps, control session + `workspace.initialized`, `.agena/` scaffold, listen.
6. CLI verifies `/health`, then an authed `GET /v1/diagnostics`, prints the summary.

`agena workspace open` = `compose start` + wait healthy + attach. Image upgrade normalizes `.agena/environment.toml`, builds or reuses the derived layer keyed by `(Agena base image digest, system package list)`, then replaces the container and reattaches all three volumes (migrations at boot; refuse-to-boot on schema downgrade). `stop` = `compose stop` (SIGTERM → §9.7). `rm` removes container + profile; **volumes survive** unless `--purge` (typed-name confirmation — the only operation that destroys the event store or persistent home).

## 10.5 Snapshots

- **Create** = `tar --zstd` of the entire `/workspace` tree (everything user-owned; no excludes in v1 — predictability beats size), streamed to `snapshots/tmp/<id>.tar.zst` while hashing (sha256) and counting entries → fsync → rename-as-commit → `appendEvents([snapshot.created])` on the **control session** (snapshots projection row in the same tx). HTTP returns after the event commits. Crash mid-create: tmp orphan swept at boot; no event ⇒ no phantom snapshot. Concurrent creates allowed; rejected `409` while a restore is in flight.
- **Restore** (`POST /v1/snapshots/:id/restore`):
  1. Preconditions or `409` with blockers: no active turn, no attached PTY, no other restore. `{force:true}` aborts/closes first (with P2 events).
  2. Verify archive sha256 against the projection row (`422 PRECONDITION_FAILED` with details `{reason:"snapshot_corrupt"}` otherwise; nothing modified).
  3. Take an automatic safety snapshot `kind:"pre_restore"` (the enum includes it — §5.5/§7.3).
  4. Write `restore.journal {snapshotId, safetySnapshotId, startedAt}`; clear `/workspace` entries (never the mount point); extract with `--no-same-owner`, validating member paths through the same path gate (reject absolute/`..` members).
  5. Delete the journal; `appendEvents([snapshot.restored])`; respond.
  - Crash mid-restore: boot finds `restore.journal` → append `snapshot.restore.failed`, `/health` = `restore_incomplete`, agent prompts blocked (file APIs and shell stay up) until the user re-restores the snapshot or the safety snapshot. Session history intact throughout — only files were in flux.
- Restore **never** touches `db/`, events, branches, blobs, captures, or Pi JSONL (P1); the restore is itself new history on the control session.
- Consistency: snapshots are crash-consistent (live-tree tar), not quiesced; `pre_tool` auto-snapshots are effectively quiescent. Documented, accepted.
- Retention: keep everything; `DELETE /v1/snapshots/:id` unlinks + appends `snapshot.deleted`.

## 10.6 File-API path safety

Every file route passes through one gate (`packages/core/src/workspaces/resolve-path.ts`); there is no second code path:

```ts
export async function resolveWorkspacePath(
  root: string,               // realpath of /workspace, computed once at boot
  requested: string,
  opts: { forWrite?: boolean } = {},
): Promise<string> {
  if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0"))
    throw new PathViolation("path_invalid");
  // 1. Lexical containment: normalize, reject residual '..' escapes.
  const rel = posix.normalize(posix.join("/", requested));
  const candidate = posix.join(root, rel.slice(1));
  if (candidate !== root && !candidate.startsWith(root + "/"))
    throw new PathViolation("path_escapes_workspace");
  // 2. Physical containment: realpath the deepest EXISTING ancestor must stay inside root
  //    (blocks: agent plants symlink /workspace/x -> /var/lib/agena, client writes through it).
  const anchor = await realpathDeepestExistingAncestor(candidate);
  if (anchor !== root && !anchor.startsWith(root + "/"))
    throw new PathViolation("path_escapes_workspace");
  // 3. Terminal symlinks never followed for write/delete (lstat + O_NOFOLLOW);
  //    reads through symlinks re-run this gate on the resolved target.
  return candidate;
}
```

Violations → `403 PATH_ESCAPES_WORKSPACE`, logged with the raw path. The property is fuzz-tested (hostile corpus: `../`, `..%2f`, unicode lookalikes, NUL, symlinked ancestors, deep chains). The same gate validates snapshot-restore member paths. Writes are atomic (tmp sibling + fsync + rename; temps hidden from listings, swept when >1 h old); concurrent clients get weak ETags + `If-Match` → `412`. Streaming everywhere; the daemon never buffers a whole file. v1 emits **no** `file.*` durable events and runs no watcher — `source.kind:"filesystem"` is reserved for the future watcher.

## 10.7 Cloud migration path

The v1 container **is** the cloud artifact: same OCI base image on a VM/devbox/microVM with three persistent disks at the same three mount points. A workspace may add one deterministic derived image layer for declared system packages; Agena application releases never write into that layer at runtime.

**Unchanged:** wire protocol (same WS + HTTP + PTY WS, same auth header), storage layout, snapshot format, path-safety rules, `.agena/` surface, boot sequence, one-daemon-per-workspace shape. Migrating a local workspace = copy all three volumes → start the same base plus normalized environment manifest (`agena workspace migrate`, post-v1). The client-side profile `url` field is the only moving part (`https://…`).

**Changed (all in front of the daemon):** (1) TLS terminated by a proxy/LB — the daemon speaks plain HTTP/WS forever; (2) token **provisioning** moves from CLI-generated env to control-plane-issued per-workspace tokens (same bearer check — this is why localhost auth was non-negotiable); (3) secret-manager injection of provider keys + an egress policy layer at the network level. Isolation class (container vs microVM) is a deployment decision, not a design change.

**`agena share` — parked (P9).** Not in v1; the CLI does not register the verb. Future design, one line: an internet-facing gateway (not the daemon) resolves opaque share tokens to `(workspaceId, path-or-snapshot, blobHash)` and serves expiring signed URLs backed by the blob/snapshot store, recorded as `share.link.created` on the control session — the daemon never becomes internet-facing; shared bytes are immutable copies. (ADR-0004.)

---

# 11. Client: CLI, TUI & Shell Attach

Everything on the user's machine: `apps/cli` (the `agena` binary — surface in §1.5), `packages/client` (typed SDK), `packages/tui`. The client renders ONLY normalized Agena events/frames — no Pi types cross into any package here; isolation from Pi churn is structural. Dependency edges per §4.2. The client implements the §5 wire contract verbatim — endpoint `GET /v1/ws`, client-first `hello`/`welcome`, integer `protocolVersion`, the §5.4 command names, the §5.9 error codes, and the `ack → replayed events → sync → snapshot → live` reconnect sequence. (The client draft's `/v1/socket`, server-first hello, semver versions, `prompt.send`/`turn.abort`/`model.set` names, `replay.start/end`, `notice` envelope, and `E_*` codes are all dead.)

## 11.1 packages/client — typed SDK

Layout in §4.1. UI-agnostic; desktop/phone clients later consume it unchanged.

```ts
export class AgenaClient {
  constructor(opts: { baseUrl: string; token: string; clientName: string; clientVersion: string;
                      clientId: string /* stable ULID, persisted locally */ });
  readonly http: TypedHttp;                        // fetch wrapper over protocol http.ts schemas
  connect(): Promise<WelcomeEnvelope>;             // opens /v1/ws, sends hello, awaits welcome
  subscribe(sessionId: string, fromSeq: number, branchId?: string): SessionSubscription;
  command(name: CommandName, payload: unknown): Promise<unknown>;   // requestId managed internally
  openShell(opts: ShellOpenOptions): Promise<ShellConnection>;
  close(): Promise<void>;                          // unsubscribe, WS close 1000
}
```

**Command semantics:** `command()` resolves on `ack`, rejects on `error` or after the 30 s timeout (`TIMEOUT`). Disconnect mid-command: after reconnect the client re-sends every unacked command with its **original** `requestId`, exactly once; the daemon's 5-minute dedupe map (INV-7) re-acks executed ones without re-execution — no double prompts, no lost prompts. On `SESSION_BUSY` for `prompt`, the TUI shows the steer/follow-up chooser; scripts get the clean error.

**Reconnect & backoff:** exponential with full jitter (base 250 ms, ×2, cap 10 s; reset after 30 s healthy). Close `1001` ⇒ "daemon restarting" UX and backoff starts at 1 s. The daemon pings (15 s); the client answers `pong` and treats 45 s of silence as dead. On reconnect: validate `welcome` → re-subscribe every active subscription with `fromSeq = lastApplied` → re-send unacked commands.

**SessionSubscription — ordering, gaps, self-healing:**

```ts
interface SessionSubscription {
  readonly sessionId: string;
  readonly state: "subscribing" | "replaying" | "live" | "reconnecting";
  readonly lastSeq: number;
  on(ev: "event",    fn: (e: AgenaEvent) => void): void;
  on(ev: "frame",    fn: (f: AgenaFrame) => void): void;
  on(ev: "sync",     fn: (upToSeq: number) => void): void;
  on(ev: "snapshot", fn: (s: InFlightSnapshot) => void): void;
  on(ev: "status",   fn: (s: SessionSubscription["state"]) => void): void;
  close(): Promise<void>;
}
```

Hard client-side rules: gap (`seq > lastSeq + 1`) → silent resubscribe from `lastSeq`; duplicates (`seq <= lastSeq`) dropped (apply is idempotent by seq); stale frames (`afterSeq < lastSeq` or targeting finalized entities) dropped; **frames are advisory, never authoritative** — durable terminal events carry full final content and replace any accumulated delta buffer (client face of P12).

**Frame throttling:** per `(sessionId, frameType, targetId)` the SDK coalesces deltas and notifies consumers at most once per 40 ms tick — the second (and last) throttling tier (§6.4).

**Blobs:** payloads may carry the §5.3 `BlobRef`; the client renders `preview` and lazily fetches `GET /v1/blobs/:hash`. Inline blocks > 1 MB are rendered as error blocks (protocol violation), never buffered.

**Local state** (`~/.config/agena/`, §10.4): `config.json` (profiles), `credentials.json` (0600), `state/<profile>/cursors.json`, `history`, `logs/`. `cursors.json` maps `sessionId → { branchId, seq, updatedAt }` — **branch-keyed** (a branch mismatch on resume invalidates the cursor rather than replaying against the wrong lineage), debounced 500 ms, LRU 200. Cursors are an optimization: on corruption/loss, replay from `fromSeq: 0` is safe. A cursor for a session the daemon no longer knows (`SESSION_NOT_FOUND`) is pruned and the picker opens (volume-loss case).

## 11.2 TUI framework decision (P17)

**Prototype on `@earendil-works/pi-tui`.** Recorded reasoning: standalone and explicitly reusable; its three-tier differential renderer (full render / clear-on-resize / cursor-diff under CSI 2026 synchronized output) is built precisely for high-frequency streaming — Agena's core rendering problem; it ships the needed components (Markdown, Editor, Input, SelectList, Loader, Container); Ink has historically struggled with high-frequency stream updates. Fallbacks in order: **Ink**, then **OpenTUI**. Insurance is structural: all pi-tui imports confined to `tui/src/renderer/`; views are thin adapters over a renderer-agnostic store — swapping frameworks replaces the renderer layer, not application logic. Escape trigger: M1 spike blockers in input handling or Bun compatibility ⇒ switch before M2. (ADR-0001.)

## 11.3 TUI architecture

```
AgenaApp
├── StatusBar            # connection ●/◐/○, workspace, session title, model, thinking level,
│                        # pending-approvals badge, "replaying…" spinner
├── SessionView
│   ├── StreamView       # scrollback of finalized blocks + exactly one InProgressTail
│   │   ├── MessageBlock / ToolCallBlock / MarkerBlock / InProgressTail
│   ├── ApprovalModal    # overlay, focus-trapping, FIFO queue if multiple pending
│   └── PromptEditor     # multiline, history, paste-safe
├── SessionPicker        # fuzzy list over GET /v1/sessions (+ search)
├── CommandPalette
└── ToastLine
```

**Store: durable events finalize, frames update in place** — a strict two-tier split mirroring the protocol:

```ts
type SessionViewModel = {
  finalized: Block[];              // ONLY from durable events; append-ordered by seq
  inFlight: {                      // ONLY from frames + the reconnect snapshot
    assistant?: { messageId: string; text: string; thinking: string };
    tools: Map<string, { toolCallId: string; output: string }>;
  };
  pendingApprovals: Map<string, ApprovalRequested>;   // requested − resolved
  turnActive: boolean;
  lastSeq: number;
};
applyEvent(vm, event): void;   // appends/updates finalized; CLEARS matching inFlight entry; updates approvals
applyFrame(vm, frame): void;   // touches inFlight ONLY; never finalized
```

- Frames invalidate only the `InProgressTail`, throttled to the 40 ms tick; scrollback is never re-rendered by a frame.
- On `message.assistant.completed` the delta buffer is discarded and the block is built from the event's authoritative content. Identical discipline for tools.
- **Abort/crash rendering (P2 client face):** `message.assistant.aborted` renders the partial content plus an `⊘ aborted` marker; `message.assistant.failed` (including crash-recovery `{error.code:"daemon_restart"}` — **the crash case is `failed`, never `aborted`**) renders partial content (possibly empty) plus `✗ failed: <reason>`. A reconnecting TUI can never show a forever-spinning message.

**Replay/reconnect UX:** between `subscribe` ack and `sync`, `applyEvent` runs with rendering suppressed; one invalidation at `sync` — replay renders instantly as final content, no fake re-streaming ("replaying…" shown only past 150 ms). The `snapshot` then populates `inFlight` (partial in-progress message immediately visible), then live frames continue. During disconnect: screen never cleared, content frozen, `reconnecting (attempt n)` in the status bar; after a >25-event catch-up a `— reconnected, caught up N events —` marker is inserted.

**Scrollback & large payloads:** ≤500 finalized blocks in memory; scrolling past the top pages `GET /v1/sessions/:id/events` through the same reducer. Blocks >64 KB rendered text truncate with `[… truncated, o to open]` (fetches the blob into a pager). Tool output collapsed by default.

**Keymap (defaults):** `Enter` submit / steer-chooser when turn active · `Alt+Enter` newline · `Esc Esc` abort · `Ctrl+P` palette · `Ctrl+S` session picker · `Ctrl+T` show/hide shell split · `Ctrl+J` focus/unfocus a visible shell split · `Ctrl+Shift+Up`/`Ctrl+Shift+Down` resize shell split · `Ctrl+C ×2` quit **from chat focus; with the shell pane focused every key except the bindings above — `Ctrl+C` included — passes to the PTY** · `Ctrl+Z` suspend (full repaint on `fg`). Palette actions include: new/resume session, switch model, thinking level, **compact context** (`compact` command), abort, open shell, toggle tool output, respond to approval, copy session id, load earlier history, diagnostics, quit.

**Concurrent clients:** prompts from other devices arrive as `message.user.created` with `source.clientId` and render an origin hint; `SESSION_BUSY` becomes the inline `[s]teer · [f]ollow-up · [Esc]` chooser; approvals resolved elsewhere close the modal via the `approval.responded` event.

## 11.4 Approval UI flow end-to-end (P14)

Invariant: **approval UI state is driven exclusively by durable events; acks only clear spinners.**

1. Daemon appends `approval.requested`; it fans out post-commit to all subscribed clients.
2. Reducer adds to `pendingApprovals`; ApprovalModal opens. Kind mapping: `confirm` → two-button SelectList; `select` → SelectList; `input` → Input; **`editor` → the PromptEditor/pager component** (multiline; the client supports all four §5.4 response kinds).
3. User responds → `respondToApproval` command; modal shows `submitting…` until ack.
4. Daemon validates against the pending set, appends `approval.responded`, resolves the runtime. Every client — including the responder — closes the modal from the EVENT. A losing device gets `APPROVAL_NOT_PENDING` after its modal already closed; toast: "answered on another device".
5. `approval.expired` / `approval.cancelled` close the modal with a marker block.
6. Reconnect/restart: replay reconstructs requested-minus-resolved; unresolved approvals reopen automatically — by construction, not cached state.
7. Headless parity: `agena approvals` / `agena approve` (with `--input-file` for `editor`) use the identical command path — also the future phone-approval path.

## 11.5 agena shell (P5)

Terminal bytes flow ONLY over the dedicated PTY WS (§9.5). Client state machine (shared by standalone `agena shell` and TUI `Ctrl+T`):

```
IDLE → OPENING (POST /v1/ptys; open WS; send initial resize)
     → ATTACHED (raw mode; stdin→WS binary; WS binary→stdout; SIGWINCH→resize control frame)
     → [remote exit | detach | ws drop]
ws drop → REATTACHING (backoff; same ptyId; daemon replays 256 KiB ring, then double-resize nudge)
        → ATTACHED, or → EXITED("session ended") if the ptyId is gone (daemon restarted)
```

- **Standalone:** no TUI — raw mode, attach, restore terminal on exit, propagate remote exit code.
- **From the TUI:** `shell-pane.ts` opens an embedded bottom split backed by the same dedicated PTY WS. `Ctrl+T` shows/hides the pane without killing the PTY; `Ctrl+J` toggles focus between chat and a visible shell; while the pane is focused every other key, `Ctrl+C` included, passes to the PTY; `Ctrl+Shift+Up`/`Ctrl+Shift+Down` resizes the split and immediately sends a resize control frame. When the shell exits the split hides and a transcript marker records the exit code. The main WS stays connected and renders normally; no TUI suspend/resume is involved.
- **Detach/focus:** TUI focus switching does not kill the remote shell. If the pane socket drops, it reattaches to the same PTY while it remains within the idle reap window. Standalone `agena shell` exits only when the shell exits or the process is interrupted.
- **Embedded terminal scope:** M3 embeds normal shell I/O in the split, not full VT100/alternate-screen emulation. Full-screen terminal apps are served by standalone `agena shell` until a real terminal emulator component is explicitly pulled in.
- **Terminal-state safety:** one idempotent `restoreTerminal()` registered on `exit`, `SIGTERM`, `SIGHUP`, `uncaughtException` — whatever kills the process, the terminal comes back usable.
- **Resize correctness:** initial size sent before any keystroke; SIGWINCH forwarded; on reattach the size is re-sent before ring replay, and the daemon's double-resize nudge forces full-screen apps to repaint (§9.5).

## 11.6 Packaging (P18)

**Bun is the compiled-CLI runtime, PROVISIONAL until the validation gate passes; Node remains the daemon runtime regardless.** The CLI is written runtime-neutral: Bun-only APIs confined to build scripts and the SDK's runtime-neutral WebSocket construction.

**One merged validation checklist** (ADR-0002; spike in M1 — CI compiles `bun build --compile` as a standing signal — **local M3 gate closes with `pnpm bun-gate`**, since shell attach is the riskiest consumer). Full release validation still runs on macOS arm64 + Linux x64 (glibc+musl), in iTerm2 / Terminal.app / tmux / stock Linux terminal:

1. **Raw mode:** `setRawMode` round-trips in a compiled binary; Ctrl+C/Ctrl+Z/SIGWINCH behave; termios restored on abnormal exit.
2. **WS client:** `Authorization` header on upgrade; binary frames both directions; ping/pong; ≥1 MB frames; sane `bufferedAmount`; stable under reconnect storms.
3. **pi-tui compat:** differential rendering, CSI 2026, bracketed paste, unicode width, Editor/Input focus + IME basics under the compiled binary.
4. **Compile artifact:** single-file binary per target (darwin-arm64/x64, linux-x64/arm64); starts <150 ms; runs without Bun installed; binary <80 MB; Gatekeeper/notarization behavior documented.
5. **Signals & job control:** SIGTSTP suspend + `fg` repaint; clean SIGTERM.
6. **Non-TTY:** piped stdin/stdout, `--json`, exit codes (`agena sessions --json | jq` works).

Any red release-matrix item unfixable in ≤2 days of spike work triggers the fallback: npm distribution (`npm i -g agena`, Node ≥22, native WebSocket where available with `ws` fallback if needed), optionally Node SEA later. A distribution change, not a rewrite.

## 11.7 Client failure-mode summary

| Failure | Handling |
|---|---|
| WS drop mid-stream | Freeze UI, backoff+jitter, resubscribe `fromSeq=lastSeq`, replay → sync → snapshot → live |
| WS drop mid-command | Retry unacked with original requestId; daemon dedupe map re-acks (INV-7) |
| Daemon graceful shutdown | Close `1001` → "daemon restarting", slower backoff |
| Daemon crash mid-generation | Replay contains recovery-written `message.assistant.failed {error.code:"daemon_restart"}` → partial/empty content + failed marker, never a stuck spinner (P2) |
| Seq gap / duplicates | Silent resubscribe; idempotent apply |
| Frame flood | 40 ms coalescing; frames advisory, events authoritative |
| Malformed event/frame | Inline error block with type+seq; never a crash |
| Oversized payload | BlobRef preview + lazy fetch; 1 MB inline hard cap; 64 KB render truncation |
| Concurrent-client races | `SESSION_BUSY` chooser; `APPROVAL_NOT_PENDING` toast; event-driven modal close |
| Cursor file corrupt/lost | Replay from 0; idempotent rendering |
| Session unknown (volume loss) | Prune cursor, open picker with notice |
| PTY WS drop | PTY survives daemon-side; reattach + ring replay; clean exit if ptyId gone |
| CLI crash in raw mode | Idempotent `restoreTerminal()` on all exit paths |
| Protocol mismatch | Refuse with upgrade message, exit code 7 |

---

# 12. Extensibility Surface (.agena/)

`/workspace/.agena/` is the **user-authored** surface (P20), independent of Pi:

```text
/workspace/.agena/
├── config.json          # workspace-scoped user settings: default model, tool allowlist
├── environment.toml     # reproducible system packages; credentials never belong here
├── tools/               # *.ts default-exporting defineTool(...)   → tools/db/query.ts ⇒ "db_query"
├── skills/              # *.md with YAML frontmatter (name from path)   → release.md ⇒ "release"
├── hooks/               # *.ts default-exporting defineHook(...)
└── .types/agena.d.ts    # DAEMON-REGENERATED ambient types — the documented carve-out
```

**The two generated carve-outs (stated once, honored by §3.3/§10.1):** the daemon may scaffold `.agena/` once and regenerate `.agena/.types/agena.d.ts`; the package recorder may atomically replace `.agena/environment.toml` after a successful apt mutation. `.types/` is gitignored by the scaffold and regenerated after restore. `environment.toml` is ordinary workspace intent: it may be committed, snapshotted, edited by the user, and is never allowed to contain credentials.

`environment.toml` v1 intentionally has one shape:

```toml
[packages]
system = ["gh", "jq"]
```

Names are validated as Debian package names, deduplicated, and sorted before they enter an image cache key. The Modal deployment reads this file from the durable workspace before constructing the image, so unchanged `(base image, package list)` reuses the cached layer. Package binaries are replaced on upgrade; CLI state such as `gh auth login` remains under `/home/agena` and is immediately reused.

**Path-derived naming:** identity = relative path minus extension, `/` → `_`, must match `^[a-z0-9_]{1,64}$`. An explicit `name` is allowed only if it equals the derived name; mismatch is a diagnostic error; colliding names disable both files with a reported collision.

**Factories:** authored files import the bare specifier `"agena"`, which the daemon's loader aliases to `@agena/core/extensibility` (Node module-resolution hook; no npm install in the workspace).

```ts
// @agena/core/src/extensibility/define.ts
export interface ToolContext {
  sessionId: string;
  workspaceDir: string;      // always /workspace
  signal: AbortSignal;       // aborted on turn abort / daemon shutdown
  logger: (msg: string) => void;
}
export interface ToolDescriptor<S extends z.ZodTypeAny = z.ZodTypeAny> {
  kind: "tool";
  name?: string;             // optional; must equal path-derived name
  description: string;
  parameters: S;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<{ output: string; data?: unknown }>;
}
export function defineTool<S extends z.ZodTypeAny>(d: Omit<ToolDescriptor<S>, "kind">): ToolDescriptor<S>;

export type AgenaHookEvent =
  | "session.start" | "message.user.created"
  | "tool.call.before" | "tool.call.after";           // v1 set
export interface HookDescriptor {
  kind: "hook";
  on: AgenaHookEvent[];
  handler(e: AgenaHookPayload, ctx: ToolContext):
    Promise<void | { decision: "deny"; reason: string }>;  // deny honored only for tool.call.before;
                                                           // a deny appends durable tool.call.denied {reason:"hook_denied"}
}
export function defineHook(d: Omit<HookDescriptor, "kind">): HookDescriptor;

export interface SkillDescriptor { kind: "skill"; description: string; content: string }
export function defineSkill(d: Omit<SkillDescriptor, "kind">): SkillDescriptor;   // experimental in v1 (OD6)
```

**Descriptor-first discovery — two phases, so listing never executes user code:**

1. *Scan (no execution):* walk `.agena/{tools,skills,hooks}`, derive names, statically verify (SWC parse) each `.ts` default-exports a call to the matching `defineX` factory; parse `.md` frontmatter. Produces a descriptor table with per-file status `ok | invalid(reason) | collision`. Feeds `agena info`. Malformed files are reported, never crash the daemon.
2. *Materialize (lazy execution):* on session start (or `agena info --check`), dynamic-import each `ok` file inside a try/catch; a throw downgrades it to `invalid(load_error)` for that session and surfaces as a `session.notice` frame — a broken user tool degrades one capability, not the daemon.

**`agena info`** prints: daemon + protocol + pinned Pi versions; workspace path; the discovery table (name, kind, file, status, bridge: `pi-extension (temporary)`); event-store stats (sessions, events, FTS row count vs messages count — a P7 drift detector); capture tee state; live PTYs.

**Pi-extension bridge — internal and temporary (P20, ADR-0003).** In v1, Agena tools reach the model wrapped into Pi `customTools` via `runtime-pi/src/tools.ts` + `bridge-extension.ts`; hook events are driven off **normalized Agena events in core** (never off `pi.on(...)`), except `session.start` context injection which transits the bridge. Marked `@internal @temporary` in code, ADR, and `agena info`. Nothing in `.agena/` imports Pi types — when a native runtime lands, authored files do not change. Pi's own extension auto-discovery is disabled (§8.3), so users cannot author against the wrong surface.

---

# 13. Testing Strategy & Quality Gates

## 13.1 Structural test doubles

`InMemoryEventStore` (core) stands in for storage; `FakeRuntimeAdapter` (`@agena/core/testing`) stands in for Pi (P16). Everything above the `RuntimeAdapter` port — append pipeline, fanout, WS gateway, approvals, replay, TUI store, CLI — is tested with **zero model calls**. The daemon boots end-to-end with `storage.kind: "memory"` + `runtime.kind: "fake"`.

## 13.2 TypeScript & lint

`tsconfig.base.json` (packages extend, never weaken — CI greps for overrides): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals/Parameters`, `verbatimModuleSyntax`, `isolatedModules`, `module/moduleResolution: NodeNext`, `target: ES2023`, `composite`, declaration+source maps. Biome (single root config); `biome ci` blocks.

## 13.3 Dependency pinning

`.npmrc` `save-exact=true`; frozen lockfile in CI. All `@earendil-works/*` pinned to one exact version via `pnpm-workspace.yaml` `overrides`; upgrades only through the Pi playbook (§8.9); nightly `pi-canary.yml` vs `@latest` (allowed to fail); Renovate groups Pi under manual approval.

## 13.4 CI pipeline (`ci.yml`, every push/PR)

1. `pnpm install --frozen-lockfile`
2. `biome ci .`
3. `node scripts/check-boundaries.mjs` (§4.2)
4. `tsc -b` (all packages, strict)
5. Unit: `vitest run --project unit` (protocol conformance incl. tests 6–7 of §5.11, core, storage-sqlite, client, tui store, runtime-pi fixture replay — no network, no Docker)
6. Integration: `vitest run --project integration` (Linux: real SQLite tmpdir, real WS server, FakeRuntime, node-pty smoke)
7. E2E: spawned daemon driven via `@agena/client` with FakeRuntime scripts, including kill/restart scenarios
8. Build artifacts: `docker build` daemon image; `bun build --compile` CLI on macOS+Linux (the standing Bun signal, P18 — non-gating until the M3 gate)
9. Upload binaries + image as artifacts

Zero model calls anywhere in CI; real-Pi recording is manual/nightly.

## 13.5 Test matrix

| # | Suite | Location | What it proves | IDs |
|---|---|---|---|---|
| 1 | Protocol schema | `packages/protocol/test` | §5.11 conformance tests 1–7 (registries, round-trips, upcasts, size caps, replay-order property, recovery payloads, mapping-table names) | P2, P13 |
| 2 | Mapper fixtures | `packages/runtime-pi/test` | Recorded Pi JSONL replayed through `event-map.ts` → byte-stable RuntimeEvents. **M2 baseline:** plain text, abort/error terminal, retry-success if available from Pi. Later milestones extend the same suite with approvals/controls (M4.5), tool calls and tool failures (M7), and compaction/model cases as their commands land. | P15, P2 |
| 3 | appendEvents tx | `packages/storage-sqlite/test` | seq monotonic under 100 interleaved appends; projection-writer throw ⇒ zero rows (atomicity); `onCommitted` fires only after commit, in seq order; frame types rejected; malformed payloads rejected pre-insert. **M7 extension:** >64 KiB spills and replays identically; concurrent identical spills race-safe (unique tmp names, INSERT OR IGNORE). | P6, P12 |
| 4 | Replay + branches | storage-sqlite + core/replay | `readEvents(fromSeq, limit)` paged, gapless, ordered; branch replay = ancestor chain up to each `forked_from_seq` + own events, on a 3-deep fork tree (storage-level; fork UX is M5-stretch) | P10 |
| 5 | Projection + FTS rebuild | storage-sqlite | **M2:** events → message/tool projections → drop → `rebuild()` → identical projection rows; idempotent. **M5 extension:** add FTS results and identical search hits. | P7 |
| 6 | WS reconnect | daemon integration | subscribe on the one multiplexed socket; kill socket mid-stream; reconnect with cursor ⇒ no gaps/dupes by seq; multi-session multiplexing; bad token ⇒ upgrade rejected with raw HTTP `401` | P4 |
| 7 | Command correlation | daemon integration | exactly one ack/error per requestId; prompt during turn ⇒ `SESSION_BUSY`; **commit → drop-before-ack → retry with original requestId produces exactly one `message.user.created`** (dedupe map); two clients get own acks + identical streams | P13, concurrent clients |
| 8 | Approval round-trip | integration + e2e | FakeRuntime approval ⇒ durable `approval.requested`; respond from a *different* client ⇒ runtime resumes; disconnect-while-pending ⇒ replay resurfaces it; no `extension_ui_*` shape ever on the wire (schema assertion); editor-kind round-trip | P14 |
| 9 | PTY smoke | daemon integration (Linux) | echo round-trip; resize changes `stty size`; exit code propagates; **zero terminal bytes on the main WS during the session** | P5 |
| 10 | Daemon restart | daemon e2e | SIGTERM mid-`hang` ⇒ `message.assistant.aborted` with partial content; SIGKILL ⇒ boot sweep appends `message.assistant.failed {daemon_restart}` + `tool.call.aborted {daemon_restart}` + `run.failed` + `terminal.session.ended`; post-restart replay shows nothing pending; store intact | P2 |
| 11 | FakeRuntime E2E | daemon e2e | full loop via spawned daemon + client: prompt→stream→complete; abort; approval; dispatch-failure durable record; TUI reducers replay the same streams to stable snapshots | P16 |
| 12 | Backpressure | daemon integration | slow reader: frames coalesce above **1 MiB** `bufferedAmount`, drop above **4 MiB**; durable events never dropped; backlog >16 MiB ⇒ close `4429` and client replays; fast producer cannot OOM the gateway | P12, backpressure |
| 13 | Importer | daemon test (M6) | fixture Claude/Codex archives: raw bytes untouched; malformed lines skipped+counted; re-import idempotent by `source_ref`; imported events carry `source.kind:"importer"`; imported sessions reject prompts with `SESSION_READ_ONLY`; FTS finds imported text | P3 |
| 14 | Path-safety fuzz | core | hostile-path corpus (`../`, `..%2f`, unicode lookalikes, NUL, symlink chains/ancestors) all throw `PathViolation` | P1 |

## 13.6 Fixture pipeline (P15)

Raw capture is the `runtime-pi` tee (§8.7). `scripts/record-fixture.ts` promotes a capture into `packages/runtime-pi/test/fixtures/<pi-version>/<scenario>.jsonl`, scrubbing absolute paths, hostnames, and key-shaped patterns (`sk-`, `AKIA`, bearer tokens); the diff between fixture generations *is* the Pi-upgrade review artifact. Recording is the only activity that touches a model, and it is manual.

---

# 14. Build Milestones & Acceptance Criteria

Every milestone = a human demo script + automated suites that must be green; acceptance criteria cite the FL requirements (§1.4) they prove. A milestone is done only when both hold.

### M1 — Walking Skeleton

**Scope (P8):** `InMemoryEventStore` only — history survives TUI restarts but not daemon restarts, by design and documented. Nobody builds throwaway persistence.

Deliverables: `@agena/protocol` v0 (`session.created`, `message.user.created`, `message.assistant.started/completed`, `run.started/completed`, text-delta frame, WS envelope with hello/welcome + requestId ack/error + subscribe); daemon in Docker (compose up, `/health`, one multiplexed WS, bearer-token handshake, `InMemoryEventStore`, `onCommitted` fanout); minimal `runtime-pi` (`createAgentSession`, text-streaming mapper, capture tee wired but off — fixture collection starts day one; `PI_DIR` verified; M1-R2 `DefaultResourceLoader` discovery-control check); minimal TUI (transcript + input + status bar); CI steps 1–5 + boundary check from the first commit; Bun compile spike (checklist items 1–3 executed; CI compile signal on).

Acceptance (deliberately lean — the multi-client and fixture-suite criteria move to M2):
1. `docker compose up`, then `agena` connects and streams a prompted response token-by-token. *(FL-1, FL-2)*
2. Kill the TUI mid-stream; reopen; `subscribe fromSeq 0` replays the transcript from memory and live frames resume. *(FL-3, FL-6)*
3. Restarting the daemon loses history and the TUI says so explicitly. *(P8 honesty)*
4. Suites 1, 6, 7 green; boundary check green.

Closes: P4, P8, P13 (baseline), P16 (FakeRuntime exists and gates the WS tests).

### M2 — SQLite, Replay, Reconnect, Crash Discipline, Backpressure

Deliverables: `@agena/storage-sqlite` core DDL for durable replay (`sessions`, `branches`, `events`, `messages`, `tool_calls` projections), `appendEvents` tx, paged `readEvents`, message/tool projection rebuild; wire snapshot on subscribe (via `toWireSnapshot`); terminalization for every durable started state introduced through M2 (`message.assistant.started`, `run.started`, and already-modeled tool/terminal starts if present in the log); boot sweep + dispatch-failure records for those states; graceful shutdown for active assistant/run state with real partial content; `agena rebuild` for M2 projections (FTS coverage extends in M5); **backpressure policy live** (slow durable consumer closes `4429`, frame coalesce/drop thresholds enforced, bounded replay buffer during subscribe); requestId dedupe map; `/var/lib/agena` named volume + capture tee in its permanent home; first recorded text-flow Pi fixture set (suite 2 green).

Out of M2 on purpose: blob spill (M7, when tool output can be large), project/cwd session scope (M4), FTS/search/snapshots/control-session schema (M5), importer schema/read-only sessions (M6), PTY shutdown semantics (M3), approvals/abort/model/compaction controls (M4.5), and extensibility tool execution (M7).

Acceptance:
1. Kill the TUI mid-stream; reopen: durable history replays instantly, in-flight partial appears, live frames resume — the "feels local" moment. *(FL-3, FL-6, FL-9)*
2. **Two cases, matching suite 10:** `docker compose stop` (SIGTERM) mid-generation ⇒ on reconnect the interrupted message shows **aborted with partial text**; `docker kill -9` ⇒ it shows **failed (`daemon_restart`) with empty partial content**. Neither ever shows a pending spinner. *(FL-3, FL-9 / P2)*
3. `docker compose down && up`: full history intact (volume persistence). *(FL-9)*
4. `agena rebuild` after corrupting the messages projection yields byte-identical rows. *(P7 mechanism)*
5. A second concurrent `agena` renders an identical event stream (same seqs). *(FL-6)*
6. Suites 2, 3, 4, 5 (projection part), 10, 12 green.
7. New M2 durable starts cannot remain pending across graceful shutdown, hard restart, reconnect, or projection rebuild.

Closes: P1 (placement + snapshot exclusion), P2, P6, P12; P7 mechanism.

### M3 — Shell Attach

Deliverables: `agena shell` + TUI embedded shell split; PTY manager; dedicated binary WS; TUI focus toggle + split resize; resize propagation + reattach double-resize nudge; `terminal.session.started/ended` for session-linked PTYs; PTY WS bearer auth; crash/shutdown handling for PTYs introduced here (`terminal.session.started` always gets `terminal.session.ended` on exit, daemon shutdown, or boot sweep); **Bun gate closes (ADR-0002)**.

Acceptance:
1. `agena shell`, `touch /workspace/hello.txt`, exit; the agent sees the file. *(FL-4)*
2. Resize the local terminal; `stty size` reflects it. *(FL-5)*
3. Exit restores the TUI exactly (alt-screen, cursor, keymap). *(FL-5)*
4. Instrumented: zero terminal bytes on the main WS during the session. *(P5)*
5. Suite 9 green; `pnpm bun-gate` green; ADR-0002 recorded. The broader cross-platform terminal matrix remains a release-validation gate, not an M3 implementation blocker.
6. All durable started states introduced through M3 are terminalized in normal exit, graceful daemon shutdown, hard restart, and replay.

Closes: P5, P18 (decision recorded).

### M4 — Project/CWD Session Scope

Deliverables: project registry (`projects` table) and session scope columns; `session.created` scope/cwd payloads; CLI host-cwd resolver; `POST /v1/sessions` scope input; `GET /v1/sessions` project/global/all filters; TUI resume/session picker defaults to current project; runtime sessions start in the durable session cwd; `agena shell --session` opens in the session cwd; cwd validation rejects traversal/symlink escapes outside the project root. Global sessions are explicit and excluded from project-local defaults.

Acceptance:
1. From repo/folder A, `agena` resumes or lists only A sessions by default; repo/folder B does not see A sessions without `--all-projects` or direct `--session`.
2. `agena new` records `scope="project"`, `projectId`, `projectRoot`, and workspace-relative `cwd` in `session.created` and the `sessions` row.
3. The agent runtime and `agena shell --session <id>` both start in the recorded session cwd, even when the client reconnects from a different host cwd.
4. `agena --global new` creates a global session; it appears under `--global`/`--all-projects`, not in project-local default listings.
5. `GET /v1/sessions` and search filters are SDK-visible and do not depend on TUI-only state.
6. Focused storage/client/daemon tests prove project filtering, global filtering, and cwd containment.

Closes: project-local session UX; makes later session picker/search/import behavior folder-aware.

### M4.5 — Approvals and Turn Controls

Deliverables: `approval.*` durable events end-to-end; Pi `extension_ui_*` mapped and never leaked; `steer`/`followUp`/`abort`/`setModel`/`setThinkingLevel`/`compact` commands with the §5.4 legality matrix; `model.changed`/`thinking.level.changed`; per-session serialization with deterministic `SESSION_BUSY` semantics; shutdown/restart handling for all control states introduced here (pending approvals cancel/replay correctly, abort terminalizes active messages/runs with partial content, model/thinking/compaction events rebuild from the log).

Acceptance:
1. Runtime requests confirmation → modal → respond → runtime continues; both approval events replayable. *(FL-7 / P14)*
2. Disconnect while pending; reconnect; the modal reappears from replayed state. *(FL-3 / P14)*
3. Client A prompts; client B aborts; both get correct acks; the aborted message persists partial content. *(FL-6 / P2)*
4. Two clients prompt simultaneously: exactly one turn runs; the other gets `SESSION_BUSY`. *(FL-6)*
5. `setModel` between turns appends exactly one `model.changed`; subsequent completions carry the new model.
6. Suites 7, 8 green end-to-end.
7. All durable started/pending states introduced through M4.5 are terminalized or replayed after reconnect, graceful shutdown, and hard restart.

Closes: P13, P14, concurrent-clients problem.

### M5 — Multi-Session, Files, Search, Snapshots, Discovery

Deliverables: project-aware session list/new/resume/archive (HTTP + picker) plus the session-status/source DDL those APIs need; `/v1/files` API + `agena files` (incl. `get -r` archive); FTS5 table + explicit projection writes + project-filtered `agena search` + rebuild-covers-FTS (P7 complete); snapshots schema/table plus create/restore with control-session events, safety snapshot, restore journal; control-session metadata (`meta.control_session_id`, `sessions.is_control`) and boot creation; `.agena/` **discovery** + `agena info` (scan phase, no execution). **Stretch (not required for M5 exit):** `POST /v1/sessions/:id/fork` UX — the schema and replay contract already ship (INV-11); suite 4 covers replay at storage level.

Acceptance:
1. Three concurrent sessions stream independently over one socket; the picker switches instantly. *(FL-1, FL-6)*
2. `agena search "refactor"` hits across sessions; `agena rebuild` drops and rebuilds FTS with identical results. *(P7)*
3. Create snapshot → agent edits files → restore → files revert, session history does not; crash-mid-restore leaves `restore_incomplete` + journal recovery. *(FL-9 / P1)*
4. `agena info` lists a deliberately broken `.agena/tools/*.ts` as `invalid` with a reason, without executing it. *(P20 discovery)*
5. Suites 5 (FTS), 14 green.
6. All durable states introduced through M5 (snapshot create/restore/delete, file operations that emit events, archive/status changes, control-session events) rebuild and recover from graceful shutdown and hard restart.

Closes: P7 (fully), P10 (contract + tests), P20 (discovery + diagnostics).

### M5.5 — Remote Preview URLs

Deliverables: workspace port registry; manual `agena ports expose/list/hide`; authenticated preview ingress for HTTP services running inside the workspace; TUI/app ports panel; basic terminal-output detection for `localhost:<port>` as a hint only (user confirmation still required for exposure); private-by-default visibility. No laptop-local `localhost` mapping, VPN/DNS client, SSH port forwarding, callback tunnel logs/replay, or webhook-specific stable URLs in this milestone.

Acceptance:
1. Start a dev server in `agena shell` on `0.0.0.0:3000`; `agena ports expose 3000` returns a browser preview URL reachable from a laptop or phone.
2. Hiding a preview URL stops external access but does not kill the process in the workspace.
3. A service reachable only inside Docker/Compose (for example `db:5432`) is not exposed unless the user explicitly exposes a user-facing port.
4. Preview URLs require auth by default; public/team visibility is only allowed through explicit policy.
5. Focused daemon/client/TUI tests prove route validation, preview registry state, and private-by-default behavior.

Closes: remote browser preview UX for cloud workspaces.

### M6 — Importers

Deliverables: `imports` and `imported_sessions` schema; `agena import claude|codex` per §9.6 (raw archive → normalized events with `source.kind:"importer"` → deterministic summary + lazy LLM continuation summary as `import.summary.created`); imported-session source/read-only metadata on sessions; read-only enforcement (`SESSION_READ_ONLY`); `agena resume <imported>` seeds a new native session.

Acceptance:
1. Import a real Claude archive: stats report sessions/messages/skipped counts; raw bytes untouched; re-import is a no-op (idempotent by `source_ref`). *(FL-9)*
2. `agena search` finds imported content; imported sessions render with an "imported, read-only" banner. *(FL-7)*
3. Resuming an imported session produces a native session whose first context includes the summary.
4. Suite 13 green.
5. All durable states introduced through M6 (import records, imported-session mappings, import summaries, read-only enforcement metadata) are idempotent, rebuildable, and recoverable after restart.

Closes: P3 (importer provenance), backfill contract.

### M7 — Extensibility Execution

(Split from the old fat M6 so importers and extensibility slip independently.)

Deliverables: `.agena/` **execution** — tools registered through the pi-bridge (internal+temporary), hooks (`session.start`, `tool.call.before` with deny → durable `tool.call.denied {reason:"hook_denied"}`, `tool.call.after`), `.md` skills injected at session start; `"agena"` module-alias loader + `.types/agena.d.ts` regeneration (carve-out, §12); blob spill for oversized tool args/results and file/image content (`blobs` metadata, content-addressed files, `GET /v1/blobs/:hash`, TUI lazy fetch/truncation behavior); suite 2 extended with tool-call/tool-failure Pi fixtures.

Acceptance:
1. A `.agena/tools/` tool is called by the model end-to-end. *(FL-7 / P20)*
2. A `tool.call.before` hook denies a tool; the denial is a durable, replayable event.
3. `agena info` shows tools as `ok (via pi-extension bridge — temporary)`.
4. A large tool result spills to a `BlobRef`; replay, TUI rendering, lazy fetch, and rebuild produce the same visible result.
5. All durable states introduced through M7 (tool calls, hook denials, blob-bearing outputs, extension failures) terminalize, rebuild, and recover from graceful shutdown and hard restart.

Closes: P20 (execution).

---

# 15. Problem Register

## 15.1 Known problems P1–P20

| ID | Problem | Resolution | Implemented in |
|---|---|---|---|
| P1 | Daemon state outside `/workspace`; snapshots exclude it; restore never rolls back history | Two named volumes; §3.3 tree; snapshots capture `/workspace` only; restore touches files only, records events on the control session | §3.3, §7.1, §10.1, §10.5 |
| P2 | `message.assistant.aborted/failed` (with partial content) + same discipline for tools | Canonical terminal-event matrix §5.6; adapter mirror buffer; graceful-shutdown drain; boot sweep closes messages, tools, runs, approvals, terminals | §5.6, §7.8, §8.6, §9.7 |
| P3 | Per-event provenance with matching DDL column | `EventSource {kind, runtime?, clientId?}`; columns `source_kind`, `source_runtime`, `source_client_id` | §5.3, §7.3, §9.1 |
| P4 | One multiplexed WS; subscribe commands, no URL params | `GET /v1/ws`; `subscribe {sessionId, fromSeq}` in-band | §5.1–5.2, INV-6 |
| P5 | Terminal bytes only on the dedicated PTY WS | Binary PTY WS; lifecycle-only durable events; observation frames reserved future/optional | §9.5, §11.5, INV-8 |
| P6 | Fanout strictly after commit | `appendEvents` tx → `onCommitted` seam → `FanoutHub` (one seam, decided) | §6.2, §7.5, INV-5 |
| P7 | FTS5 sync explicit; rebuild covers FTS | Reducer-emitted explicit FTS INSERTs in the tx; `agena rebuild` deletes + repopulates `messages_fts`; FTS ships M5 | §7.6, M2/M5 |
| P8 | M1 uses an explicit in-memory log | `InMemoryEventStore` in core behind the same port; permanent test double | §7.4, M1 |
| P9 | `agena share` parked or specified | **Parked**: verb not registered; one-line signed-URL gateway design + reserved `share.link.created`; ADR-0004 | §10.7, §17 |
| P10 | Branch replay contract documented | Parent-chain walk to each `forked_from_seq`; concrete SQL; session-global seq | INV-11, §7.5–7.6, §5.8 |
| P11 | runtime-pi dependency edges explicit | Core defines the ports; runtime-pi implements; CI boundary check | §4.2, §8.1 |
| P12 | Never persist deltas | Disjoint `DURABLE_EVENT_TYPES`/`FRAME_TYPES` registries; `not_a_durable_event` rejection | §5.7, §7.1 |
| P13 | requestId correlation + ack/error | Exactly-one-terminal-response + connection-independent 5-min dedupe map (one mechanism) | INV-7, §5.2 |
| P14 | Approvals as durable events; survive reconnect; Pi UI never leaks | Four approval events; pending = requested-minus-terminal; snapshot restates; first-write-wins | §5.5, §8.5, §11.4 |
| P15 | Raw capture = opt-in JSONL tee, not a table | `runtime-pi/capture.ts`; `rawCapture.enabled`/`AGENA_RAW_CAPTURE`; `/var/lib/agena/captures/` | §8.7 |
| P16 | Pi isolated; fake runtime for zero-model-call testing | `runtime-pi` only importer; `FakeRuntimeAdapter` at `@agena/core/testing`; fake daemon mode | §8.8, §13.1 |
| P17 | pi-tui first, fallback recorded | ADR-0001; renderer-confined imports; Ink → OpenTUI fallback order | §11.2 |
| P18 | Bun provisional; Node daemon | Merged checklist; spike M1, gate M3-end; npm fallback = distribution change | §11.6, INV-13 |
| P19 | Explicit acceptance criteria; walking skeleton first | M1–M7 with demo + suite criteria mapped to FL-1…FL-9 | §14 |
| P20 | `.agena/` surface independent of Pi; bridge temporary | Path-derived names, defineX factories, descriptor-first discovery, `agena info`; bridge `@internal @temporary` (ADR-0003) | §12 |

## 15.2 Adversarial review findings (high/medium, consolidated)

Duplicate findings across the four reviewers are merged into one row each; each row states the binding resolution. "Fixed" = the design in this document is the reconciliation.

| # | Finding (severity) | Resolution |
|---|---|---|
| F1 | Main-WS contract defined three incompatible ways — endpoint (`/v1/ws` vs `/v1/socket`), handshake direction, integer-vs-semver version, ping direction/interval (high, ×4 reviewers) | **Fixed.** protocol.md made sole owner: `GET /v1/ws`, client-first `hello` → `welcome`, integer `PROTOCOL_VERSION`, daemon-pings-15s. All client/daemon variants deleted (§5.1–5.2, §9.4, §11). |
| F2 | Three command catalogs (`prompt` vs `session.prompt` vs `prompt.send`; text vs ContentBlock[]; merged model+thinking) (high, ×3) | **Fixed.** §5.4 is the single catalog: camelCase verbs, `content: ContentBlock[]`, `{provider,id}` model refs, separate `setThinkingLevel`, `compact` included and exposed in the TUI palette + daemon dispatch. |
| F3 | Replay-end envelopes disagree (`sync`+`snapshot` vs `caughtUp` vs `replay.start/end`; `notice` undefined) (high) | **Fixed.** `sync` then `snapshot` (always sent; null in-flight fields when idle, carrying `pendingApprovals`). `caughtUp`, `replay.*`, `notice` deleted; shutdown UX keyed on close `1001` (§5.2, §5.8). |
| F4 | Four error-code vocabularies; conflicting followUp-idle policy (high) | **Fixed.** One `ErrorCode` enum (§5.9) extended with `DAEMON_SHUTTING_DOWN`, `APPROVAL_NOT_FOUND`, `SESSION_READ_ONLY`; `E_*`/`VALIDATION_FAILED`/`SESSION_IDLE`/`TURN_ACTIVE`/`APPROVAL_ALREADY_RESOLVED` deleted. followUp-when-idle → `TURN_NOT_ACTIVE`, stated once in the §5.4 legality matrix. |
| F5 | requestId retry contradiction: dedupe-window vs idempotencyKey vs no-dedupe → double-executed prompts (high, ×3) | **Fixed.** One mechanism: connection-independent requestId dedupe map (5-min TTL) in protocol + daemon; `idempotencyKey` and `DUPLICATE_REQUEST_ID` deleted; suite 7 tests commit→drop→retry ⇒ exactly one `message.user.created`. |
| F6 | Interrupted-tool terminal event had four names; denied-tool projection missing (high, ×3) | **Fixed.** Taxonomy `completed | failed | aborted | denied` (§5.5); `tool.call.interrupted` and `failed{code:"interrupted"}` dead; projection rows for `aborted` and `denied` added (§7.6); overview INV-4 aligned. |
| F7 | Protocol catalog missing ~14 runtime/filesystem/delivery-minted durable types; store would reject `run.started`; sweep never closes runs (high, ×3) | **Fixed.** §5.5 registry now exhaustive: `run.*`, `message.runtime.created` (collapses custom/bash/branch-summary), `compaction.failed`, `runtime.extension.failed`, `thinking.level.changed` (one name), `snapshot.restore.failed/deleted`, `workspace.initialized`, `import.summary.created`. Boot sweep closes `run.started` and `terminal.session.started` (§7.8). `session.archived` dead (→ `session.status.changed`). CI conformance test 7 locks the mapping table to the registry. |
| F8 | Frame catalogs disagree (4 vs 15 frames; `tool.output.delta` vs `tool.call.output.delta`; `status.transient` vs `session.status.updated`) (high) | **Fixed.** Merged single catalog §5.7: `tool.call.output.delta` and `session.status.updated` are the spellings; `status.transient` folded into `session.status.updated` (one keep-latest status frame). |
| F9 | Provenance under-implemented: `source_client_id` missing from DDL; daemon invented payload-embedded connId (high/med, ×3) | **Fixed.** Column added (§7.3); attribution is `EventSource.clientId` from `hello`; payload connId attribution deleted; `ApprovalResponded.respondedBy` == that clientId. |
| F10 | Three incompatible BlobRef shapes — spilled payloads would fail validation on read (high, ×2) | **Fixed.** One shape `{blob, sizeBytes, mimeType?, preview?}` (§5.3); spiller and client reference it verbatim. |
| F11 | P2 payload fields/reasons had five spellings (`partial`/`partialBlocks`/`partialContent`, null vs `[]`, `daemon.restart`/`daemon-crash`/…) — recovery events would fail validation exactly when needed (high, ×3) | **Fixed.** Canonical matrix §5.6 with exact payloads and the four reason spellings; every writer quotes it; conformance test 6 feeds each cell through the schemas. |
| F12 | Snapshot events: name/payload/kind/target-session all diverged; `pre_restore` violated the CHECK (high, ×2) | **Fixed.** Control-session design adopted everywhere; `snapshot.restored` is the name; `pre_restore` added to enum + DDL CHECK; payloads from filesystem draft in §5.5; snapshots table gains `sha256`/`status`. |
| F13 | Two disjoint file-API route sets; init seeding called a nonexistent route (high, ×2) | **Fixed.** filesystem's richer `/v1/files` family is canonical (§9.3); `/v1/workspace/*` dead; seeding uses `POST /v1/files/upload?format=tar`. |
| F14 | HTTP route table had no owner; blobs/rebuild/imports/approvals rows missing; search/rebuild/PTY paths inconsistent (high/med, ×3) | **Fixed.** One authoritative table in §9.3 (schemas in `protocol/src/http.ts`, matching the ownership claim): adds `GET /v1/blobs/:hash`, `POST /v1/imports`, `GET /v1/imports/:id`, `GET /v1/approvals`, `POST /v1/admin/rebuild`; `GET /v1/search`; PTY WS `/v1/ptys/:id/ws`. |
| F15 | Daemon port defined three ways (24362/7777/4460) (med) | **Fixed.** 7777 in-container, host ≥7700 loopback-only (§3.2). |
| F16 | Five different `/var/lib/agena` layouts (db path, captures dir, pi home, token file, imports dir) (med, ×3) | **Fixed.** §3.3 is the normative tree (`db/agena.db`, `captures/`, `pi/sessions`, `config/token`, `raw-imports/`); all sections reference it. |
| F17 | Secrets-at-rest stance contradictory (never-on-volume vs secrets.env vs pi/auth.json) (med, ×2) | **Fixed.** Decided rule in §3.3: env-first with two permitted 0600 materializations under the state volume (snapshot-excluded by construction); absolute "never on any volume" language superseded. |
| F18 | Token env/file/minting owner disagreed; `AGENA_WORKSPACE_ROOT` vs `_DIR` (med, ×3) | **Fixed.** `AGENA_AUTH_TOKEN`, CLI-minted at `workspace init`, daemon persists to `config/token` (fallback-generate); `AGENA_WORKSPACE_DIR`; provisioning appendix is §10.4 + §9.2. |
| F19 | WS close codes (4401 vs 4001, 4429 vs 4008) and heartbeat direction conflicted (med, ×3) | **Fixed.** Single registry in protocol `errors.ts`: 4401 auth, 4429 slow consumer, 4409 PTY (§5.9); daemon-pings-15s only. |
| F20 | Backpressure thresholds differed per section (med, ×3) | **Fixed.** One policy: coalesce >1 MiB, drop >4 MiB, disconnect >16 MiB/15 s (§6.4); protocol/delivery describe the mechanism and cite these numbers (suite 12 updated). |
| F21 | Post-spill cap 128 vs 256 KiB (med, ×2) | **Fixed.** 128 KiB everywhere (§7.7). |
| F22 | InFlightSnapshot defined 2–3 ways under one name; garbled `status` type; `ApprovalSummary` undefined (med, ×4) | **Fixed.** Wire `InFlightSnapshot` (protocol, §5.8) vs core `RuntimeInFlightSnapshot` (§8.2) with an explicit `toWireSnapshot()` mapping (approval join in core); `status` is a plain `{state, detail?}`; `ApprovalSummary` dead. |
| F23 | Fanout trigger specified twice (store `onCommitted` vs orchestrator `publishCommitted`) (med, ×2) | **Fixed.** Store's `onCommitted` is the seam; FanoutHub subscribes at bootstrap (§6.2). |
| F24 | Event-id contradiction: "no id" (protocol) vs ULID id column (storage) (med, ×3) | **Fixed.** Reworded: no id **on the wire**; storage keeps an internal never-serialized id for importer dedupe (§4.3, §7.3). |
| F25 | Client said crash recovery writes `aborted`; everyone else `failed` (med) | **Fixed.** Crash = `failed {daemon_restart}`; aborted reserved for user abort/graceful shutdown (§5.6, §11.3). |
| F26 | Terminal lifecycle names (`terminal.pty.*` vs `terminal.session.*`) + standalone-PTY policy conflict; boot sweep never closed dangling terminals (med, ×2) | **Fixed.** `terminal.session.started/ended` everywhere; standalone PTYs emit no durable events (stated in §1.5 + §9.5); sweep appends `terminal.session.ended {reason:"daemon_restart"}` (§7.8). |
| F27 | CLI verb list contradictions (cp/login/share/daemon-vs-workspace lifecycle; read-only `files`) (med, ×3) | **Fixed.** §1.5 is the single owner: `workspace init/open/stop/rm/logs` adopted; `login` included as profile management; `files ls/cat/get/put` (+`get -r` via archive route) replaces `cp`; `share` absent (no stub — filesystem's stance wins; exit-3 stub deleted). |
| F28 | Client config location/flag disagreed (med, ×3) | **Fixed.** `~/.config/agena/` XDG layout with the workspace registry folded into profiles; `--profile` (§10.4, §11.1). |
| F29 | Raw-capture key/env/owner had four variants; workspace-config toggle violated config rules (med, ×2) | **Fixed.** `runtime-pi/capture.ts` owns the tee; `rawCapture.enabled` + `AGENA_RAW_CAPTURE=1` are the only switches (the `agena dev capture` verb variant is deleted — §1.5 owns the verb list); workspace-config variant deleted (§8.7). |
| F30 | FTS milestone conflict (M2 vs M5) (med) | **Fixed.** Delivery's sequencing wins: rebuild mechanism M2, FTS5 + search M5 (§14). |
| F31 | Bun gate closes at two different times; two checklists (med, ×3) | **Fixed.** Merged checklist; spike M1 (CI signal), gate M3-end; ADR-0002 (§11.6). |
| F32 | Delivery's docker artifacts contradicted filesystem's (bind mount, entrypoint.sh, filenames) (med, ×3) | **Fixed.** Named volumes only; no entrypoint.sh (bootstrap owns dirs/token); `docker/Dockerfile` + `docker/compose.yml` (§10.2–10.3, §4.1). |
| F33 | Daemon writes under `/workspace` (scaffold, `.types/`) violated "user-authored only" (med/low, ×2) | **Fixed.** Explicit carve-out documented in §12 and honored by §3.3/§10.1: one-time scaffold + regenerated `.types/` (gitignored by scaffold, regenerated after restore). |
| F34 | Validate-before-spill order rejected exactly the payloads spilling exists for (med) | **Fixed.** Spill-then-validate order (§7.5); schema size test rewritten to post-spill semantics (§5.11-4). |
| F35 | Blob spill write race (deterministic tmp name) + blobs PK conflict (med) | **Fixed.** Unique `<hash>.<ulid>.tmp`, skip-rename-if-exists, `INSERT OR IGNORE`; suite 3 gains the concurrent-identical-spill test (§7.7). |
| F36 | Concurrency/legality matrix conflicts per command (followUp idle, setModel mid-turn vs runtime M4.5) (med) | **Fixed.** §5.4 matrix is the one statement; runtime M4.5 criterion reworded to "between turns" (§14-M4.5). |
| F37 | `compact` unreachable from any client (med) | **Fixed.** In the command union, daemon dispatch, and TUI palette (§5.4, §11.3). |
| F38 | Workspace-scoped events had no home (control session unknown to protocol/store) (med, ×2) | **Fixed.** Control session adopted in protocol (§5.5), DDL (`is_control`, `meta.control_session_id`), routes (`includeControl`), glossary. |
| F39 | Importer had no owning section (wire contract, mapping, read-only, idempotency unspecified) (med) | **Fixed.** Ownership assigned: §9.6 specifies the `POST /v1/imports` contract, per-source parsing, `SESSION_READ_ONLY` enforcement, and the one idempotency rule (`source_ref` identity, `content_hash` change detection). |
| F40 | PTY boot-recovery gap + framing/idle-timeout drift + reattach-resize garbling (med/low, ×2) | **Fixed.** Sweep closes dangling terminals; control frames in `protocol/src/pty.ts` (`{"type":"resize"…}`/`{"type":"exit"…}`); 15-min reap; double-resize nudge documented (§9.5). |
| F41 | Pi throwing at prompt dispatch left a dangling user message + stale echo expectation (med) | **Fixed.** Durable `run.failed {phase:"dispatch", triggerMessageId}` + echo-expectation cleanup; FakeRuntime asserts it (§8.6). |
| F42 | Approval respond path appended before the adapter could reject (low/med) | **Fixed.** Core validates against its own pending set BEFORE append; adapter failure after a valid append is a runtime-error path (§8.5). |
| F43 | `readEvents` unbounded vs chunked consumers (med/low, ×2) | **Fixed.** Port is paged: `readEvents(sessionId, branchId, fromSeq, limit) → {events, nextFromSeq}` matching the HTTP shape (§7.4). |
| F44 | `expectedLastSeq` OCC redundant with FIFO + single-writer (low) | **Fixed (accepted).** Dropped from the v1 port; reserved for the Postgres multi-writer path (§7.4, §7.11). |
| F45 | Three stacked delta-coalescing layers; runtime-overrun abort killed healthy runs (med) | **Fixed (accepted).** Adapter-tier coalescing/tick/overrun-abort deleted; exactly two valves remain: gateway policy + client 40 ms tick (§6.4). |
| F46 | Runtime over-minted event types (run.*, bash/custom/branch-summary, widget/status frames with no renderer) (med) | **Partially fixed / partially rejected.** `message.custom.created`, `command.bash.completed`, `branch.summary.created` collapsed into one `message.runtime.created`. `run.*` **kept durable** (rejection reason: they anchor the boot sweep and dispatch-failure records; two rows per run is cheap). Widget/status/notice frames kept — they carry extension UX the approval/notice paths already need; renderers may ignore them. |
| F47 | M1 too fat for a walking skeleton (med) | **Fixed (accepted).** M1 acceptance trimmed (single client; fixture suite + multi-client criterion moved to M2); Bun compile is a non-gating CI signal in M1. Token auth stays in M1 (INV-12 is non-negotiable and trivial). |
| F48 | M5 bundled seven features; fork hard-required despite the non-goal; backpressure milestone conflict (med) | **Fixed (accepted).** Backpressure moved to M2; fork demoted to M5-stretch with storage-level tests only. |
| F49 | M6 bundled importers + extensibility (med) | **Fixed (accepted).** Split into M6 (importers) and M7 (extensibility execution). |
| F50 | M2 acceptance criterion unsatisfiable ("restart ⇒ failed with partial text") (med) | **Fixed.** Split per suite 10: SIGTERM ⇒ aborted+partial; kill -9 ⇒ failed+empty (§14-M2). |
| F51 | Snapshot subsystem heavier than v1 needs (control session, pre_restore, journal) (med) | **Partially rejected.** Inconsistencies fixed (F12); the machinery is **kept**: the control session is the only complete home for workspace events; the automatic `pre_restore` safety snapshot guards the sole destructive workspace op and now costs one enum token; the journal is cheap real crash-safety. |
| F52 | `agena approvals`/`approve` had no backing route; suggestion to defer to v1.1 (med) | **Partially rejected.** Route added (`GET /v1/approvals`, a cheap events scan) instead of deferring — headless approval is the future phone path and costs little. |
| F53 | `AgenaApiType` ToSchema machinery vs simpler http schemas (low) | **Fixed (accepted).** Delivery's simpler mechanism adopted: per-route Zod schemas in `protocol/src/http.ts` + a typed fetch wrapper; hc/ToSchema dropped until a second HTTP client exists. |
| F54 | Speculative protocol knobs (includeFrames, capabilities, per-request header check) (low) | **Fixed (accepted).** Marked reserved/not-implemented; per-request HTTP header check dropped to welcome-time (§5.1). |
| F55 | Editor approval kind unanswerable from the client (med/low, ×2) | **Fixed.** `{kind:"editor"}` in the client union, PromptEditor modal mapping, `agena approve --input-file` (§11.4, §1.5). |
| F56 | Cursor persistence lost branch context (low) | **Fixed.** `cursors.json` keyed `sessionId → {branchId, seq}` (§11.1). |
| F57 | Payload field gaps: `mode` vs `queued`; compaction id/replacesUpToSeq minting; origin/source enum mismatch (low) | **Fixed.** `queued` is the field; core mints `compactionId` + stamps `replacesUpToSeq` (§8.5); origin↔source mapping documented in the DDL (§7.3). |
| F58 | Numeric/name drift: PTY reap, ack timeout, `InMemoryEventStore` vs `MemoryEventStore`, `upcasts.ts` vs `upcast.ts` (low) | **Fixed.** §3.2 constants table: 15 min, 30 s, `InMemoryEventStore`, `upcasts.ts`. |
| F59 | `agena share` stub-vs-absent contradiction; two future designs (low) | **Fixed.** Absent (not registered); one future design: signed-URL gateway (§10.7). |
| F60 | Direction-doc visibility items (processes/ports/jobs) silently dropped (low) | **Fixed.** Minimal processes/ports listing added to `GET /v1/diagnostics` (§9.9); richer inspection remains a non-goal (§17). |
| F61 | FL-mapping promise unfulfilled by milestones (low) | **Fixed.** Every §14 acceptance criterion cites its FL ids. |
| F62 | Filesystem's "token as first WS message" contradicted header auth and PTY binary framing (low) | **Fixed.** Header-on-upgrade is the only WS auth path (§5.1, §9.5). |

---

# 16. Risk Register

| # | Risk | L | I | Mitigation | Early-warning signal |
|---|---|---|---|---|---|
| R1 | **Pi churn** breaks mapping or SDK usage | H | H | Exact pin via `pnpm-workspace.yaml` `overrides`; single mapper firewall (`event-map.ts`); versioned fixtures per pin; nightly canary; upgrade playbook (§8.9) | Canary red; oversized fixture diff on pin bump |
| R2 | **TUI scope creep / pi-tui walls** | M | M | Pure store reducers make the renderer swappable; ADR-0001 fallback order; views capped per milestone | Renderer code in the store; frame-rate complaints in M1 |
| R3 | **Terminal scope explodes** (VT100/full-screen emulation) | M | H | M3 allows a lightweight embedded shell split for normal I/O; full terminal emulation and observation frames stay future/optional | Any PR adding VT parsing or terminal-emulator dependencies without pulling that scope forward |
| R4 | **Bun CLI risk** (raw mode, WS, packaging) | M | M | Provisional (ADR-0002); CI compiles every push; gate M3-end; Node/npm fallback is build-script-only | Flaky compile step; raw-mode bugs in M3 |
| R5 | **Schema hardens too early** | M | M | Events-are-truth; projections disposable; rebuild from M2; `v`+upcasts; storage behind the port | A "data migration" PR touching `events` |
| R6 | **Plugin-layer confusion** (Agena vs Pi extensions) | M | M | `.agena/` Pi-independent; bridge marked temporary (ADR-0003); Pi auto-discovery disabled; `agena info` names the bridge | Docs/examples importing Pi types in `.agena/` |
| R7 | **Event log bloat** | M | M | Two-tier model; 64 KiB cap + spill; suite 3 row-budget assertion; `agena info` counts | Events-per-session trending up |
| R8 | **Reconnect feels broken** | M | H | seq from day one; replay built in M2 before features; snapshots; kill/reopen suites 6+10 in CI | Any reconnect bug — P0 by policy |
| R9 | **Daemon crash mid-generation** | M | H | §5.6 matrix + boot sweep + WAL; suite 10 | Sweep counter finding dangling rows |
| R10 | **Concurrent clients corrupt a turn** | M | M | Per-session serialization; deterministic `SESSION_BUSY`; requestId dedupe; suite 7 | Duplicate turn events in any replay |
| R11 | **WS backpressure under fast deltas** | M | M | §6.4 two-valve policy; durable events never dropped; suite 12 | `bufferedAmount` gauge spikes |
| R12 | **Secrets/provider keys leak** | L | H | §3.3 secrets stance; redaction; capture scrubber; token auth even on localhost; PTY env stripping | Key-shaped string in fixtures/scrubber report |
| R13 | **Container restart / volume loss** | L | H | Named volumes; compose down/up acceptance in M2; documented single-file backup | Compose drift removing volume mappings |
| R14 | **Multi-workspace confusion** | M | L | One container = one workspace; `--profile` selection; boot-fatal id mismatch | Feature requests routed to profiles doc |

---

# 17. V1 Non-Goals

Each is a decision, not an omission.

1. **`agena share` — parked (P9).** Future: signed expiring URLs from an internet-facing gateway over the content-addressed store, recorded as `share.link.created` (reserved). Returns when the daemon leaves the local container. (ADR-0004.)
2. **`agena cp` / `agena sync` / FUSE / folder mirroring** — `agena files get/put` (+ `get -r`) covers v1; continuous sync is post-v1.
3. **Desktop and phone apps / browser IDE** — the protocol is designed for them (INV-1, INV-6); the clients are not built.
4. **Embedded terminal pane in the TUI** — needs a VT100 emulator; raw passthrough is the v1 terminal. Terminal-observation frames on the main channel: future/optional.
5. **Multi-user, teams, RBAC/SSO, billing, multi-tenant SaaS** — single-user, single-tenant; INV-12's token is the whole v1 auth story.
6. **Plugin marketplace / remote plugin install** — v1 extensibility is authoring files in `.agena/`.
7. **Live Claude/Codex/OpenCode adapters** — Claude/Codex are one-time import sources; perfect replay of imports is explicitly not attempted (raw archive + normalized events + summary is the contract).
8. **Postgres, object storage, cloud control plane** — SQLite in-container; the `EventStore` port keeps the path open (§7.11).
9. **CRDT/offline editing, server-side device cursors** — clients keep cursor + draft locally; server-ordered events are the sync mechanism.
10. **Branch management UX** — the data model and replay contract ship in the schema; fork UX is an M5 stretch, not required for v1 success.
11. **Native (non-Pi) production runtime** — the fake runtime exists for tests; a native runtime is post-v1.
12. **Multi-workspace daemons** — one daemon per workspace container (§3.4).
13. **Laptop-local port forwarding / VPN / local DNS** — preview URLs are the v1 remote-dev browser surface. Agena does not promise remote workspace ports on the user's local `localhost` unless a future local forwarding client is explicitly added.
14. **Callback tunnel product** — stable webhook/OAuth callback URLs with request logs, redaction, and replay are deferred. Preview URLs may be used manually for simple HTTP testing, but they are not a webhook-debugging product.
15. **Rich process/background-job inspection** — consciously deferred; v1 ships preview port listing, the minimal processes/ports listing in `GET /v1/diagnostics`, and `agena shell` for everything else.
16. **Per-event redaction / retention policies** — append-only, delete-nothing (§7.9); whole-session archive is the reserved future design.

---

# 18. Open Decisions with Recommendations

1. **OD1 — Bun final call (P18).** Spike at M1 (CI compile signal); formal gate at **M3 exit** with the §11.6 merged checklist (raw mode, WS under reconnect storms, pi-tui fidelity incl. IME/tmux, <80 MB single-file binaries on macOS/Linux, signals, non-TTY). *Recommendation:* keep Bun if all pass; otherwise npm + `ws` (build-script-only change). Record as ADR-0002 either way.
2. **OD2 — `agena share` (P9): PARKED.** Not in the v1 surface; `agena files get` covers moving artifacts out. Future design recorded in §10.7 / ADR-0004. *Recommendation:* revisit when the daemon leaves the local container.
3. **OD3 — FTS tokenizer.** `unicode61 tokenchars '_-.'` misses substring matches on code identifiers; trigram doubles index size. *Recommendation:* ship `unicode61 tokenchars '_-.'` in M5; benchmark trigram on real imported history in M6; switch via `agena rebuild` if precision disappoints (rebuild makes tokenizer changes free — P7).
4. **OD4 — Importer summaries: deterministic vs LLM.** *Recommendation (adopted in §9.6):* deterministic extraction at import time (offline, free); LLM continuation summary generated lazily on first resume, stored once as `import.summary.created`.
5. **OD5 — Hook capabilities in v1.** *Recommendation (adopted in §12):* deny allowed for `tool.call.before` only; every deny is a durable `tool.call.denied {reason:"hook_denied"}`; mutation hooks deferred to the native runtime.
6. **OD6 — TS skills (`defineSkill`).** *Recommendation (adopted):* ship `.md` skills only; keep `defineSkill` exported but flagged experimental.
7. **OD7 — Package publishing.** *Recommendation:* private workspace packages in v1; publish `@agena/protocol` + `@agena/client` to npm only when a second external client starts — publishing freezes the protocol harder than versioning does.
8. **OD8 — macOS binary signing/notarization.** Gatekeeper behavior of the compiled CLI is documented during the Bun spike; *recommendation:* ad-hoc signing for v1, notarization when distribution goes public.
