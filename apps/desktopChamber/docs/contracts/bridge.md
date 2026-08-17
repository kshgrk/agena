# Bridge & Client Contracts

This is the complete renderer↔host contract for the desktopNew renderer. The
builders of desktopNew do NOT read the original sources — this doc is the
contract. Source of truth files (do not edit them, mirror them):

- `apps/desktopChamber/src/shared/bridge.ts` — the `AgenaBridge` type (renderer↔main contract)
- `apps/desktopChamber/src/renderer/lib/bridge.ts` — preload adapter
- `packages/client/src/client.ts` — `AgenaClient` SDK (lives in Electron main ONLY)
- `apps/desktopChamber/electron/bridge.mjs` — the real host implementation

Layering rule (D-INV-2): renderer code depends on the `AgenaBridge` type and
`@agena/protocol` types ONLY. `@agena/client` and the daemon token live in the
Electron main process and never enter the renderer. Bridge method names and
semantics mirror `@agena/client` so renderer code reads like SDK code.

---

## 1. UiBatch — the streaming contract

All daemon push traffic (events, frames, syncs, snapshots, lost sessions)
reaches the renderer exclusively through `onBatch(cb)`. The Electron main
buffers everything from `AgenaClient` callbacks and flushes one `UiBatch`
every 16 ms (`FLUSH_MS = 16`, one renderer frame).

The doc comment below is copied verbatim from `shared/bridge.ts` — the three
rules are BINDING on every implementation (real host, mock, and the renderer
apply logic):

```ts
/**
 * One ordered delivery unit, flushed to the renderer at most once per animation
 * frame. Rules (binding on every implementation):
 *   1. Within a batch the renderer applies: events (in array order) → snapshots
 *      → frames. Frames only touch in-flight state, so this order is always safe.
 *   2. Durable events are NEVER dropped or reordered; seq order per session is
 *      preserved across batches.
 *   3. Frames coalesce per target while a batch is unflushed:
 *      `message.assistant.text.delta` merges by CONCATENATING `delta` for the
 *      same (sessionId, messageId, blockIndex); `tool.call.output.delta` merges
 *      by concatenation for the same (sessionId, toolCallId) unless `reset` is
 *      true, which discards the accumulation and starts over. Never keep-latest
 *      for deltas — that loses text.
 */
export type UiBatch = {
  events: Array<{ event: AgenaEvent; replayed: boolean }>;
  frames: AgenaFrame[];
  syncs: Array<{ sessionId: string; branchId: string; upToSeq: number }>;
  snapshots: InFlightSnapshot[];
  /** Sessions the daemon no longer knows (SESSION_NOT_FOUND on subscribe). */
  lostSessions: string[];
};
```

### How the real host composes batches (electron/bridge.mjs)

Understand this so the renderer's apply logic matches:

- `client.onEvent(event, replayed)` → pushed onto `buf.events` in arrival
  order. Never coalesced, never dropped.
- `client.onFrame(f)` → coalesced per rule 3. Implementation detail: the
  batcher keeps `textKeys` / `toolKeys` maps of coalesce-key → index into
  `buf.frames`. For `message.assistant.text.delta` the key is
  `` `${f.sessionId}\0${p.messageId}\0${p.blockIndex}` ``; for
  `tool.call.output.delta` it is `` `${f.sessionId}\0${p.toolCallId}` ``.
  On merge, `prev.payload.delta = prev.payload.delta + p.delta` and
  `prev.afterSeq = f.afterSeq` (afterSeq advances to the newest). A
  `tool.call.output.delta` with `reset: true` REPLACES the accumulated frame
  in place rather than concatenating. Frames of any other type are appended
  untouched. Coalesce maps are cleared at every flush — coalescing never
  spans batches.
- `client.onSync(sessionId, upToSeq)` → pushed onto `buf.syncs` with the
  `branchId` recorded from that session's most recent `subscribe` ack
  (`branchIds` map in main; `""` if unknown).
