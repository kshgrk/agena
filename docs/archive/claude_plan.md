# Agena v1 — Architecture Plan and Research Findings

> Status: discussion draft (2026-07-05). Captures the v1 direction, verified research on Pi and eve, architecture recommendations, database schema, and build order. Builds on `docs/archive/cloud-cli-harness-final-understanding.md` and `docs/archive/deep-research-report (1).md`.

---

## 1. v1 Shape

- A **local TUI client**, launched by typing `agena` in the terminal.
- The **harness/daemon runs in the cloud** — for development, in a Docker container on the local machine.
- The daemon is **backed by Pi** (pi.dev / `badlogic/pi-mono`) and uses the **container filesystem directly** as the workspace.
- The TUI parses an incoming event stream and renders it so everything **feels local at all times**.
- `agena shell` (and an option inside the TUI) attaches a **real terminal inside the container**.
- Built **SDK-style, modular, high code quality from day one**; Vercel `eve`'s filesystem-first conventions as a structural reference; Hono under consideration for the HTTP layer.

---

## 2. Research Findings: Pi (verified against pi.dev docs and pi-mono repo)

### 2.1 Packages

| Package | Purpose |
|---|---|
| `@earendil-works/pi-coding-agent` | The SDK for embedding Pi in a TypeScript app |
| `@earendil-works/pi-ai` | Multi-provider LLM API (`getModel("anthropic", "claude-opus-4-5")`) |
| `@earendil-works/pi-agent-core` | Agent runtime |
| `@earendil-works/pi-tui` | Standalone terminal UI library with differential rendering |

### 2.2 SDK API surface

- **Create session:** `createAgentSession(options)` → `{ session, extensionsResult, modelFallbackMessage? }`. Also exported: `createAgentSessionRuntime`, `AuthStorage`, `ModelRegistry`, `DefaultResourceLoader`, `SessionManager`, `SettingsManager`, `defineTool`, `getAgentDir`.
- **Events:** `session.subscribe((event) => {...})` — e.g. `event.type === "message_update"` with `event.assistantMessageEvent.type === "text_delta"` and a `.delta` payload.
- **Prompting:** `await session.prompt(text, { streamingBehavior: "steer" }?)`; queueing via `session.steer(text)` / `session.followUp(text)`; `await session.abort()`.
- **Model control:** pass `model`, `thinkingLevel` (`off/minimal/low/medium/high/xhigh`), `authStorage`, `modelRegistry` to `createAgentSession`; at runtime `session.setModel(m)`, `session.cycleModel()`.
- **Persistence (pluggable):** JSONL session files, default `~/.pi/agent/sessions/`. `SessionManager.create(cwd)` (persistent), `SessionManager.inMemory()`, `SessionManager.continueRecent(cwd)`, `SessionManager.open("/path/to/session.jsonl")`.
- **State access:** `session.agent.state` — `.messages`, `.model`, `.tools`, `.systemPrompt`, `.streamingMessage` (the accumulated in-flight message; key for reconnect snapshots); mutable in place for branching.
- **Custom tools/extensions via SDK:** `createAgentSession({ customTools: [defineTool({...})], tools: [...] })`; `new DefaultResourceLoader({ additionalExtensionPaths, extensionFactories, eventBus })` passed as `resourceLoader`. Extensions are TS modules auto-discovered from `~/.pi/agent/extensions/*.ts` (global) or `.pi/extensions/*.ts` (project), exporting `default function (pi: ExtensionAPI)`. API includes `pi.on(...)` (`session_start`, `tool_call`, `input`, `before_agent_start`, `model_select`), `pi.registerTool`, `pi.registerCommand`, `pi.registerShortcut`, `pi.registerFlag`, `pi.sendMessage`, `pi.setModel`, tool activation controls.

### 2.3 RPC mode — why it is NOT the network protocol

- `pi --mode rpc` is strictly **JSONL over stdin/stdout of a local subprocess**. There is **no network/server mode** anywhere in Pi.
- **One process = one active session** (you can `switch_session`/`new_session`, but only one is active at a time).
- Fragile framing: strict LF-only record splitting; docs explicitly warn that Node `readline` is non-compliant (splits on U+2028/U+2029).
- Full command list: `prompt`, `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `get_messages`, `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`, `set_steering_mode`, `set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`, `abort_retry`, `bash`, `abort_bash`, `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`, `set_session_name`, `get_commands`.

### 2.4 Event model (same set across SDK / RPC / JSON modes)

`agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `queue_update`, `compaction_start`, `compaction_end`, `auto_retry_start`, `auto_retry_end`, `extension_error`. Plus interactive `extension_ui_request` / `extension_ui_response` (dialogs: `select`, `confirm`, `input`, `editor`; fire-and-forget: `notify`, `setStatus`, `setWidget`, `setTitle`).

