# Agena V1 Updated Architecture Plan

## Status

This is the updated V1 plan after comparing the initial Codex plan with the newer architecture notes in `claude_plan.md`.

The updated position is:

```text
Agena owns the protocol, event store, workspace model, terminal attach, and client contract.
Pi powers the first runtime through an internal adapter.
The local TUI never speaks Pi RPC directly.
The daemon runs in Docker for V1 and later moves to a real cloud workspace.
The first milestone is an end-to-end walking skeleton, not a large foundation-only scaffold.
```

The main changes from the earlier plan:

- use a replayable WebSocket as the main interactive channel;
- split durable events from ephemeral stream frames;
- treat approval prompts as first-class protocol events;
- adopt stricter SQLite event-store invariants;
- prototype the TUI with `pi-tui` first, not Ink first;
- use a walking skeleton as the first build milestone;
- keep HTTP/Hono for ordinary request-response APIs.

## Product Shape

Agena V1 is a local-feeling terminal harness whose actual runtime lives inside a persistent workspace environment.

For development, that workspace environment is a Docker container on the local machine.

Later, the same daemon/runtime shape can move to:

- a cloud VM;
- a managed devbox;
- a container runtime;
- a microVM runtime;
- a customer VPC workspace.

The desired user flow:

```bash
agena
agena shell
agena new "task description"
agena resume
agena sessions
agena files
agena share <path>
agena snapshot create "before refactor"
```

The product should feel local in these ways:

- typing `agena` opens a local TUI immediately;
- messages stream as if the agent is local;
- tool calls and terminal output are visible live;
- `agena shell` drops the user into the same workspace the agent sees;
- reconnecting restores state without forcing the user to mentally rebuild context;
- files live in a normal-looking workspace tree;
- the local client is a thin view over durable cloud/container state.

## Non-Negotiable Architecture Principles

### 1. Agena Protocol First

Pi is an internal runtime, not the product protocol.

The TUI should speak:

```text
Agena protocol
```

not:

```text
Pi RPC
Pi JSON event stream
Pi SDK events
```

Why:

- the TUI should survive runtime changes;
- the event store should not inherit Pi schema churn;
- future clients need one stable contract;
- reconnect and replay need Agena-owned sequence numbers;
- cloud sync needs a protocol designed for network clients;
- shell, files, snapshots, approvals, and workspace status are broader than Pi.

### 2. Pi Adapter Boundary

All Pi-specific imports and event mapping should live in one package:

```text
packages/runtime-pi
```

Everything else depends on Agena interfaces.

The mapping chain should be:

```text
Pi SDK event -> RuntimeEvent -> Agena durable event or ephemeral frame -> TUI
```

Raw Pi data may be archived for debugging, but normalized Agena events are the product source of truth.

### 3. Events Are Truth

The durable event log is the core data model.

Every table other than raw archive records and durable events should be treated as a rebuildable projection.

This gives Agena:

- replay;
- reconnect;
- auditability;
- branch history;
- future device sync;
- easier projection changes;
- stable import/export.

### 4. Do Not Persist Every Delta

Streaming text deltas are important for live UX, but they are not all durable history.

Persisting every token or small text delta as a database row creates avoidable bloat and slow replay.

Use a two-tier model:

```text
Durable events:
  Stored in SQLite.
  Replayed on reconnect.
  Used to rebuild projections.

Ephemeral frames:
  Streamed live over WebSocket.
  Not stored as source-of-truth rows.
  Refer to the latest durable sequence.
```

Example durable events:

```text
session.created
branch.created
message.user.created
message.assistant.started
message.assistant.completed
tool.call.started
tool.call.completed
tool.call.failed
model.changed
compaction.created
approval.requested
approval.responded
snapshot.created
terminal.session.started
terminal.session.ended
```

Example ephemeral frames:

```text
message.assistant.text.delta
message.assistant.thinking.delta
tool.output.delta
terminal.output.chunk
status.transient
```

The reconnect contract:

```text
client reconnects with last durable seq
daemon replays durable events after seq
daemon sends snapshot of any in-flight assistant message
daemon resumes live ephemeral frames
```

## Source-Backed Findings

### Pi Findings

Pi is a good V1 runtime because it already provides much of the agent engine Agena needs.

Relevant capabilities:

- TypeScript SDK;
- `createAgentSession`;
- session subscription;
- prompt, steer, follow-up, abort;
- model switching;
- thinking-level changes;
- compaction;
- JSONL session persistence;
- extensions and custom tools;
- event stream granularity;
- reusable terminal UI package.