- `client.onSnapshot(snapshot)` → pushed onto `buf.snapshots`.
- `client.onSessionLost(sessionId)` → pushed onto `buf.lostSessions`.
  Fires when `subscribe` got `SESSION_NOT_FOUND` — the renderer should drop
  its cursor and UI state for that session.

Renderer apply order within one batch: **events (array order) → snapshots →
frames**. A `sync` for a session means replay is complete up to `upToSeq`;
frames arriving before a session's sync were already discarded SDK-side, so
the renderer can treat frames as always post-sync.

`replayed: true` on an event means it was replayed from history after
subscribe (vs. live). Apply identically; use the flag only for things like
suppressing notifications/sounds.

---

## 2. PTY MessagePort protocol

`openPty(opts)` resolves to a `PtyHandle` whose `port` is a raw DOM
`MessagePort` carrying `PtyPortMessage`s:

```ts
/**
 * Messages on the per-terminal MessagePort. Raw output/input bytes travel as
 * ArrayBuffers ("data"); control frames are structured-cloned JSON.
 * main → renderer: data, exit. renderer → main: data, resize, close.
 *
 * BINDING: never pass a transfer list — Electron's IPC-bridged MessagePorts
 * transfer only other MessagePorts; an ArrayBuffer in the transfer list throws
 * DataCloneError at postMessage time (pure DOM ports in the mock accept it,
 * which is exactly how the divergence hides). Bytes are cloned; terminal-rate
 * traffic is far below where that matters.
 */
export type PtyPortMessage =
  | { type: "data"; data: ArrayBuffer }
  | { type: "resize"; cols: number; rows: number }
  | { type: "exit"; exitCode: number | null; reason?: string }
  | { type: "close" };

export type PtyHandle = {
  ptyId: string;
  port: MessagePort;
};
```

Direction summary:

| message  | direction        | meaning |
|----------|------------------|---------|
| `data`   | both             | raw terminal bytes as `ArrayBuffer` (renderer→main: keystrokes; main→renderer: output) |
| `resize` | renderer → main  | terminal grid resized |
| `close`  | renderer → main  | detach/kill: main closes the PTY WS with `1000, "client close"` |
| `exit`   | main → renderer  | shell exited (`exitCode` number) or the WS closed (`exitCode: null`, `reason` = WS close reason or `"close <code>"`); main closes the port after |

Rules for the renderer side:

- **`postMessage(msg)` only — NEVER `postMessage(msg, [msg.data])`.** The
  DataCloneError warning above is the single most common way a mock-tested
  terminal breaks in the real app.
- Call `port.start()` if you attach via `addEventListener` (not needed with
  `onmessage =`).
- Main queues renderer→daemon traffic sent before the PTY WS opens, so the
  renderer may send `resize`/`data` immediately on mount.
- After `exit` the port is dead; render the exit state and stop writing.

### Port delivery (preload path)

The preload cannot return a MessagePort through `invoke` (contextBridge
serializes). Instead: `invoke("openPty", [opts])` resolves `{ ptyId }`, and
the port arrives separately via `window.postMessage` transfer with data
`{ type: "agena:pty-port", ptyId }` and the port in `event.ports[0]`. The
port can arrive BEFORE the invoke resolves — the adapter in
`renderer/lib/bridge.ts` stashes early ports in a map keyed by ptyId, or
waits up to **10 s** and rejects with `Error("pty port transfer timed out")`.
This adapter is already written; do not reimplement it, just call
`bridge.openPty()`.

---

## 3. PersistedState & cursor semantics

```ts
/** Desktop-local state (FN-9 scope: losing this loses nothing but comfort). */
export type PersistedState = {
  /** sessionId → replay cursor; interoperable with the CLI's cursors.json shape. */
  cursors: Record<string, { branchId: string; seq: number }>;
  /** sessionId → composer draft. */
  drafts: Record<string, string>;
  /** Dockview serialized layout, opaque to main. */
  layout: unknown;
  prefs: {
    theme: "dark" | "light" | "system";
  };
  lastActiveSessionId: string | null;
  activeProfile: string | null;
};

export const EMPTY_PERSISTED: PersistedState = {
  cursors: {},
  drafts: {},
  layout: null,
  prefs: { theme: "dark" },
  lastActiveSessionId: null,
  activeProfile: null,
};
```