Granularity is **sufficient for a remote streaming UI**: `message_update` carries sub-deltas — `text_start/text_delta/text_end`, `thinking_start/thinking_delta/thinking_end`, `toolcall_start/toolcall_delta/toolcall_end` — and `tool_execution_update` streams accumulated partial tool output. Message types: `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `BashExecutionMessage`, `CustomMessage`, `BranchSummaryMessage`, `CompactionSummaryMessage`.

### 2.5 pi-tui

Standalone, explicitly reusable. Components: `Text`, `TruncatedText`, `Input`, `Editor`, `Markdown`, `Loader`, `CancellableLoader`, `SelectList`, `SettingsList`, `Spacer`, `Image`, `Box`, `Container`. Architecture: `TUI` orchestrator; `Component` interface (`render(width)` → string arrays, optional `handleInput()`, `invalidate()`); `Focusable` for IME/cursor; a `Terminal` interface contract for custom terminal backends. Rendering is three-tier (full render / screen-clear on width change / cursor-movement diffs), wrapped in CSI 2026 synchronized output.

---

## 3. Research Findings: Vercel `eve` (verified against vercel/eve docs)

### 3.1 Project layout

```
my-agent/
├── package.json / tsconfig.json
├── agent/
│   ├── agent.ts             # required: model, modelOptions, compaction, build settings
│   ├── instructions.md      # system prompt (or instructions.ts / instructions/ dir)
│   ├── instrumentation.ts   # OTel config, root-only
│   ├── channels/            # HTTP/messaging entry points (root-only)
│   ├── connections/         # MCP / OpenAPI integrations, one per file
│   ├── hooks/               # lifecycle + stream-event subscribers
│   ├── skills/              # on-demand .md procedures → mounted to /workspace/skills/
│   ├── lib/                 # import-only helpers; never reaches the sandbox
│   ├── sandbox/             # sandbox.ts config + sandbox/workspace/** seeded files
│   ├── tools/               # typed functions, Zod input schemas
│   ├── schedules/           # cron jobs (root-only)
│   └── subagents/<id>/      # self-contained child agents; inherit nothing
└── evals/
```

### 3.2 Mechanics and architecture

- **Path-derived identity**: `agent/tools/get_weather.ts` → tool `get_weather`; no explicit ids. Default-export `defineX()` factories per file type (`defineTool`, `defineChannel`, `defineSchedule`). Discovery never executes authored code — descriptors first, execution only on call. `eve info` prints discovery diagnostics; artifacts in `.eve/`.
- **Runtime**: channels normalize inbound input and own the `continuationToken` (one active per session); the framework-owned harness loop runs Sessions → Turns → Steps (durable checkpoints, one model call + tools each); events are **recorded before step completion**, so the NDJSON stream (`GET /eve/v1/session/<id>/stream`) is fully replayable with a `startIndex` cursor.
- **Self-hosting**: possible (Nitro output, `.workflow-data` local world, Docker/microsandbox `SandboxBackend` adapters), but durable execution is built on the Workflow SDK and the smoothest path is Vercel-hosted.

### 3.3 What to borrow vs. leave

**Borrow (pure conventions):** slot layout + path-derived naming; `defineX()` default-export factories; descriptor-first discovery; skills-in-workspace vs lib-import-only split; subagents-inherit-nothing; sessions/turns/steps framing; the channel-owned continuation token vs runtime-owned session id split; **record-before-fanout replayable event stream with a cursor**; `agena info`-style diagnostics.

**Leave (runtime-tied):** Workflow SDK durability, the immutable eve harness loop and built-in tools, Vercel build pipeline/sandbox/gateway, the `/eve/v1/*` route surface.

Key nuance: eve's filesystem-first layout is its **user-facing authoring surface**, not its backend code organization. Apply it to Agena's extensibility surface (`.agena/`), not to the daemon codebase.

---

## 4. Architecture Decisions

### 4.1 Pi integration: embed the SDK in the daemon (Decision)

**Chosen: Option A — embed `@earendil-works/pi-coding-agent` in the Agena daemon.**

- `createAgentSession()` per session → many concurrent sessions in one process (RPC mode cannot do this).
- `session.subscribe()` delivers full streaming granularity for the remote UI.
- `SessionManager.create(cwd)` writes Pi's JSONL — the **raw archive layer** for free; `SessionManager.open()` resumes; forking via `session.agent.state`.
- Custom tools, extensions, and model switching all available — the foundation of the Agena plugin layer.

Rejected: **Option B — supervise `pi --mode rpc` subprocesses** (one per session). Pros: crash/memory isolation, per-session version pinning. Cons: process supervision overhead, framing gotchas, one-session-per-process, weaker API access — and it still requires a custom network protocol on top, so it buys nothing at the boundary that matters. If isolation is needed later, sessions can move into worker processes as an internal daemon detail without changing the protocol.

**Core principle: Pi's protocol never crosses the network.** The TUI speaks Agena's protocol. The daemon normalizes Pi events into canonical Agena events, assigns per-session monotonic sequence numbers, appends to the Agena event store, then fans out. This buys reconnect/replay, device switching, session multiplexing, protocol versioning independent of Pi, and makes Agena — not Pi's JSONL — the source of truth. Only one normalizer module ever touches Pi's types, isolating the codebase from Pi schema churn.

**Approvals are first-class:** Pi's `extension_ui_request`/`extension_ui_response` (confirm/select/input dialogs) must flow through the Agena protocol as a first-class event pair — this is the tool-approval UX now and the phone-approval UX later.

### 4.2 Wire protocol: WebSocket events + Hono HTTP

- **One WebSocket per client** with envelope `{type, sessionId, seq, payload}` — live event stream plus session commands (prompt, steer, abort, model switch, approval responses). Reconnect with `?from=<seq>`; the daemon replays from the event store. (Same replayable-cursor pattern eve uses.)
- **Hono** for request/response APIs: session list/search, file browse/read, snapshots, import, health. Rationale: tiny, runs on Node and Bun, first-class Zod validation, and the typed `hc` client gives the TUI end-to-end types from route definitions. Preferred over tRPC (heavier coupling) or hand-rolled JSON-RPC.

### 4.3 Two-tier event stream: durable events vs ephemeral frames (Decision)

Pi emits hundreds of deltas per assistant message; persisting each as a row bloats the log ~100x for zero value.

- **Durable events** — persisted, sequence-numbered, source of truth: `message.user.created`, `message.assistant.completed`, `tool.call.started`, `tool.call.completed`, `model.changed`, `compaction.created`, `branch.created`, `session.title.changed`, …
- **Ephemeral stream frames** — text/thinking/tool-output deltas fanned out live over the WS, **never persisted**. Frames carry `after_seq` referencing the durable log position.
- **Reconnect contract:** `replay(from_seq)` → durable events → snapshot of any in-flight message (from `session.agent.state.streamingMessage`) → live frames.

### 4.4 Terminal attach: raw passthrough

- Daemon runs `node-pty`, exposes a dedicated WS endpoint per PTY.
- `agena shell` (or the TUI menu option) **suspends the TUI** (leave alt-screen), puts the real terminal in raw mode, and pipes bytes both ways with resize control messages — effectively `docker exec -it` over Agena's transport.
- **No embedded terminal pane in v1** (requires a full VT100 emulator — a project by itself).
- Later: record PTY output into the event log (asciinema-style) for the visibility goals.

### 4.5 TUI: pi-tui

Use `@earendil-works/pi-tui`: standalone, differential rendering, Markdown/Editor/Input/SelectList components, designed for exactly this app shape, and the rendered events are Pi-shaped. Alternatives if walls are hit: Ink (React model, larger ecosystem, historically struggles with high-frequency streams), OpenTUI.

### 4.6 Runtimes

- **CLI/TUI: Bun** — fast startup, `bun build --compile` produces a single distributable `agena` binary.
- **Daemon: Node** inside the container by default — `node-pty` has had rocky Bun compatibility; verify before committing to Bun server-side. Mixed runtimes across packages is fine.

---

## 5. Repo Structure (monorepo, pnpm or bun workspaces)

```
agena/
├── packages/
│   ├── protocol/     # Zod schemas: canonical events, commands, WS envelope, errors.
│   │                 # THE contract. TUI and daemon both compile against this.
│   ├── core/         # Domain logic: event store, session manager, Pi→Agena
│   │                 # normalizer, snapshots. No HTTP, no rendering.
│   ├── daemon/       # Hono app + WS gateway + Pi SDK embedding + PTY manager.
│   │                 # Runs in the container.
│   ├── client/       # Typed client SDK over protocol (TUI now; desktop/phone later).
│   └── tui/          # The `agena` binary: pi-tui frontend + shell attach.
├── docker/           # Dev container image + compose for the v1 loop.
└── ...
```

- `protocol` is the load-bearing package; everything else refactors freely as long as it holds. Version the protocol from day one.
- **Extensibility surface** (`.agena/` inside a workspace): borrow eve here — path-derived naming, `defineX()` default-export factories, descriptor-first discovery, `agena info` diagnostics. Note Pi already auto-discovers `.pi/extensions/*.ts`; decide whether Agena plugins are Pi extensions under an Agena convention or a layer above (direction doc says above; v1 may delegate to Pi's mechanism as a shortcut).
- **Quality gates from day one:** strict tsconfig (all strict flags), Biome, Vitest, CI on push. High-leverage test pattern: record real Pi event streams as JSONL fixtures and replay them through the normalizer — catches Pi upgrades breaking Agena before runtime does.

---

## 6. Database Schema (v1, SQLite in the container)

### 6.1 Governing invariants

1. **Events are truth; everything else is disposable.** Every table other than `events` (and raw import records) must be rebuildable from `events`. Build `agena rebuild` early (~50 lines); projection schema changes then become drop → migrate → rebuild, never data migrations.
2. **Sequence per session, branch as a column.** One monotonic `seq` counter per session, assigned inside the append transaction. Branches record `parent_branch_id` + `forked_from_seq`; replaying a branch walks the parent chain up to each fork point. v1 ships single-branch sessions with the model already in place (matches how Pi models trees in one JSONL).
3. **`appendEvents` is the only write path** — seq assignment, projection updates, and WS fanout happen inside one transaction boundary, guaranteeing clients never see a non-durable event.

### 6.2 DDL

```sql
-- ── source of truth ────────────────────────────────────────────
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,          -- ULID (time-sortable)
  workspace_id    TEXT NOT NULL,
  title           TEXT,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | idle | archived
  source          TEXT NOT NULL DEFAULT 'native',  -- native | claude | codex
  active_branch_id TEXT,
  pi_session_path TEXT,                      -- pointer to Pi's raw JSONL (raw layer)
  last_seq        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE TABLE branches (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  parent_branch_id TEXT REFERENCES branches(id),
  forked_from_seq  INTEGER,                  -- NULL for the root branch
  name             TEXT,
  created_at       TEXT NOT NULL
) STRICT;

CREATE TABLE events (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq        INTEGER NOT NULL,               -- per-session, assigned in the append tx
  branch_id  TEXT NOT NULL,
  type       TEXT NOT NULL,                  -- 'message.assistant.completed', ...
  v          INTEGER NOT NULL DEFAULT 1,     -- payload schema version
  payload    TEXT NOT NULL,                  -- JSON, validated by protocol zod schema
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT;
CREATE INDEX idx_events_type ON events(session_id, type, seq);

-- ── projections (rebuildable — never migrated, only rebuilt) ───
CREATE TABLE messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,               -- the completing event
  role       TEXT NOT NULL,                  -- user | assistant | tool | system
  model      TEXT,                           -- which model produced it
  content    TEXT NOT NULL,                  -- JSON blocks
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE tool_calls (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  message_id  TEXT,
  name        TEXT NOT NULL,
  args        TEXT,                          -- JSON
  result      TEXT,                          -- JSON; large outputs → blob ref
  status      TEXT NOT NULL,                 -- running | ok | error | denied
  started_seq INTEGER NOT NULL,
  ended_seq   INTEGER,
  created_at  TEXT NOT NULL
) STRICT;

-- full-text search over titles + message text → `agena search`
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content, session_id UNINDEXED, message_id UNINDEXED
);

-- ── import layer (raw-archive design from the direction doc) ───
CREATE TABLE imports (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,                 -- claude | codex
  machine_id  TEXT,
  raw_path    TEXT NOT NULL,                 -- raw_imports/... on disk, never in DB
  stats       TEXT,                          -- JSON: counts, errors
  imported_at TEXT NOT NULL
) STRICT;

CREATE TABLE imported_sessions (
  import_id       TEXT NOT NULL REFERENCES imports(id),
  source_ref      TEXT NOT NULL,             -- original session id/path
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  resume_summary  TEXT,                      -- JSON: the resume-ready layer
  PRIMARY KEY (import_id, source_ref)
) STRICT;

-- ── workspace ──────────────────────────────────────────────────
CREATE TABLE snapshots (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id   TEXT,                         -- optional association
  name         TEXT,
  kind         TEXT NOT NULL,                -- manual | auto | pre_tool
  storage_path TEXT NOT NULL,                -- tarball/git ref on disk
  created_at   TEXT NOT NULL
) STRICT;
```

### 6.3 Design notes

- **Payloads are JSON `TEXT` validated by `packages/protocol` Zod schemas** before insert — the protocol package, not the DB, owns payload shape. The `v` column lets old rows survive schema evolution (replay upcasts old versions).
- **Model switches, compactions, shares are event types, not tables.** The `(session_id, type, seq)` index answers "all model changes" fast. Promote a type to a projection only when a real query hurts. Deferred tables from the research doc: `model_switches`, `share_links`, `devices`, `device_cursors`, `audit_event`, `workspace_file_manifest` (container FS *is* the manifest in v1; `agena files` reads it live). Device cursors live client-side in v1; the server's `last_seq` covers the rest.
- **Large tool outputs:** cap inline `result` (~64KB); spill bigger payloads to content-addressed files on disk with `{blob: "sha256:..."}` refs — keeps the DB small and seeds the later blob store.
- **Pi's JSONL files stay on disk as the raw layer** (pointer in `sessions.pi_session_path`) — never mutated; kept for debugging and re-normalization.

### 6.4 Tooling

- SQLite: WAL mode, `busy_timeout`, `foreign_keys=ON`, `STRICT` tables. Single daemon process = single writer; SQLite's one-writer model is a non-issue.
- **Drizzle ORM** — typed schemas targeting both SQLite and Postgres, generated migrations, pairs with the Zod-first protocol. The eventual Postgres move swaps the driver with schema definitions mostly intact (JSON `TEXT` → `jsonb`; FTS5 → `tsvector` are the two real rewrites).
- **ULIDs** for all ids — time-sortable, coordination-free, index-friendly.
- Store interface in `packages/core`: `appendEvents`, `readEvents(sessionId, fromSeq)`, `rebuildProjections`.

---

## 7. Build Order

1. **Walking skeleton** — `protocol` package; daemon in Docker embedding one Pi session; TUI over WS; prompt in → streamed deltas rendered. Proves the whole architecture end to end.
2. **Replay/reconnect** — SQLite event store, seq numbers, `?from=` resume. Acceptance test: kill the TUI mid-stream, reopen, watch it catch up. That is the "feels local" moment.
3. **`agena shell`** — PTY attach (suspend TUI, raw passthrough).
4. **Multi-session** — list, new, resume, fork; approval flow through the protocol.
5. **Importers** — `agena import claude` / `agena import codex` per the existing backfill design (raw archive → normalized events → resume-ready summary).

---

## 8. Risks and Open Questions

- **Pi is a moving target** — pin versions; the normalizer is the single isolation point; keep JSONL fixtures of recorded Pi streams as contract tests.
- **Plugin layering** — Agena plugins as Pi extensions under an Agena convention vs. an independent layer above Pi (direction doc prefers above; v1 may delegate to Pi's mechanism).
- **node-pty on Bun** — verify before choosing Bun for the daemon; Node is the safe default there.
- **Single-container v1** couples daemon + workspace; the protocol boundary defined now is what makes the later control-plane/workspace-plane split possible without client changes.
- **Next artifact to produce:** the canonical event type list + Zod payload schemas — it defines `protocol`, the DB payloads, and the WS wire format in one stroke.

---

## 9. One-Paragraph Summary

Agena v1 is a Bun-compiled local TUI (`agena`) built on pi-tui, speaking an Agena-owned protocol — Hono HTTP for request/response, one WebSocket with a `{type, sessionId, seq, payload}` envelope for commands and a replayable event stream — to a Node daemon in a Docker container that embeds the Pi SDK (`createAgentSession` per session), normalizes Pi events into canonical Agena events, and appends them to an append-only SQLite event store (Drizzle, ULIDs, FTS5) that is the source of truth, with Pi's JSONL as the raw layer, projections that are always rebuildable, ephemeral deltas that stream but never persist, and `agena shell` as raw PTY passthrough — so it feels local everywhere while every important action is durable, replayable, and device-independent.