Relevant docs and source:

- Pi RPC docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md
- Pi SDK docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- Pi JSON event mode: https://pi.dev/docs/latest/json
- Pi repository: https://github.com/earendil-works/pi

Important conclusion:

```text
Use Pi SDK inside the daemon for V1.
Keep Pi RPC as a fallback/debug adapter.
Do not use Pi RPC as the Agena network protocol.
```

Why SDK first:

- supports many sessions in one daemon process;
- avoids JSONL subprocess framing issues;
- has direct event subscription;
- allows direct access to runtime/session state;
- makes event mapping and testing easier;
- gives access to Pi tools, extensions, and model controls.

Why not Pi RPC first:

- one active session per process;
- process supervision overhead;
- strict LF framing gotchas;
- weaker typed access;
- still requires a custom network protocol above it;
- does not solve reconnect, replay, files, shell, or approvals by itself.

### Eve Findings

Eve is useful as a structural reference, not as the runtime to adopt.

Borrow:

- filesystem-first authoring layout;
- path-derived naming;
- `defineX()` style factories;
- descriptor-first discovery;
- `tools/`, `skills/`, `hooks/`, `sandbox/`, `subagents/` style slots;
- diagnostics command like `agena info`;
- replayable stream with cursor;
- channel/session separation concepts.

Leave:

- Vercel-specific hosting assumptions;
- Workflow SDK durability as a required dependency;
- Eve route surface;
- framework-owned harness loop.

Important nuance:

```text
Eve's filesystem-first layout should influence Agena's extensibility surface,
not necessarily the internal daemon code organization.
```

In other words:

```text
.agena/tools
.agena/skills
.agena/hooks
.agena/sandbox
```

is more important than making the daemon source tree look exactly like Eve.

## Recommended V1 System Architecture

```text
Local terminal
  |
  | agena CLI/TUI
  v
Local Agena client
  |
  | WebSocket for interactive session protocol
  | Hono HTTP for ordinary APIs
  v
Agena daemon inside Docker container
  |
  | runtime adapter interface
  v
Pi SDK runtime
  |
  | direct filesystem access
  v
/workspace
```

### Local Client

The local client includes:

- CLI entrypoint;
- TUI renderer;
- typed SDK client;
- shell attach command;
- local config;
- reconnect state such as last seen durable sequence.

Responsibilities:

- render normalized Agena events;
- send prompts and control commands;
- reconnect to sessions;
- display tool calls, approvals, and status;
- launch `agena shell`;
- call HTTP APIs for session list, file browse, snapshots, and health.

Non-responsibilities:

- no direct Pi SDK usage;
- no direct Pi RPC usage;
- no direct DB access;
- no durable session logic;
- no runtime-specific event interpretation outside presentation mapping.

### Daemon

The daemon runs inside the Docker workspace for V1.

Responsibilities:

- expose Hono HTTP routes;
- expose the replayable WebSocket protocol;
- manage sessions;
- embed the Pi SDK;
- normalize Pi events;
- persist durable events;
- stream ephemeral frames;
- manage workspace path and file APIs;
- manage PTY sessions;
- handle approvals;
- store raw Pi JSONL/session paths;
- rebuild projections from events;
- provide diagnostics.

### Runtime Adapter

Define a generic runtime adapter interface.

Example:

```ts
interface RuntimeAdapter {
  id: string;
  startSession(input: StartSessionInput): Promise<RuntimeSession>;
  resumeSession(input: ResumeSessionInput): Promise<RuntimeSession>;
  sendPrompt(input: SendPromptInput): Promise<void>;
  steer?(input: SteerInput): Promise<void>;
  followUp?(input: FollowUpInput): Promise<void>;
  abort(input: AbortInput): Promise<void>;
  switchModel?(input: SwitchModelInput): Promise<void>;
  respondToApproval?(input: ApprovalResponseInput): Promise<void>;
}

interface RuntimeSession {
  runtimeSessionId: string;
  events: AsyncIterable<RuntimeEvent>;
  getInFlightSnapshot?(): Promise<InFlightSnapshot | null>;
  dispose(): Promise<void>;
}
```

Pi is the first implementation.

Later implementations may include:

- native Agena runtime;
- Pi RPC subprocess mode;
- OpenCode adapter;
- test/fake runtime;
- remote worker runtime.

## Wire Protocol

### Main Interactive Channel

Use one WebSocket per client for interactive session traffic.