- `loadPersisted()` returns the full state (missing file → `EMPTY_PERSISTED`;
  loaded JSON is spread over the defaults, so missing keys get defaults).
- `savePersisted(patch)` is a **shallow top-level merge**
  (`{ ...base, ...patch }`). Passing `{ cursors: {...} }` replaces the ENTIRE
  cursors record — the renderer must send the complete map, not one entry.
  Storage: `userData/persisted.json` in the real host.

**Cursor semantics** (must be exact):

- `seq` is the last event sequence number the renderer has DURABLY applied for
  that session. `subscribe(sessionId, fromSeq)` replays **exclusive of
  fromSeq** — the daemon sends events with `seq > fromSeq`. So subscribe with
  the stored `cursors[sessionId].seq` directly (or `0` for a fresh session).
- Advance the cursor as events apply; persist lazily (debounced). Losing the
  cursor is safe — it only means a fuller replay next launch.
- `branchId` comes from the `SubscribeAck` and rides along in each batch
  `sync` entry; store it beside `seq`.
- On `lostSessions` containing a sessionId, delete its cursor.

---

## 4. Connection state machine & BridgeError

```ts
/** Mirrors @agena/client ConnectionState (re-declared: renderer never imports client). */
export type BridgeConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export type ProfileSummary = {
  name: string;
  url: string;
  isDefault: boolean;
};

export type ConnectedInfo = {
  profile: string;
  url: string;
  daemonVersion: string;
  protocolVersion: number;
  clientId: string;
};

/** Bridge promise rejections carry this shape (AgenaClientError over IPC). */
export type BridgeError = {
  code: string; // protocol ErrorCode | "CONNECTION_FAILED" | "DISCONNECTED" | "TIMEOUT"
  message: string;
  retryable: boolean;
};
```

State transitions (driven by `AgenaClient` in main, surfaced via
`onStatus(cb)`; the `detail` string is human-readable, e.g. `"attempt 3"` or
`"daemon restarting — retrying (attempt 2)"`):

- `connect()` → `"connecting"` (first ever) → `"connected"` on welcome.
- Socket loss after a successful connect → `"reconnecting"` with
  jittered exponential backoff (base 250 ms, or 1000 ms when close code 1001 =
  daemon restarting; cap 10 s). Retries forever until it succeeds or
  `disconnect()` is called.
- On reconnect, the SDK **re-subscribes every tracked session from its cursor
  automatically** and retransmits pending commands — the renderer does NOT
  re-subscribe after a reconnect; it just keeps consuming batches (replayed
  events dedupe by seq, apply is idempotent).
- `disconnect()` or a failure before the first successful connect →
  `"closed"`.
- `PROTOCOL_MISMATCH` on welcome is terminal: no retry, `connect()` rejects.
- Dead-peer detection: 45 s with zero traffic (3× ping interval) force-closes
  the socket, which enters the reconnect path.
- A seq gap in the event stream heals via a full reconnect (SDK closes the
  socket with `"seq gap"` and resubscribes from cursors) — invisible to the
  renderer beyond a `reconnecting` blip.

Error semantics every renderer call site must handle:

- **Every** bridge method rejects with a `BridgeError`-shaped error
  (`code`, `message`, `retryable` as own properties on an `Error`). The
  preload transport returns `{ ok: false, error }` envelopes and the adapter
  rethrows via `Object.assign(new Error(msg), error)` — codes cross IPC as
  data because contextBridge strips custom props from thrown Errors.
- Client-local codes: `"DISCONNECTED"` (command sent while not connected,
  retryable), `"TIMEOUT"` (no ack within 30 s, retryable),
  `"CONNECTION_FAILED"` (retryable). Everything else is a wire ErrorCode
  from the daemon (e.g. `SESSION_NOT_FOUND`, `UNAUTHORIZED`,
  `PROTOCOL_MISMATCH`, `INVALID_PAYLOAD`, `ALREADY_SUBSCRIBED`, `INTERNAL`).
- `retryable: true` → safe to retry the same call after reconnect.

Connect lifecycle quirk (real host): every renderer (re)load calls
`connect()`. Main tears down any existing client and builds a fresh one,
because subscriptions/replay are renderer state and the daemon rejects
duplicate subscribes per WS connection (`ALREADY_SUBSCRIBED`). So the renderer
boot sequence is always: `connect()` → `loadPersisted()` → `subscribe()` each
session of interest from its cursor.

---

## 5. AgenaBridge — every method

The single API exposed to the renderer (as `window.agena` in the mock, or via
the preload adapter). Copied verbatim from `shared/bridge.ts`:

```ts
export type ReadEventsPage = {
  events: AgenaEvent[];
  nextFromSeq: number | null;
};

/**
 * The single API preload exposes as `window.agena`. Method names and semantics
 * mirror @agena/client so renderer code reads like SDK code; all methods reject
 * with a BridgeError shape.
 */
export type AgenaBridge = {
  // lifecycle
  listProfiles(): Promise<ProfileSummary[]>;
  connect(profileName?: string): Promise<ConnectedInfo>;
  disconnect(): Promise<void>;

  // WS commands (requestId correlation + retry live below the bridge, in the SDK)
  subscribe(sessionId: string, fromSeq: number): Promise<SubscribeAck>;
  prompt(sessionId: string, text: string): Promise<PromptAck>;
  steer(sessionId: string, text: string): Promise<PromptAck>;
  followUp(sessionId: string, text: string): Promise<PromptAck>;
  abort(sessionId: string, reason?: string): Promise<EmptyAck>;
  respondToApproval(
    sessionId: string,
    approvalId: string,
    response: ApprovalResponse,
  ): Promise<RespondToApprovalAck>;
  runtimeInfo(sessionId: string): Promise<RuntimeInfoAck>;
  setModel(sessionId: string, model: ModelRef): Promise<SetModelAck>;
  setThinkingLevel(
    sessionId: string,
    thinkingLevel: ThinkingLevel,
  ): Promise<SetThinkingLevelAck>;
  compact(sessionId: string): Promise<CompactAck>;

  // HTTP
  createSession(input?: Partial<CreateSessionRequest>): Promise<string>;
  createProject(name: string): Promise<OpenedProject>;
  /** Full teardown: db rows, workspace files, pi sessions, snapshots. */
  deleteProject(
    projectId: string,
  ): Promise<{ projectId: string; deletedSessions: number }>;
  listSessionSummaries(filters?: ListSessionsQuery): Promise<SessionSummary[]>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  readEvents(
    sessionId: string,
    opts?: { fromSeq?: number; limit?: number },
  ): Promise<ReadEventsPage>;
  search(
    query: string,
    opts?: { sessionId?: string; allProjects?: boolean; limit?: number },
  ): Promise<SearchHit[]>;
  listApprovals(): Promise<PendingApprovalSummary[]>;
  listFiles(opts?: { path?: string }): Promise<FileEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  listSnapshots(): Promise<SnapshotSummary[]>;
  createSnapshot(input?: {
    name?: string;
    sessionId?: string;
  }): Promise<SnapshotSummary>;
  restoreSnapshot(
    snapshotId: string,
    input?: { sessionId?: string },
  ): Promise<{ snapshotId: string; safetySnapshotId: string }>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  diagnostics(): Promise<DiagnosticsResponse>;
  listPtys(): Promise<PtySummary[]>;

  // local-session import (Electron main scans/converts; daemon stores the ledger)
  /** refresh forces a differential re-scan; otherwise the cached index may serve. */
  importScan(opts?: {
    refresh?: boolean;
  }): Promise<{ projects: ProjectGroup[]; scannedAt: string }>;
  /** Per-session failures land in the result, never reject the batch. */
  importRun(plan: ImportPlan): Promise<ImportRunResult>;
  /** The daemon import ledger for this machine (GET /v1/imports). */
  importStatus(): Promise<{ imports: ImportLedgerEntry[] }>;

  // local MCP import (host discovery stays in Electron main; no secrets cross IPC)
  mcpImportScan(opts?: {
    refresh?: boolean;
  }): Promise<{ mcps: DiscoveredMcp[]; scannedAt: string }>;
  mcpImportRun(plan: { ids: string[] }): Promise<McpImportRunResult>;
  mcpImportStatus(): Promise<{ mcps: ImportedMcp[] }>;
  mcpAuthStart(mcpId: string): Promise<void>;
  skillImportScan(opts?: {
    refresh?: boolean;
  }): Promise<{ skills: DiscoveredSkill[]; scannedAt: string }>;
  skillImportRun(plan: { ids: string[] }): Promise<SkillImportRunResult>;
  skillImportStatus(opts?: {
    refresh?: boolean;
  }): Promise<{ skills: ImportedSkill[] }>;
  skillUpdate(skillId: string): Promise<void>;

  // streams
  onBatch(cb: (batch: UiBatch) => void): () => void;
  onStatus(
    cb: (state: BridgeConnectionState, detail?: string) => void,
  ): () => void;

  // terminals
  openPty(opts: Partial<CreatePtyRequest>): Promise<PtyHandle>;

  // persistence
  loadPersisted(): Promise<PersistedState>;
  savePersisted(patch: Partial<PersistedState>): Promise<void>;

  /**
   * The ⌘O open-project flow, end to end: native folder picker (Finder) THEN
   * copy of the folder's contents INTO the workspace over the protocol (the
   * `agena files put` / tar-upload path — real impl streams to
   * `POST /v1/files/upload?format=tar`). Resolves null on cancel. The renderer
   * never sees the host path: `projectRoot`/`cwd` are workspace-relative
   * (final_plan §1.6 — host paths are hints only), which is what makes the
   * same flow work against a remote/cloud workspace. projectId minting moves
   * daemon-side with M4; the client-side slug is mock-era scaffolding.
   */
  openProjectFolder(): Promise<OpenedProject | null>;

  // ---- embedded browser (docs/desktop_plan.md §7 browser pane) -------------
  // A native WebContentsView, owned by main, composited over the renderer in
  // the browser panel's rect. Workspace `localhost:<port>` URLs are transparently
  // tunneled to the daemon container (a real host-loopback listener), so no
  // preview URLs are needed. The renderer only owns the toolbar + bounds; the
  // page itself is out of the renderer's reach (sandboxed, its own partition).
  /** Open (or navigate) the pane to a URL. Returns the resolved/tunneled URL. */
  browserOpen(url: string, opts?: BrowserOpenOptions): Promise<string>;
  browserNavigate(action: BrowserNavAction): Promise<void>;
  /** Renderer streams the panel's viewport rect; main calls setBounds. */
  browserSetBounds(bounds: BrowserBounds): Promise<void>;
  /**
   * BINDING (D-INV-3): a WebContentsView paints ABOVE all renderer DOM —
   * palette, dropdowns, toasts, and above all the approval modal would render
   * underneath it. The renderer MUST hide the view whenever any overlay is up.
   */
  browserSetVisible(visible: boolean): Promise<void>;
  browserOpenDevTools(): Promise<void>;
  /** Open the current page in the user's system browser. */
  browserOpenExternal(): Promise<void>;
  browserClose(): Promise<void>;
  onBrowserState(cb: (state: BrowserState) => void): () => void;
};
```