Envelope:

```ts
type WireEnvelope = {
  type: string;
  sessionId?: string;
  seq?: number;
  requestId?: string;
  payload: unknown;
};
```

The WebSocket handles:

- live durable events;
- ephemeral stream frames;
- prompt submission;
- steer/follow-up;
- abort;
- model switch;
- approval responses;
- session status;
- reconnect replay.

Reconnect:

```text
GET /v1/ws?sessionId=<id>&fromSeq=<last-seen-seq>
```

On reconnect:

1. daemon authenticates client;
2. daemon replays durable events after `fromSeq`;
3. daemon sends in-flight assistant/tool snapshot if any;
4. daemon resumes live stream.

### HTTP APIs

Use Hono for ordinary request-response APIs.

Examples:

```http
GET    /health
GET    /v1/sessions
POST   /v1/sessions
GET    /v1/sessions/:id
GET    /v1/sessions/:id/events?fromSeq=100
GET    /v1/workspace/files?path=/
GET    /v1/workspace/file?path=/repo/README.md
PUT    /v1/workspace/file?path=/repo/README.md
POST   /v1/workspace/upload
GET    /v1/workspace/download?path=/repo/out.zip
POST   /v1/workspace/snapshots
GET    /v1/diagnostics
```

Why both WebSocket and HTTP:

- WebSocket is better for interactive live agent control;
- HTTP is better for idempotent fetches, file APIs, health, snapshots, and diagnostics;
- this avoids forcing everything into a single protocol shape.

## Approval Flow

Approvals must be first-class in Agena.

Pi exposes interactive UI requests such as confirm/select/input/editor. Agena should normalize those into durable protocol events.

Example durable events:

```text
approval.requested
approval.responded
approval.expired
approval.cancelled
```

Example request payload:

```ts
type ApprovalRequestedPayload = {
  approvalId: string;
  kind: "confirm" | "select" | "input" | "editor";
  title?: string;
  message: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  defaultValue?: string;
  source: {
    runtime: "pi";
    rawRequestId?: string;
  };
};
```

Why this is important:

- tool approval UX works in V1;
- remote approval works later from phone/desktop;
- audit history can show who approved what;
- approval state survives reconnects;
- Pi-specific UI requests do not leak into clients.

## Event Store And SQLite Design

Use SQLite in the container for V1.

SQLite is the right V1 choice because:

- single daemon process;
- one primary writer;
- local Docker environment;
- simple operational model;
- enough durability for early versions;
- easy backup and inspection;
- can migrate to Postgres later with a clean store interface.

### Governing Invariants

1. Events are truth.

Every table except `events` and raw import/archive records should be rebuildable.

2. One monotonic sequence per session.

`seq` is assigned inside the append transaction.

3. Branch is a column on events.

V1 can ship single-branch sessions, but branch shape should exist from day one.

4. `appendEvents` is the only durable write path.

It assigns sequence numbers, writes events, updates projections, and triggers fanout.

5. Durable event replay is enough to rebuild UI state.

Ephemeral deltas improve live experience, but durable events must reconstruct final session state.

6. Payload shape belongs to `packages/protocol`.

The database stores versioned JSON payloads validated by Zod schemas.

### V1 SQLite DDL

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'native',
  active_branch_id TEXT,
  pi_session_path TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_branch_id TEXT REFERENCES branches(id),
  forked_from_seq INTEGER,
  name TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE events (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  type TEXT NOT NULL,
  v INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT;

CREATE INDEX idx_events_type ON events(session_id, type, seq);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  model TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT,
  name TEXT NOT NULL,
  args TEXT,
  result TEXT,
  status TEXT NOT NULL,
  started_seq INTEGER NOT NULL,
  ended_seq INTEGER,
  created_at TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  message_id UNINDEXED
);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  machine_id TEXT,
  raw_path TEXT NOT NULL,
  stats TEXT,
  imported_at TEXT NOT NULL
) STRICT;

CREATE TABLE imported_sessions (
  import_id TEXT NOT NULL REFERENCES imports(id),
  source_ref TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  resume_summary TEXT,
  PRIMARY KEY (import_id, source_ref)
) STRICT;

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT,
  name TEXT,
  kind TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