Method notes beyond the signatures:

- `listProfiles()`: real host returns exactly
  `[{ name: "local", url, isDefault: true }]` in v1.
- `subscribe`: replay is exclusive of `fromSeq` (see §3). Main records the
  ack's `branchId` for later `sync` entries. `SESSION_NOT_FOUND` rejects the
  call AND surfaces the session in a batch's `lostSessions`.
- `prompt`/`steer`/`followUp` take plain text; the host wraps it as
  `content: [{ type: "text", text }]` on the wire.
- `compact(sessionId)`: the bridge does not expose the SDK's optional
  `instructions` arg.
- `createSession` resolves to the new **sessionId string**, not an object.
- `listSessionSummaries` returns newest-first (sorted by sessionId ULID desc).
- `createProject(name)` resolves an `OpenedProject` with `fileCount: 0`.
- `updateSessionStatus`, `deleteSnapshot`, `skillUpdate`, `mcpAuthStart`,
  `savePersisted`, all `browser*` except `browserOpen` resolve `void`.
- `readFile` resolves `Uint8Array` (structured clone carries it fine).
- `mcpAuthStart(mcpId)` resolves as soon as the system browser has been
  opened for OAuth — completion is fire-and-forget in main; poll
  `mcpImportStatus()` to observe the status change. Only one MCP
  authorization can be in progress at a time (second call rejects).