```

### SQLite Tooling

Use:

- WAL mode;
- `busy_timeout`;
- `foreign_keys=ON`;
- `STRICT` tables;
- ULIDs for IDs;
- Drizzle ORM;
- Zod validation before insert;
- FTS5 for initial session/message search.

Store interface:

```ts
interface EventStore {
  appendEvents(input: AppendEventsInput): Promise<AppendEventsResult>;
  readEvents(sessionId: string, fromSeq: number): Promise<AgenaEvent[]>;
  readSession(sessionId: string): Promise<SessionRecord | null>;
  rebuildProjections(sessionId?: string): Promise<void>;
}
```

Large tool outputs:

- keep small results inline;
- cap inline payloads around 64 KB;
- spill larger outputs to content-addressed files;
- store `{ blob: "sha256:..." }` references in payloads.

## Terminal Strategy

Terminal is owned by Agena, not Pi.

### `agena shell`

This is the primary V1 terminal path.

The daemon should expose a dedicated PTY endpoint.

Implementation shape:

```text
local CLI leaves/suspends TUI alt-screen
local terminal enters raw mode
bytes flow over PTY WebSocket
daemon runs node-pty inside workspace container
resize events are forwarded
exit restores local terminal
```

Why this is better than an embedded terminal pane in V1:

- avoids building a full VT100 emulator;
- keeps the TUI simpler;
- gives real terminal behavior quickly;
- matches the "feels local" goal;
- still works when the workspace later moves to the cloud.

Later, Agena can record PTY output asciinema-style for visibility and replay.

### Embedded TUI Terminal

Explicit non-goal for early V1.

It can come later after:

- agent event stream works;
- reconnect works;
- shell attach works;
- file APIs work.

## Filesystem Strategy

Use the container filesystem directly as the V1 workspace.

Suggested layout:

```text
/workspace
  repo/
  .agena/
    config.json
    sessions.db
    raw-runtime-events/
    snapshots/
    artifacts/
    skills/
    tools/
    hooks/
    sandbox/
```

The daemon should expose file APIs, but it does not need a complex file manifest in V1.

Why:

- the container filesystem is the manifest for V1;
- direct reads are simpler;
- snapshots can be tarballs or git refs;
- object storage can come later.

Later evolution:

```text
container filesystem -> file index projection -> object/blob store -> cloud sharing
```

## TUI Strategy

Prototype with `@earendil-works/pi-tui` first.

Reason:

- built for terminal UI;
- differential rendering;
- Markdown/input/editor/select components;
- high-frequency stream rendering is central to Agena;
- closer to the interaction pattern than generic React terminal libraries.

Fallback options:

- Ink, if React-style composition becomes more valuable;
- OpenTUI, if lower-level terminal performance/control is needed;
- custom renderer only if both fail.

Important boundary:

```text
Using pi-tui does not mean the TUI renders raw Pi events.
```

The TUI still renders normalized Agena events and frames.

Initial TUI views:

- session stream;
- prompt input;
- tool activity list;
- approval modal/prompt;
- status bar with model/session/workspace;
- command palette;
- diagnostics/log panel;
- session picker.

Initial TUI commands:

```text
new session
resume session
send prompt
steer current turn
follow up
abort turn
respond to approval
show tool calls
show files
open shell
copy session id
quit
```

## Runtime Choices

### CLI/TUI Runtime

Prefer Bun for the CLI/TUI if packaging works cleanly.

Why:

- fast startup;
- easy TypeScript execution;
- can compile a single binary with `bun build --compile`;
- good local CLI ergonomics.

Keep this provisional until tested with:

- `pi-tui`;
- terminal raw mode;
- WebSocket client behavior;
- packaging on macOS and Linux.

### Daemon Runtime

Use Node.js inside the Docker container by default.

Why:

- `node-pty` is safer on Node;
- Pi SDK compatibility is more likely to be stable;
- fewer runtime edge cases;
- Docker startup cost makes Bun speed less important server-side.

Mixed runtimes are acceptable:

```text
Bun CLI/TUI
Node daemon
shared TypeScript packages
```

## Framework Recommendation

Use Hono for HTTP APIs.

Why:

- small and typed;
- easy to mount by module;
- works well with Zod;
- avoids heavy framework ceremony;
- good fit for a daemon API surface.

Use WebSocket separately for interactive session protocol.

Avoid:

- NestJS for V1, because it adds ceremony and dependency-injection weight;
- raw Express, because the codebase needs stronger type and schema discipline;
- tRPC as the main protocol, because it couples client/server too tightly for a future multi-client harness.

## Recommended Monorepo Structure

Use a TypeScript monorepo from day one.

Recommended layout:

```text
agena/
  apps/
    cli/
      src/
        main.ts
        commands/
        shell/
        config/

    daemon/
      src/
        server.ts
        routes/
        ws/
        pty/
        bootstrap.ts

  packages/
    protocol/
      src/
        events.ts
        frames.ts
        commands.ts
        approvals.ts
        api.ts
        errors.ts
        version.ts

    client/
      src/
        client.ts
        sessions.ts
        workspace.ts
        shell.ts

    core/
      src/
        sessions/
        events/
        projections/
        workspaces/
        approvals/
        runtime/

    runtime-pi/
      src/
        adapter.ts
        event-map.ts
        sdk-runner.ts
        rpc-runner.ts
        fixtures/

    storage-sqlite/
      src/
        schema.ts
        migrations/
        store.ts
        rebuild.ts

    tui/
      src/
        app.ts
        views/
        components/
        keymap.ts
        renderer/

  docker/
    Dockerfile
    compose.yml

  evals/
    fixtures/
    runtime-events/

  docs/
    protocol.md
    architecture.md