- `skillImportStatus({ refresh: true })` asks the daemon to check for
  updates (POST /v1/skills/check-updates); without refresh it just lists.
- `importRun`/`mcpImportRun`/`skillImportRun`: per-item failures land in the
  result arrays, the promise itself only rejects on transport-level failure.
- All `onBatch`/`onStatus`/`onBrowserState` subscriptions return an
  unsubscribe function.

### Browser pane types (verbatim)

```ts
export type BrowserOpenOptions = {
  /** Provenance for routing/telemetry; does not change behavior in v1. */
  source?: "user" | "agent" | "terminal";
};

export type BrowserNavAction =
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" }
  | { kind: "stop" }
  | { kind: "url"; url: string };

export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserState = {
  /** Absent until a page loads; null when the pane is closed/empty. */
  url: string | null;
  title: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};
```

Browser pane rules: the renderer owns only the toolbar and the pane's rect
(stream it via `browserSetBounds` on layout changes / resizes). D-INV-3 is
binding — call `browserSetVisible(false)` whenever ANY renderer overlay
(command palette, dropdown, toast, approval modal) is up, and restore after.
`browserOpen` returns the resolved URL: workspace `localhost:<port>` URLs are
rewritten to a tunneled local URL, so display what came back, not what you
sent.

### Project / shell / import types (verbatim)

```ts
export type OpenedProject = {
  name: string;
  projectId: string;
  /** Workspace-relative, e.g. "/workspace/checkout-service". */
  projectRoot: string;
  cwd: string;
  fileCount: number;
};

/** One file captured from a host folder (dev-shell → mock ingestion). */
export type HostFolderFile = {
  /** Path relative to the picked folder. */
  path: string;
  size: number;
  /** UTF-8 content for small text files; null for binary/oversized. */
  text: string | null;
};

/** Minimal native-capability surface the Electron dev shell exposes. */
export type AgenaShell = {
  pickFolder(): Promise<string | null>;
  readFolder(
    path: string,
  ): Promise<{ name: string; files: HostFolderFile[] } | null>;
};
```

`window.agenaShell` (pickFolder/readFolder) is a separate, minimal dev-shell
surface used by the mock ingestion path — production renderer flows use
`openProjectFolder()` on the bridge instead and never see host paths.