```

### Workspace Extensibility Surface

Inside each workspace:

```text
/workspace/.agena/
  tools/
  skills/
  hooks/
  sandbox/
  config.json
```

Borrow Eve-style conventions here:

- path-derived names;
- `defineTool`;
- `defineHook`;
- `defineSkill`;
- descriptor-first discovery;
- diagnostics via `agena info`.

Open decision:

```text
Should V1 Agena plugins compile down to Pi extensions,
or should Agena maintain its own plugin layer above Pi from the start?
```

Recommendation:

- use Pi extension support as an internal bridge only if it accelerates V1;
- keep Agena's plugin authoring surface independent.

## Package Dependencies

Dependency rules:

- `packages/protocol` imports no app, daemon, TUI, storage, or Pi code.
- `packages/client` depends on `protocol`.
- `packages/tui` depends on `client` and `protocol`.
- `packages/core` depends on `protocol` and runtime/storage interfaces.
- `packages/runtime-pi` is the only package that imports Pi.
- `packages/storage-sqlite` depends on `protocol` and `core` interfaces.
- `apps/daemon` wires `core`, `storage-sqlite`, `runtime-pi`, Hono, and PTY.
- `apps/cli` wires `client`, `tui`, config, and shell attach.

This prevents runtime coupling from leaking into the client or protocol.

## Protocol Package

The next most important artifact is the canonical protocol package.

It should define:

- durable event schemas;
- ephemeral frame schemas;
- command schemas;
- approval schemas;
- API response schemas;
- error schemas;
- protocol version;
- migration/upcast helpers.

Example durable event:

```ts
type AgenaEvent<TPayload = unknown> = {
  sessionId: string;
  branchId: string;
  seq: number;
  type: string;
  v: number;
  payload: TPayload;
  createdAt: string;
  source: {
    kind: "user" | "daemon" | "runtime" | "terminal" | "filesystem";
    runtime?: "pi";
  };
};
```

Example ephemeral frame:

```ts
type AgenaFrame<TPayload = unknown> = {
  type: string;
  sessionId: string;
  afterSeq: number;
  payload: TPayload;
  emittedAt: string;
};
```

## Build Plan

### Milestone 1: Walking Skeleton

This should come first.

Goal:

```text
Prove the full loop before building a large framework.
```

Deliverables:

- `protocol` package with minimal schemas;
- daemon running in Docker;
- one embedded Pi SDK session;
- WebSocket from TUI to daemon;
- prompt input from TUI;
- streamed assistant output rendered in TUI;
- minimal durable event append;
- raw Pi event logging;
- health route.

Acceptance test:

```text
Run agena.
Send one prompt.
See streamed output.
Restart the TUI.
Reconnect to the same session.
```

### Milestone 2: Replay And Reconnect

Deliverables:

- SQLite event store;
- per-session `seq`;
- `fromSeq` replay;
- in-flight message snapshot;
- durable/ephemeral split;
- rebuildable message projection.

Acceptance test:

```text
Kill the TUI mid-stream.
Reopen agena.
It replays durable history and resumes live state.
```

This is the core "feels local" moment.

### Milestone 3: Shell Attach

Deliverables:

- `agena shell`;
- daemon PTY endpoint;
- raw mode passthrough;
- resize support;
- TUI suspend/resume behavior;
- workspace path consistency.

Acceptance test:

```text
Create a file in agena shell.
Ask the agent about it.
The agent sees the same file.
```

### Milestone 4: Approvals And Controls

Deliverables:

- approval.requested event;
- approval.responded command/event;
- confirm/select/input support;
- prompt/steer/follow-up/abort;
- model switch command.

Acceptance test:

```text
Runtime asks for confirmation.
TUI shows approval UI.
User responds.
Runtime continues.
Reconnect preserves pending approval.
```

### Milestone 5: Sessions And Files

Deliverables:

- session list;
- new/resume;
- basic fork shape;
- file list/read APIs;
- snapshot create;
- simple search through FTS5.

Acceptance test:

```text
User can start multiple sessions,
resume one,
inspect files,
and search previous message history.
```

### Milestone 6: Importers

Deliverables:

- raw archive directory;
- import metadata tables;
- normalized imported sessions;
- resume-ready summaries.

Acceptance test:

```text
Import old sessions.
Search them.
Open a summary.
Start a new native Agena session from the imported context.
```

## Testing Strategy

High-leverage tests:

- protocol schema tests;
- Pi event mapper fixture tests;
- appendEvents transaction tests;
- replay ordering tests;
- projection rebuild tests;
- WebSocket reconnect tests;
- approval round-trip tests;
- PTY shell smoke tests;
- daemon restart tests.

Pi-specific test strategy:

```text
Record real Pi event streams as JSONL fixtures.
Replay fixtures through runtime-pi event mapper.
Assert stable Agena events and frames.
```

This protects Agena from Pi upgrade churn.

## Quality Gates

Set these up from the start:

- strict TypeScript;
- Biome or equivalent formatter/linter;
- Vitest;
- protocol schema validation;
- CI typecheck and tests;
- dependency pinning;
- fixture tests for runtime mapping;
- migration tests for SQLite schema;
- a small `agena info` diagnostics command.

Recommended package manager:

```text
pnpm workspaces
```

Reason:

- predictable monorepo linking;
- efficient installs;
- broad ecosystem compatibility;
- less runtime-specific than choosing Bun workspaces immediately.

Bun can still be used for the compiled CLI if it proves stable.

## Risks And Mitigations

### Risk: Pi Coupling Leaks Everywhere

Mitigation:

- isolate Pi imports in `packages/runtime-pi`;
- map events immediately;
- store raw Pi data separately;
- test mapper fixtures;
- never expose Pi protocol to clients.

### Risk: Event Log Bloats

Mitigation:

- durable events only for semantic state;
- ephemeral frames for live deltas;
- final assistant message content stored once;
- large outputs spill to blobs.

### Risk: Reconnect Feels Broken

Mitigation:

- design around `seq` from day one;
- implement replay before adding many features;
- use in-flight snapshots;
- test TUI kill/reopen during streaming.

### Risk: Terminal Work Expands Too Much

Mitigation:

- build raw `agena shell`;
- do not build embedded terminal pane in V1;
- use node-pty;
- add terminal recording later.

### Risk: Bun Runtime Issues

Mitigation:

- use Node for daemon;
- evaluate Bun only for CLI/TUI packaging;
- keep shared packages runtime-neutral where practical.

### Risk: Plugin Layer Becomes Confused

Mitigation:

- define Agena's `.agena/` authoring surface early;
- use Pi extensions only as internal implementation if needed;
- keep user-facing plugin model independent.

### Risk: SQLite Schema Hardens Too Early

Mitigation:

- events are source of truth;
- projections are rebuildable;
- write `agena rebuild` early;
- version event payloads;
- keep storage behind an interface.

## V1 Non-Goals

Do not build these in early V1:

- hosted multi-user SaaS;
- team permissions;
- billing;
- phone app;
- desktop GUI;
- full browser IDE;
- embedded terminal pane;
- complex CRDT sync;
- plugin marketplace;
- enterprise auth;
- multi-tenant isolation;
- perfect replay of imported legacy sessions.

## Final Recommended V1 Definition

Agena V1 should be:

```text
A local TUI and shell client talking to a Docker-hosted daemon
that embeds Pi through an internal SDK adapter,
normalizes runtime output into an Agena-owned replayable protocol,
persists semantic durable events in SQLite,
streams high-frequency frames live over WebSocket,
uses the container filesystem as the workspace,
and exposes shell/files/session controls so the whole thing feels local.
```

The first success condition is not a full feature set.

The first success condition is:

```text
I can type agena, send a prompt, watch the agent stream live,
kill and reopen the TUI, resume the same session,
open agena shell, and see the same workspace the agent sees.
```

Once that loop is solid, the rest of the product can grow without changing the core contract.