```ts
export type ImportPlan = {
  projects: Array<{
    cwd: string;
    name: string;
    /** Only honored for new projects whose cwd still exists (plan §8 step 2). */
    copyFiles: boolean;
    /** Empty = project files only. */
    harnesses: Harness[];
  }>;
};

export type ImportRunResult = {
  sessions: Array<{
    sourcePath: string;
    status: "ok" | "skipped" | "error";
    sessionId?: string;
    error?: string;
  }>;
};

export type McpAuthKind = "none" | "oauth" | "api_key" | "unknown";
export type McpAuthStatus = "ready" | "needs_authorization" | "missing_secret";

/** Source-neutral, secret-free view of one locally discovered MCP server. */
export type DiscoveredMcp = {
  id: string;
  identity: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  target: string;
  authKind: McpAuthKind;
  authStatus: McpAuthStatus;
};

export type ImportedMcp = {
  id: string;
  identity: string;
  name: string;
  status: "imported" | "ready" | "needs_authorization" | "error";
  error?: string;
};

export type McpImportRunResult = {
  mcps: Array<{
    id: string;
    status: "imported" | "needs_authorization" | "error";
    mcpId?: string;
    error?: string;
  }>;
};

export type DiscoveredSkill = {
  id: string;
  identity: string;
  contentHash: string;
  name: string;
  description?: string;
  fileCount: number;
};

export type ImportedSkill = {
  id: string;
  identity: string;
  contentHash: string;
  name: string;
  status: "ready" | "update_available" | "error";
  error?: string;
};

export type SkillImportRunResult = {
  skills: Array<{
    id: string;
    status: "imported" | "error";
    skillId?: string;
    error?: string;
  }>;
};
```

`ProjectGroup` (the `importScan` result item) is re-exported from
`@agena/importer` as a **type-only** import (erases at build time — the
renderer bundle must not pull importer code). Other protocol types
(`AgenaEvent`, `AgenaFrame`, `SubscribeAck`, `PromptAck`, `SessionSummary`,
`InFlightSnapshot`, `CreatePtyRequest`, etc.) come from `@agena/protocol`.

---

## 6. The preload transport & adapter selection

The preload exposes a deliberately thin transport, NOT the full bridge:

```ts
/**
 * The REAL bridge transport the preload exposes. Deliberately thin: one
 * invoke channel returning {ok,value}|{ok,error} envelopes (contextBridge
 * strips custom props from thrown Errors — codes must cross as data) plus the
 * two push streams. lib/bridge.ts adapts this into a full AgenaBridge; PTY
 * MessagePorts arrive separately via window.postMessage transfer, keyed by
 * ptyId.
 */
export type AgenaPreload = {
  invoke(
    method: string,
    args: unknown[],
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: BridgeError }>;
  onBatch(cb: (batch: UiBatch) => void): () => void;
  onStatus(
    cb: (state: BridgeConnectionState, detail?: string) => void,
  ): () => void;
  onBrowserState(cb: (state: BrowserState) => void): () => void;
};

declare global {
  interface Window {
    agena?: AgenaBridge;
    agenaShell?: AgenaShell;
    agenaPreload?: AgenaPreload;
  }
}
```

`invoke(method, args)` maps 1:1 to bridge method names — main dispatches on
the method string (unknown names reject with code `INVALID_PAYLOAD`).

### renderer/lib/bridge.ts (already copied into desktopNew — use as-is)

Selection logic, in priority order, cached in a module-level `cached` var:

1. `window.agenaPreload` present (running under Electron) → adapt it into a
   full `AgenaBridge` via a `Proxy`: `onBatch`/`onStatus`/`onBrowserState`
   pass through; `openPty` uses the stash-or-wait port handshake (§2); every
   other property becomes `(...args) => invoke(name, args)` that unwraps the
   envelope and rethrows `{ok:false}` errors as `BridgeError`-shaped Errors.
   The proxy returns `undefined` for `then`/`catch`/`finally`/`toJSON` so
   `await bridge` doesn't treat it as a thenable.
2. `window.agena` present → use it directly (a mock or test installed a full
   bridge).
3. Neither → `peekBridge()` returns `null`; `getBridge()` throws
   `"no bridge installed..."`; `ensureBridge()` dynamically imports
   `../mock/install.ts` and calls `installMockBridge()` (bare-browser
   `pnpm dev` path), then returns the bridge.

API: `peekBridge(): AgenaBridge | null` (null-safe, Node-safe for pure
reducers), `getBridge(): AgenaBridge` (throws if none), `ensureBridge():
Promise<AgenaBridge>` (installs mock as last resort). App entry should call
`ensureBridge()` once at boot; everything else uses `getBridge()`.

---

## 7. AgenaClient behavior reference (main-process; context for the renderer)

The renderer never touches `AgenaClient`, but its semantics leak through the
bridge, so know them:

- **Error class**: everything rejects with
  `class AgenaClientError extends Error { readonly code: string; readonly retryable: boolean }`
  — this is what crosses IPC as `BridgeError`.
- **Commands**: WS `cmd` envelopes with client-minted ULID `requestId`;
  resolve on `ack`, reject on `error` or a 30 s `TIMEOUT`
  (`COMMAND_ACK_TIMEOUT_MS`). Sent while disconnected → immediate
  `DISCONNECTED` rejection. Pending commands are retransmitted after a
  reconnect's welcome.
- **Subscribe/replay**: the client tracks `{cursor, live}` per session.
  Replay is exclusive of `fromSeq`. Events with `seq <= cursor` are dropped
  (dedupe); a gap (`seq > cursor + 1`) force-closes the socket to heal via
  full reconnect; otherwise cursor advances and the event is delivered.
- **Frames**: dropped until the session's `sync` arrives (`live` flips true),
  and dropped when `afterSeq < cursor` (stale — events are authoritative).
  So the renderer only ever sees post-sync, non-stale frames.
- **Syncs**: `sync` marks the session live and reports `upToSeq`.
- **Reconnect**: automatic after any successful connect. Backoff:
  `base + random() * min(10_000, base * 2^(attempt-1))`, base 250 ms
  (1000 ms for close code 1001). On welcome: re-subscribe every tracked
  session from its cursor, retransmit pending commands.
- **Keepalive**: replies `pong` to daemon `ping`; 45 s of total silence
  closes the socket (→ reconnect path).
- **Session loss**: subscribe rejecting `SESSION_NOT_FOUND` prunes the
  client-side cursor and fires `onSessionLost` → batch `lostSessions`.
- **Auth/identity**: `Bearer` token on WS and HTTP; stable per-installation
  `clientId` ULID (desktop stores its own in `userData/client-id`, distinct
  from the CLI's `~/.config/agena/client-id`). Local profile config
  (`~/.config/agena/config.json` + `credentials.json`,
  `DEFAULT_AGENA_URL = "http://127.0.0.1:7777"`, env overrides `AGENA_URL` /
  `AGENA_TOKEN`) is resolved in main via `resolveLocalClientConfig` — the
  renderer only ever sees `ProfileSummary`/`ConnectedInfo`.

---

## 8. Checklist of easy-to-get-wrong facts

1. Batch apply order: events → snapshots → frames. Deltas coalesce by
   CONCATENATION (reset replaces); keep-latest loses text.
2. `subscribe(sessionId, fromSeq)` replays EXCLUSIVE of fromSeq — pass the
   last applied seq, not last+1.
3. Never put an ArrayBuffer in a MessagePort transfer list — DataCloneError
   in real Electron, silently fine in the mock.
4. `savePersisted` is a shallow top-level merge — send whole `cursors`/`drafts`
   records.
5. The renderer never re-subscribes on reconnect; the SDK does it. But a
   fresh `connect()` call (renderer reload) resets everything — subscribe
   again after connect.
6. Hide the browser pane (`browserSetVisible(false)`) whenever any overlay
   renders — the WebContentsView paints above ALL renderer DOM.
7. All bridge rejections are `BridgeError`-shaped; check `err.code`, never
   `instanceof`.
8. `createSession` resolves a string sessionId; `openProjectFolder` resolves
   `null` on picker cancel; `projectRoot`/`cwd` are workspace-relative, never
   host paths.
