# Renderer Feature Contract (parity spec for the desktopNew rewrite)

Source of truth: `apps/desktop/src/renderer/` as of 2026-07-11. Builders implement from THIS
document only. Type shapes are copied verbatim from the original sources. Anything marked
**IMPROVE-ON** is a known rough edge you may fix in the rewrite; everything else is binding.

External deps in use: `zustand`, `dockview` (v7, no React adapter), `@tanstack/react-virtual`,
`cmdk`, `react-markdown` + `remark-gfm`, `@xterm/xterm` (+ fit, search, webgl addons),
`radix-ui` (menus/modals/tooltips/context-menu), `lucide-react`.

---

## 0. Architecture overview

```
window.agenaPreload (Electron)  ──adaptPreload──▶  AgenaBridge   ◀── mock bridge (bare browser dev)
                                                     │
     bridge.onBatch(ingestBatch)  ← THE single wire entry
     bridge.onStatus(...)         → useConnection
     bridge.onBrowserState(...)   → useBrowser
                                                     │
   zustand stores: useTranscripts, useSessions, useApprovals, useConnection, useUi,
                   useCommands, useTerminals, useBrowser, useComposerDrafts, useTimelineFilter
                                                     │
   React features (pure readers; every mutation goes through store actions / pure reducers)
```

Rules carried over from the plan (D-INV numbers appear in comments):

- **D-INV-3**: the approval modal renders ONLY the canonical `approval.requested` payload;
  the native browser WebContentsView paints above ALL renderer DOM and must be hidden whenever
  any overlay is up.
- **D-INV-5**: transcript state is produced ONLY by pure reducers; components read, never mutate.
- **D-INV-6**: unknown event/frame types never crash — they become neutral marker blocks.
- Durable **events finalize** state; **frames touch in-flight state only**; malformed known
  payloads become `malformed` marker blocks.

### Boot sequence (`main.tsx`)

1. `ensureBridge()` — use `window.agenaPreload` (adapted), else `window.agena`, else install mock.
2. `loadPersisted()` (fallback `EMPTY_PERSISTED`); apply theme to
   `document.documentElement.dataset.theme` ("system" resolves via `prefers-color-scheme`);
   seed `useUi.theme`.
3. Wire streams BEFORE connecting: `bridge.onBatch(ingestBatch)`,
   `bridge.onStatus(→ useConnection.setStatus)`.
4. Render `<StrictMode><App persisted={persisted} /></StrictMode>`.
5. `connectAndBootstrap(persisted)` after first paint — a failed connect leaves a usable shell.

### `connectAndBootstrap` (`lib/connect.ts`) — also the Retry-banner handler

1. `bridge.connect(persisted.activeProfile ?? undefined)` → `useConnection.setInfo(info)`.
   On failure: `setStatus("closed", errMsg)`, error toast (mentions Retry if `retryable`), return.
2. In parallel (both `.catch(() => {})`):
   - `listApprovals()` → `useApprovals.seedFromHttp(a)`.
   - `listSessionSummaries({ allProjects: true, includeArchived: true })` → `setAll`; then, if no
     session is already active, activate `persisted.lastActiveSessionId` if it exists in `byId`,
     else `order[0]`; `ensureSubscribed(next)` with toast on failure.

---

## 1. The bridge contract (shared/bridge.ts)

The renderer depends on this type + `@agena/protocol` ONLY. Bridge promise rejections carry:

```ts
export type BridgeError = {
  code: string; // protocol ErrorCode | "CONNECTION_FAILED" | "DISCONNECTED" | "TIMEOUT"
  message: string;
  retryable: boolean;
};

export type BridgeConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

export type ConnectedInfo = {
  profile: string;
  url: string;
  daemonVersion: string;
  protocolVersion: number;
  clientId: string;
};
```

### UiBatch — the ordered delivery unit (rules are BINDING)

```ts
/**
 * One ordered delivery unit, flushed to the renderer at most once per animation frame.
 *   1. Within a batch the renderer applies: events (in array order) → snapshots → frames.
 *      Frames only touch in-flight state, so this order is always safe.
 *   2. Durable events are NEVER dropped or reordered; seq order per session is preserved
 *      across batches.
 *   3. Frames coalesce per target while a batch is unflushed:
 *      `message.assistant.text.delta` merges by CONCATENATING `delta` for the same
 *      (sessionId, messageId, blockIndex); `tool.call.output.delta` merges by concatenation
 *      for the same (sessionId, toolCallId) unless `reset` is true, which discards the
 *      accumulation and starts over. Never keep-latest for deltas — that loses text.
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

### PersistedState (desktop-local; losing it loses nothing but comfort)

```ts
export type PersistedState = {
  /** sessionId → replay cursor; interoperable with the CLI's cursors.json shape. */
  cursors: Record<string, { branchId: string; seq: number }>;
  /** sessionId → composer draft. */
  drafts: Record<string, string>;
  /** Dockview serialized layout, opaque to main. */
  layout: unknown;
  prefs: { theme: "dark" | "light" | "system" };
  lastActiveSessionId: string | null;
  activeProfile: string | null;
};
```

### PTY port protocol

```ts
/**
 * main → renderer: data, exit. renderer → main: data, resize, close.
 * BINDING: never pass a transfer list — Electron's IPC-bridged MessagePorts transfer only
 * other MessagePorts; an ArrayBuffer in the transfer list throws DataCloneError. Bytes are
 * cloned; terminal-rate traffic is far below where that matters.
 */
export type PtyPortMessage =
  | { type: "data"; data: ArrayBuffer }
  | { type: "resize"; cols: number; rows: number }
  | { type: "exit"; exitCode: number | null; reason?: string }
  | { type: "close" };

export type PtyHandle = { ptyId: string; port: MessagePort };
```

### The full AgenaBridge surface (method names mirror @agena/client)

```ts
export type AgenaBridge = {
  // lifecycle
  listProfiles(): Promise<ProfileSummary[]>;
  connect(profileName?: string): Promise<ConnectedInfo>;
  disconnect(): Promise<void>;
  // WS commands
  subscribe(sessionId: string, fromSeq: number): Promise<SubscribeAck>;
  prompt(sessionId: string, text: string): Promise<PromptAck>;
  steer(sessionId: string, text: string): Promise<PromptAck>;
  followUp(sessionId: string, text: string): Promise<PromptAck>;
  abort(sessionId: string, reason?: string): Promise<EmptyAck>;
  respondToApproval(sessionId: string, approvalId: string, response: ApprovalResponse): Promise<RespondToApprovalAck>;
  runtimeInfo(sessionId: string): Promise<RuntimeInfoAck>;
  setModel(sessionId: string, model: ModelRef): Promise<SetModelAck>;
  setThinkingLevel(sessionId: string, thinkingLevel: ThinkingLevel): Promise<SetThinkingLevelAck>;
  compact(sessionId: string): Promise<CompactAck>;
  // HTTP
  createSession(input?: Partial<CreateSessionRequest>): Promise<string>;
  createProject(name: string): Promise<OpenedProject>;
  deleteProject(projectId: string): Promise<{ projectId: string; deletedSessions: number }>;
  listSessionSummaries(filters?: ListSessionsQuery): Promise<SessionSummary[]>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  readEvents(sessionId: string, opts?: { fromSeq?: number; limit?: number }): Promise<ReadEventsPage>;
  search(query: string, opts?: { sessionId?: string; allProjects?: boolean; limit?: number }): Promise<SearchHit[]>;
  listApprovals(): Promise<PendingApprovalSummary[]>;
  listFiles(opts?: { path?: string }): Promise<FileEntry[]>;
  readFile(path: string): Promise<Uint8Array>;
  listSnapshots(): Promise<SnapshotSummary[]>;
  createSnapshot(input?: { name?: string; sessionId?: string }): Promise<SnapshotSummary>;
  restoreSnapshot(snapshotId: string, input?: { sessionId?: string }): Promise<{ snapshotId: string; safetySnapshotId: string }>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  diagnostics(): Promise<DiagnosticsResponse>;
  listPtys(): Promise<PtySummary[]>;
  // local imports (sessions / MCPs / skills — Electron main scans, daemon stores the ledger)
  importScan(opts?: { refresh?: boolean }): Promise<{ projects: ProjectGroup[]; scannedAt: string }>;
  importRun(plan: ImportPlan): Promise<ImportRunResult>;
  importStatus(): Promise<{ imports: ImportLedgerEntry[] }>;
  mcpImportScan(opts?: { refresh?: boolean }): Promise<{ mcps: DiscoveredMcp[]; scannedAt: string }>;
  mcpImportRun(plan: { ids: string[] }): Promise<McpImportRunResult>;
  mcpImportStatus(): Promise<{ mcps: ImportedMcp[] }>;
  mcpAuthStart(mcpId: string): Promise<void>;
  skillImportScan(opts?: { refresh?: boolean }): Promise<{ skills: DiscoveredSkill[]; scannedAt: string }>;
  skillImportRun(plan: { ids: string[] }): Promise<SkillImportRunResult>;
  skillImportStatus(opts?: { refresh?: boolean }): Promise<{ skills: ImportedSkill[] }>;
  skillUpdate(skillId: string): Promise<void>;
  // streams
  onBatch(cb: (batch: UiBatch) => void): () => void;
  onStatus(cb: (state: BridgeConnectionState, detail?: string) => void): () => void;
  // terminals
  openPty(opts: Partial<CreatePtyRequest>): Promise<PtyHandle>;
  // persistence
  loadPersisted(): Promise<PersistedState>;
  savePersisted(patch: Partial<PersistedState>): Promise<void>;
  // ⌘O flow: native picker THEN copy-into-workspace; null on cancel; paths workspace-relative
  openProjectFolder(): Promise<OpenedProject | null>;
  // embedded browser (native WebContentsView owned by main)
  browserOpen(url: string, opts?: BrowserOpenOptions): Promise<string>;
  browserNavigate(action: BrowserNavAction): Promise<void>;
  browserSetBounds(bounds: BrowserBounds): Promise<void>;
  browserSetVisible(visible: boolean): Promise<void>;   // D-INV-3
  browserOpenDevTools(): Promise<void>;
  browserOpenExternal(): Promise<void>;
  browserClose(): Promise<void>;
  onBrowserState(cb: (state: BrowserState) => void): () => void;
};
```

Supporting browser types:

```ts
export type BrowserOpenOptions = { source?: "user" | "agent" | "terminal" };
export type BrowserNavAction =
  | { kind: "back" } | { kind: "forward" } | { kind: "reload" }
  | { kind: "stop" } | { kind: "url"; url: string };
export type BrowserBounds = { x: number; y: number; width: number; height: number };
export type BrowserState = {
  url: string | null;      // null when the pane is closed/empty
  title: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};
export type OpenedProject = {
  name: string; projectId: string;
  projectRoot: string;     // workspace-relative, e.g. "/workspace/checkout-service"
  cwd: string; fileCount: number;
};
export type ReadEventsPage = { events: AgenaEvent[]; nextFromSeq: number | null };
```

Import types (settings modal):

```ts
export type ImportPlan = {
  projects: Array<{
    cwd: string; name: string;
    copyFiles: boolean;      // only honored for new projects whose cwd still exists
    harnesses: Harness[];    // empty = project files only
  }>;
};
export type ImportRunResult = {
  sessions: Array<{ sourcePath: string; status: "ok" | "skipped" | "error"; sessionId?: string; error?: string }>;
};
export type McpAuthKind = "none" | "oauth" | "api_key" | "unknown";
export type McpAuthStatus = "ready" | "needs_authorization" | "missing_secret";
export type DiscoveredMcp = {
  id: string; identity: string; name: string;
  transport: "stdio" | "http" | "sse"; target: string;
  authKind: McpAuthKind; authStatus: McpAuthStatus;
};
export type ImportedMcp = {
  id: string; identity: string; name: string;
  status: "imported" | "ready" | "needs_authorization" | "error"; error?: string;
};
export type McpImportRunResult = {
  mcps: Array<{ id: string; status: "imported" | "needs_authorization" | "error"; mcpId?: string; error?: string }>;
};
export type DiscoveredSkill = {
  id: string; identity: string; contentHash: string; name: string;
  description?: string; fileCount: number;
};
export type ImportedSkill = {
  id: string; identity: string; contentHash: string; name: string;
  status: "ready" | "update_available" | "error"; error?: string;
};
export type SkillImportRunResult = {
  skills: Array<{ id: string; status: "imported" | "error"; skillId?: string; error?: string }>;
};
```

### Renderer-side bridge access (`lib/bridge.ts`)

- `peekBridge(): AgenaBridge | null` — null-safe (tests / pre-install); caches.
- `getBridge(): AgenaBridge` — throws if none installed.
- `ensureBridge()` — installs the mock (`mock/install.ts`) when neither `window.agenaPreload`
  nor `window.agena` exists (bare-browser `pnpm dev`).
- `adaptPreload` wraps the thin `invoke(method, args) → {ok,value}|{ok,error}` transport in a
  Proxy; rejections rethrow as `Object.assign(new Error(message), error)` so `.code`/`.retryable`
  survive. The proxy must return `undefined` for `then/catch/finally/toJSON` (thenable trap).
- PTY ports arrive via `window.postMessage` (`{type:"agena:pty-port", ptyId}` + port in
  `e.ports[0]`), possibly BEFORE `openPty`'s invoke resolves → stash-or-wait keyed by ptyId,
  10s timeout ("pty port transfer timed out").
- `lib/errors.ts`: `errMsg(err)` → `Error.message` | `.message` string | "Something went wrong".

---

## 2. Store slices (store/*)

All zustand `create()` stores. `store/index.ts` re-exports everything plus
`__resetAllStores()` (test helper resetting all five core stores to their initials).

### 2.1 Transcript block model (`store/types.ts`) — copy verbatim

```ts
export type BlockBase = {
  /** seq of the event that created the block (stable virtualization key). */
  seq: number;
  at: string;
  source: EventSource;
};

export type UserBlock = BlockBase & {
  kind: "user";
  messageId: string;
  content: ContentBlock[];
  queued?: "steer" | "followUp";
};

export type AssistantBlock = BlockBase & {
  kind: "assistant";
  messageId: string;
  content: ContentBlock[];
  model?: ModelRef;
  status: "completed" | "aborted" | "failed";
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
  usage?: UsageTotals;
  abortReason?: "user_abort" | "daemon_shutdown";
  error?: { code: string; message: string };
};

export type ToolBlock = BlockBase & {
  kind: "tool";
  toolCallId: string;
  name: string;
  args: unknown;
  status: "running" | "completed" | "failed" | "aborted" | "denied";
  /** Streamed output accumulated from tool.call.output.delta frames. */
  liveOutput: string;
  result?: ContentBlock[];
  partialOutput?: ContentBlock[];
  error?: { code: string; message: string };
  abortReason?: string;
  deniedReason?: string;
  approvalId?: string;
  durationMs?: number;
};

export type ApprovalBlock = BlockBase & {
  kind: "approval";
  approvalId: string;
  request: ApprovalRequested;
  state: "pending" | "responded" | "expired" | "cancelled";
  response?: ApprovalResponse;
  respondedBy?: string;
  cancelReason?: string;
};

export type RuntimeBlock = BlockBase & {
  kind: "runtime";
  messageId: string;
  runtimeType: "custom" | "bash" | "branch-summary";
  content: ContentBlock[];
  meta?: { command?: string; exitCode?: number | null; customType?: string };
};

export type MarkerKind =
  | "model" | "thinking" | "compaction" | "compaction-failed"
  | "terminal-start" | "terminal-end" | "run-failed"
  | "session" | "snapshot" | "unknown" | "malformed";

export type MarkerBlock = BlockBase & {
  kind: "marker";
  markerKind: MarkerKind;
  text: string;
  detail?: unknown;
};

export type Block = UserBlock | AssistantBlock | ToolBlock | ApprovalBlock | RuntimeBlock | MarkerBlock;

/** The one streaming assistant tail (frames + snapshot only; events finalize it). */
export type InFlightTail = {
  messageId: string;
  model?: ModelRef;
  /** Streaming content by frame blockIndex; type from snapshot when known. */
  blocks: Array<{ type: "text" | "thinking"; text: string }>;
};

/** Raw wire event retained for the inspector/timeline (payload verbatim). */
export type RawEventRow = {
  seq: number;
  type: string;
  at: string;
  source: EventSource;
  payload: unknown;
};

export type TranscriptState = {
  sessionId: string;
  branchId: string | null;
  blocks: readonly Block[];
  /** seq-ascending, same coverage as blocks (inspector/timeline source). */
  rawEvents: readonly RawEventRow[];
  /** toolCallId → index into blocks (kept consistent by the reducer). */
  toolIndex: Readonly<Record<string, number>>;
  /** approvalId → index into blocks. */
  approvalIndex: Readonly<Record<string, number>>;
  inFlight: InFlightTail | null;
  /** Highest applied seq (subscribe cursor). */
  lastSeq: number;
  /** True after the sync envelope: frames are now trustworthy. */
  live: boolean;
  /** In-flight status line from the wire snapshot (e.g. retrying). */
  runtimeStatus: { state: string; detail?: string } | null;
  queue: { steerCount: number; followUpCount: number };
};
```

`emptyTranscript(sessionId)` fills: `branchId:null, blocks:[], rawEvents:[], toolIndex:{},
approvalIndex:{}, inFlight:null, lastSeq:0, live:false, runtimeStatus:null,
queue:{steerCount:0, followUpCount:0}`.

### 2.2 Other slice shapes (verbatim)

```ts
export type SessionsState = {
  byId: Readonly<Record<string, SessionSummary>>;
  /** Newest-first (ULIDs sort by time). */
  order: readonly string[];
  activeSessionId: string | null;
  loading: boolean;
  error: string | null;
};

export type PendingApproval = {
  sessionId: string;
  approvalId: string;
  seq: number;
  requestedAt: string;
  request: ApprovalRequested;
};

export type ApprovalsState = {
  /** approvalId → pending approval, across ALL sessions. */
  pending: Readonly<Record<string, PendingApproval>>;
};

export type ConnectionSlice = {
  state: BridgeConnectionState;
  detail: string | null;
  info: ConnectedInfo | null;
  /** Per-session runtime controls, filled lazily from runtimeInfo(). */
  runtime: Readonly<Record<string, {
    model?: ModelRef;
    thinkingLevel: ThinkingLevel;
    availableModels: ModelRef[];
    availableThinkingLevels: ThinkingLevel[];
  }>>;
};

export type UiSlice = {
  /** Inspector target. */
  selected: { sessionId: string; seq: number } | null;
  /** Transcript scroll-to request; nonce forces re-trigger on same seq. */
  jump: { sessionId: string; seq: number; nonce: number } | null;
  /** Cross-pane "insert into composer" request (e.g. terminal selection). */
  composerInsert: { text: string; nonce: number } | null;
  theme: "dark" | "light" | "system";
  paletteOpen: boolean;
  settingsOpen: boolean;
  inspectorOpen: boolean;
  terminalOpen: boolean;
  browserOpen: boolean;
  /** True while any DOM overlay is up; browser host hides native view when set. */
  overlayCount: number;
};
```

### 2.3 useSessions (`store/sessions.ts`)

Actions on top of `SessionsState` + `lost: readonly string[]`:

- `setAll(summaries)` — rebuilds `byId`, `order` = newest-first (`Object.keys(byId).sort((a,b) =>
  b.localeCompare(a))` — ULIDs, lexicographic desc = time desc), clears loading/error.
- `upsert(summary)` — merges and re-sorts.
- `setActive(sessionId | null)` — also fire-and-forget `savePersisted({ lastActiveSessionId })`.
- `setStatus(sessionId, status)` / `setTitle(sessionId, title)` — no-op if unknown/unchanged.
- `markLost(sessionId)` — appends to `lost` (dedup).
- `bump(sessionId, seq, at)` — ingest-internal; updates `lastSeq`/`updatedAt` only if
  `seq > cur.lastSeq`.
- `setLoading(loading)`, `setError(error)` (setError also flips loading false).

### 2.4 useApprovals (`store/approvals.ts`)

- `seedFromHttp(summaries)` — maps `PendingApprovalSummary` → `PendingApproval`
  (`request: a.payload`); merge is `{ ...seeded, ...s.pending }` — **event-derived entries win**.
- `add(approval)`, `remove(approvalId)` (no-op if absent).

### 2.5 useConnection (`store/connection.ts`)

- Initial: `{ state: "connecting", detail: null, info: null, runtime: {} }`.
- `setStatus(state, detail?)`, `setInfo(info)`,
- `setRuntime(sessionId, info: RuntimeInfoAck)` — spreads
  `{ thinkingLevel, availableModels, availableThinkingLevels, ...(info.model ? {model} : {}) }`.

### 2.6 useUi (`store/ui.ts`)

Actions: `setSelected`, `requestJump(sessionId, seq)` and `requestComposerInsert(text)` (both use
one module-level monotonically-increasing `nonce` so identical requests re-trigger),
`setTheme(theme)` (writes `documentElement.dataset.theme` AND persists `prefs.theme`
fire-and-forget), toggle/set pairs for palette, settings, inspector, terminal, browser,
`enterOverlay()` / `exitOverlay()` (counter, floor 0).

```ts
/** The one signal the browser host hides the native view on (D-INV-3). */
export const hasOverlay = (s: UiSlice): boolean => s.paletteOpen || s.overlayCount > 0;
```

`ui/modal.tsx` calls `enterOverlay` on mount / `exitOverlay` on unmount; `ui/menu.tsx` bumps on
open/close; the palette flips `paletteOpen` directly. **Any new overlay component in the rewrite
MUST participate**, or the native browser view will paint over it.

### 2.7 useCommands (`store/commands.ts`)

```ts
export type CommandDef = {
  id: string;
  title: string;
  group: string;
  /** e.g. "mod+n" (mod = ⌘ on mac, ctrl elsewhere), "mod+shift+f", "escape". */
  chord?: string;
  keywords?: string[];
  enabled?: () => boolean;
  run: () => void | Promise<void>;
};
```

- `register(defs): () => void` — **shadow semantics**: a second registration of the same id
  shadows the first; unregister restores the shadowed def (so e.g. `terminal.toggle` registered
  by both GlobalHotkeys and TerminalDock composes safely).
- `run(id)` — runs only if `enabled?.() ?? true`.
- `allCommands(byId)` — sorted by group then title.
- `chordMatches(chord, e)`: `mod` = metaKey on Mac, ctrlKey elsewhere; **a chord without `mod`
  requires meta AND ctrl to be up**; `shift`/`alt` must match exactly; key compares
  `e.key.toLowerCase()` to the last chord part.
- `chordLabel(chord)`: Mac → `⌘⇧F` (joined with ""), elsewhere `Ctrl+Shift+F`; `escape` → "Esc";
  single chars uppercase; words capitalized.

### 2.8 useTranscripts container (`store/transcript.ts`)

```ts
export type TranscriptsStore = {
  bySession: Readonly<Record<string, TranscriptState>>;
  loadingOlder: Readonly<Record<string, boolean>>;
  /** ingest-internal: apply a reducer to one session's transcript. */
  update: (sessionId: string, fn: (t: TranscriptState) => TranscriptState) => void;
  /** Backward-page older events for a session via the bridge. */
  prependOlder: (sessionId: string) => Promise<void>;
};
```

- `update` seeds `emptyTranscript(sessionId)` when absent; skips the set when the reducer
  returns the same reference AND the session already existed.
- `prependOlder` (PAGE = 200): guard against no-bridge / unknown session / already loading;
  `oldest = rawEvents[0]?.seq ?? lastSeq + 1`; return if `oldest <= 1`;
  `fromSeq = max(0, oldest - 1 - PAGE)`; set `loadingOlder[sessionId]=true`;
  `readEvents(sessionId, { fromSeq, limit: PAGE })`; keep only `e.seq < oldest`; apply
  `prependOlderEvents`; always clear the loading flag (finally).

---

## 3. Ingest pipeline (store/ingest.ts + transcript.ts reducers) — THE heart

### 3.1 Subscription (`ensureSubscribed`)

```ts
export async function ensureSubscribed(sessionId: string, fromSeq?: number): Promise<void>
```

- Module-level `subscribedIds: Set<string>` — first call per session wins (no double-subscribe).
- Adds to the set BEFORE awaiting; removes and rethrows on failure (callers toast).
- When `fromSeq` is undefined: persisted cursors are loaded ONCE per app run
  (`cursorsPromise ??= bridge.loadPersisted().then(p => p.cursors)`); default
  `cursors[sessionId]?.seq ?? 0`. New sessions are subscribed with explicit `fromSeq = 0`.
- Callers: SessionWorkspace effect (re-runs on activeSessionId/connState — heals reconnect
  races), connect bootstrap, sessions-rail activate/create.

### 3.2 `ingestBatch(batch: UiBatch)` — exact order of operations

```
1. for each { event, replayed } of batch.events (array order):
     a. re-read current transcript; if event.seq <= prev.lastSeq → skip (duplicate delivery)
     b. transcripts.update(sessionId, t => applyEvent(t, event, replayed))
     c. routeApprovalEvent(event)
     d. routeSessionEvent(event)
     e. sessions.bump(event.sessionId, event.seq, event.createdAt)
2. for each sync of batch.syncs:
     transcripts.update(sessionId, t => ({ ...markSynced(t, sync.upToSeq),
                                           branchId: t.branchId ?? sync.branchId }))
3. for each snap of batch.snapshots:
     transcripts.update(snap.sessionId, t => applySnapshot(t, snap))
4. for each frame of batch.frames:
     - "session.status.updated" frames are intercepted: if payload.status is one of
       "active" | "idle" | "archived" → sessions.setStatus; continue (never hits transcripts)
     - else transcripts.update(frame.sessionId, t => applyFrame(t, frame))
5. for each sessionId of batch.lostSessions: sessions.markLost(sessionId)
```

`routeApprovalEvent`:
- `approval.requested` → `approvalRequestedSchema.safeParse(payload)`; on success
  `useApprovals.add({ sessionId, approvalId, seq, requestedAt: createdAt, request })`; on parse
  failure do nothing (the transcript reducer already rendered a malformed marker).
- `approval.responded` / `approval.expired` / `approval.cancelled` → if `payload.approvalId` is a
  string, `useApprovals.remove(id)`.

`routeSessionEvent`: only `session.title.changed` → if `payload.title` is a string,
`sessions.setTitle`.

### 3.3 `applyEvent(state, event, _replayed)` — pure

- Drops if `event.seq <= state.lastSeq`.
- Copies blocks/indices into a Draft, runs `reduceEvent`, returns new state with:
  `branchId: state.branchId ?? event.branchId`, updated blocks/indices/inFlight/runtimeStatus,
  `rawEvents: [...state.rawEvents, rawRow(event)]` (**every event**, even unknown/marker-only,
  lands in rawEvents), `lastSeq: event.seq`.

### 3.4 `reduceEvent` — the per-event mapping (exhaustive)

Parse via `knownAgenaEventSchema.safeParse(event)`. On failure:
- type IS in `durableEventSchemas` → push marker `("malformed", "malformed event <type> (seq <seq>)")`
- else → marker `("unknown", "event <type> (seq <seq>)")`

On success, switch on `ev.type`:

| event | effect |
|---|---|
| `message.user.created` | push UserBlock `{messageId, content, queued?}` |
| `message.assistant.started` | `inFlight = { messageId, model, blocks: [] }` (no block) |
| `message.assistant.completed` | push AssistantBlock `{status:"completed", content, model, stopReason, usage?}` — **authoritative content REPLACES the delta buffer**; clear `inFlight` if messageId matches |
| `message.assistant.aborted` | push AssistantBlock `{status:"aborted", content: p.partialContent, abortReason: p.reason, model from matching inFlight if any}`; clear matching inFlight |
| `message.assistant.failed` | push AssistantBlock `{status:"failed", content: p.partialContent, error, model from matching inFlight}`; clear matching inFlight |
| `message.runtime.created` | push RuntimeBlock `{messageId, runtimeType, content, meta?}` (meta keys copied only when defined) |
| `tool.call.started` | `toolIndex[toolCallId] = blocks.length`; push ToolBlock `{status:"running", liveOutput:""}` |
| `tool.call.completed` | patch tool: `{status:"completed", result, durationMs}` |
| `tool.call.failed` | patch tool: `{status:"failed", error, partialOutput?, durationMs?}` |
| `tool.call.aborted` | patch tool: `{status:"aborted", partialOutput, abortReason: p.reason}` |
| `tool.call.denied` | patch tool: `{status:"denied", deniedReason: p.reason, approvalId?}` |
| `approval.requested` | `approvalIndex[approvalId] = blocks.length`; push ApprovalBlock `{request: p, state:"pending"}` |
| `approval.responded` | patch approval: `{state:"responded", response, respondedBy}` |
| `approval.expired` | patch approval: `{state:"expired"}` |
| `approval.cancelled` | patch approval: `{state:"cancelled", cancelReason: p.reason}` |
| `model.changed` | marker `("model", "model → <provider>/<id>")` |
| `thinking.level.changed` | marker `("thinking", "thinking → <to>")` |
| `compaction.created` | marker `("compaction", "compacted history up to seq <replacesUpToSeq>")` |
| `compaction.failed` | marker `("compaction-failed", "compaction failed: <error.code>")` |
| `terminal.session.started` | marker `("terminal-start", "terminal opened (<shell>)")` |
| `terminal.session.ended` | marker `("terminal-end", "terminal closed" + (exitCode !== null ? " (exit <code>)" : ""))` |
| `run.failed` | `runtimeStatus = {state:"idle"}` + marker `("run-failed", "run failed[ at <phase>]: <error.code>")` |
| `run.started` | `runtimeStatus = {state:"generating"}` (no block) |
| `run.completed`, `run.aborted` | `runtimeStatus = {state:"idle"}` (no block) |
| `session.created`, `session.title.changed`, `snapshot.created`, `snapshot.restored`, `snapshot.restore_failed`, `snapshot.deleted` | no block (rawEvents only; timeline/inspector read them) |

`patchTool`/`patchApproval` are silent no-ops when the id is unindexed or the indexed block has
the wrong kind (patch events whose start block wasn't loaded do nothing).

### 3.5 `applyFrame(state, frame)` — pure

- `knownAgenaFrameSchema.safeParse`; **drop if parse fails OR `!state.live`** (frames untrusted
  before the sync envelope).
- `message.assistant.text.delta`: drop unless `inFlight.messageId === p.messageId`
  (mistargeted/stale). Pad `inFlight.blocks` with `{type:"text", text:""}` up to `p.blockIndex`,
  then append `p.delta` to that block's text.
- `tool.call.output.delta`: look up `toolIndex[p.toolCallId]`; drop if missing or block isn't a
  tool. `liveOutput = p.reset ? p.delta : liveOutput + p.delta`.

### 3.6 `applySnapshot(state, snap: InFlightSnapshot)` — pure

- `snap.assistant` → seeds `inFlight` (`blocks` mapped: text/thinking keep `{type, text}`, any
  other block type becomes `{type:"text", text:""}`); absent → `inFlight = null`.
- For each `snap.toolCalls` with `partialOutput !== undefined`: if the indexed block exists,
  is a tool, AND is still `running` → set `liveOutput` to the snapshot's partialOutput.
- `runtimeStatus = { state: snap.status.state, detail? }`; `queue = snap.queue`.

### 3.7 `markSynced(state, upToSeq)` — pure

`{ ...state, live: true, lastSeq: Math.max(state.lastSeq, upToSeq) }`.

### 3.8 `prependOlderEvents(state, events)` — pure (backward paging)

- Input: older, seq-ascending page (all seq < current oldest). Runs `reduceEvent` over a fresh
  empty Draft (inFlight/runtimeStatus of the page are discarded — only the page's blocks and
  indices matter).
- Result: `blocks = [...pageBlocks, ...state.blocks]`, `rawEvents` likewise prepended;
  existing `toolIndex`/`approvalIndex` values shift by `pageBlocks.length` and merge with the
  page's own indices, **page entries win on collision** (earlier starts).
- `lastSeq`, `inFlight`, `live`, `runtimeStatus`, `queue` unchanged.

---

## 4. App shell & dockview layout (app.tsx)

### Static frame (outside dockview)

```
┌──────────────────────────────────────────────────────────┐
│ [closed-state banner: "Disconnected from daemon — <detail>"  [Retry]]  ← only when connState==="closed"
├───────────────┬──────────────────────────────────────────┤
│ SessionsRail  │  dockview container (fills <main>)        │
│ (fixed 260px  │                                          │
│  left aside,  │                                          │
│  border-r)    │                                          │
├───────────────┴──────────────────────────────────────────┤
│ StatusBar (24px, h-6)                                     │
└──────────────────────────────────────────────────────────┘
+ overlays mounted as siblings: <Toasts/> <ApprovalsHost/> <CommandPalette/> <SettingsModal/> <GlobalHotkeys/>
+ everything wrapped in <TooltipProvider>; root div: flex h-full flex-col bg-app font-sans text-[13px] text-ink
```

### Dockview panels

dockview v7 has no React adapter: `createComponent` returns a plain `div.dv-agena-panel`
element; `init` registers it in a `portals` Map state, `dispose` removes it (identity-checked).
React renders each panel with `createPortal(panelNode(id), element, id)` — ONE React tree, so
providers/stores work normally. Theme: `themeAbyss` extended with className `dv-theme-agena`.

Panel registry (`panelNode`):

| id | component | notes |
|---|---|---|
| `transcript` | `SessionWorkspace` (TranscriptPane + Composer, keyed by activeSessionId) | title "Session"; always present — removing it re-adds via `queueMicrotask` |
| `inspector` | `InspectorPane` | on-demand, right of transcript, `initialWidth: 340` |
| `browser` | `BrowserPane` | on-demand, right of transcript, `initialWidth: 640` |
| `terminal` | `TerminalDock` | dock panel |
| `files` | `FilesPane` | dock panel |
| `search` | `SearchPane` | dock panel |
| `snapshots` | `SnapshotsPane` | dock panel |
| anything else | `EmptyState "Unknown panel"` | stale persisted layouts must not crash |

- **Default layout** (`buildDefaultLayout`): ONLY the transcript panel, active. Transcript-first;
  inspector/dock open on demand.
- **The dock** = the four `DOCK_PANELS` (`terminal`,`files`,`search`,`snapshots`) tabbed
  `within` one group. First missing dock panel is added `below` transcript with
  `initialHeight: 280`; the rest join `within` it, all `inactive: true`; if the freshly-built
  group has no active panel, terminal is activated. `applyDock(open)` ensures the panels exist
  then `group.api.setVisible(open)` — the group is the one holding any dock panel; panels the
  user dragged elsewhere are ignored.
- `applyInspector` / `applyBrowser`: add (inactive, then `setActive()` if the new group has no
  active panel — otherwise content never attaches) / `removePanel` on close.
- **Layout persistence**: `LAYOUT_VERSION = 2`; persisted as
  `{ layout: { v: 2, dock: api.toJSON() } }` debounced 800ms on `onDidLayoutChange`.
  Restore: only if `saved.v === LAYOUT_VERSION && saved.dock`; `api.fromJSON` in try/catch;
  failure → `api.clear()` (itself try/caught) → default rebuild. After restore: always
  `ensureTranscript`, and every group without an active panel gets `panels[0].api.setActive()`.
- **Both-ways sync** dockview ↔ useUi:
  - one-time on mount: `setInspectorOpen(!!getPanel("inspector"))`, same for browser;
    `setTerminalOpen(dockGroup(api)?.api.isVisible ?? false)`.
  - dockview → store: `onDidRemovePanel` — transcript re-added; inspector/browser set their
    flags false; a dock panel removal sets `terminalOpen=false` only when NO dock panel
    remains. `onDidAddPanel` — inspector/browser set flags true.
  - store → dockview: `useUi.subscribe` diffing `inspectorOpen`/`browserOpen`/`terminalOpen`.
- **Search reveal**: `window` event `"agena:open-search"` → open dock, `setTerminalOpen(true)`,
  activate the search panel, then re-dispatch the same event once on the next animation frame
  (guarded by a `refiring` flag) so SearchPane's own listener can focus its input after the dock
  became visible.
- `SessionWorkspace`: when no active session → EmptyState "Pick or create a session" with
  `⌘N` hint; else `TranscriptPane` above `Composer`, keyed by session id, and an effect that
  re-runs `ensureSubscribed(activeSessionId)` whenever it or connState==="connected" changes
  (toast on failure).
- `initBrowserStore()` is called once inside the dockview mount effect.

---

## 5. Features

### 5.1 Sessions rail (`features/sessions/sessions-rail.tsx`)

**Renders**: fixed 260px left rail — 32px header ("Agena" + reload IconButton), scrollable body
split into two `RailSection`s ("Projects", "Global", each with sticky header + create button),
32px footer ("<n> sessions" + show/hide-archived eye toggle). Project sessions grouped under
sticky `ProjectGroupHeader`s (collapse chevron, label, count, per-group "+" that seeds a new
session from the group's first summary). Rows: `StatusDot(status)`, title (or "untitled",
muted), `RelativeTime(updatedAt)`; second line = cwd tail (`pathTail` = last two path segments,
project rows only) + optional origin Badge ("claude"/"codex") derived from the loaded
transcript's `session.created` payload `origin` (`import.claude`/`import.codex`) — omitted when
the transcript isn't loaded. Active row: `border-l-accent bg-raised`.

**Grouping** (`splitSessionSections(byId, order, showArchived)` — exported, tested): preserves
newest-first order within groups; skips `scope === "control"`; skips archived unless
`showArchived`; `scope === "global"` → globalIds; group key = `projectId ?? "project:" +
sessionId`; label = `pathName(hostCwdHint) ?? pathName(projectRoot) ?? projectId ?? "Global"`.

**Create inputs** (exported): `createGlobalSessionInput() = { scope:"global", cwd:"." }`;
`createProjectSessionInput(seed)` = `{ scope:"project", projectId, projectRoot, cwd: projectRoot }`
or null when metadata is missing (toast "Project metadata is missing").

**Flows** (all toast errors via `errMsg`, all guarded by one `busy` flag):
- refresh: `listSessionSummaries({ allProjects:true, includeArchived:true })` → `setAll`;
  errors → `setError`. Runs on mount.
- activate: `setActive(id)` + `ensureSubscribed(id)` (toast on reject).
- create session (global / in project): `createSession(input)` → `ensureSubscribed(id, 0)` →
  refresh → `setActive(id)` → `requestComposerInsert("")` (focuses composer).
- "New project…" modal (⌘O / rail buttons): TextInput (Enter submits) +
  "New empty remote project" (`createProject(name)` — name required, toast) + "Copy local folder"
  (`openProjectFolder()`; null = user cancelled; success toast "Copied <n> files → <root>").
  Both then run the create-session flow with the returned project.
- Context menu (custom `menu` state positioned at the right-click point via a fixed 1px
  MenuTrigger): session rows → Archive/Unarchive (`updateSessionStatus(id, "archived"|"idle")` +
  local `setStatus`), Copy session id (clipboard + toast). Project headers (only when the seed
  has a projectId) → Copy project id, "Delete project…" (danger).
- Delete-project modal: warns it removes sessions/history/workspace files/snapshots;
  `deleteProject(projectId)`; clears `activeSessionId` if it was in the group; toast
  `Deleted <label> (<n> sessions)`; refresh.

**Empty/edge states**: skeleton rows while first load; error banner row (when list nonempty) or
full EmptyState with Retry (when empty); "No visible sessions / All sessions are archived" with
"Show archived" action; zero-data state renders both empty RailSections.

**Commands registered** (effect, dep `[createGlobalSession]`): `session.new` (mod+n),
`project.open` (mod+o → opens the project modal), `session.next` (mod+alt+arrowdown),
`session.prev` (mod+alt+arrowup). Cycle order = flattened project ids then global ids, wraps,
uses a ref for showArchived.

**IMPROVE-ON**: `lost` sessions are stored (`markLost`) but the rail never surfaces them;
the archive/eye toggle is session-local (not persisted); collapsedProjects not persisted;
`refresh()` leaves `loading` true forever on the error path when order was empty (setError
clears it — actually fine) — but the origin Badge requiring a loaded transcript means it
appears only for the sessions you've opened.

### 5.2 Composer (`features/composer/composer.tsx`)

**Renders**: a bordered box under the transcript — auto-growing textarea (1→8 rows, MAX_HEIGHT
172px, mono 13px), a footer row of pickers (model menu, thinking-level menu, "…" menu with
Compact history), queue badges (`<n> steer`, `<n> queued`), and a round Send (accent, ArrowUp)
or Stop (red, Square) button. While `active`, the box border glows accent and a Steer /
Queue follow-up segmented control appears beside the textarea; the model picker is disabled with
tooltip "between turns only". While disconnected the textarea is disabled and "reconnecting…"
shows in the footer. An abort-confirm strip renders above the box when `confirming`
("Abort turn? / Esc again to confirm" + Abort / Keep going buttons).

**Derived state**: `active = runtimeStatus.state !== "idle" || inFlight !== null` (subscribes to
`useTranscripts`); `steerCount`/`followUpCount` from `transcript.queue`; `connected` from
useConnection; `runtime = useConnection.runtime[sessionId]`.

**Drafts**: module zustand store `useComposerDrafts { drafts, setDraft }`; every edit schedules a
500ms-debounced `savePersisted({ drafts })` (empty drafts filtered out); hydrated once per app
run from `loadPersisted()` with in-session typing winning (`{...p.drafts, ...s.drafts}`).

**Runtime controls**: on first render per session (when `!runtime && connected`)
`runtimeInfo(sessionId)` → `setRuntime`. `pickModel` → `setModel` ack → patch
`runtime[sessionId].model`; `pickThinking` → `setThinkingLevel` ack → patch thinkingLevel.
Both toast errors.

**Send logic (`doSend`)** — implicit mode, the ONE subtle part:
- guard: trimmed nonempty, connected, not already sending.
- `active` → `steer` or `followUp` per the segmented `queueMode` (default "steer"); on error
  code `TURN_NOT_ACTIVE` → silently resend as `prompt` (turn ended while typing).
- idle → `prompt`; on error code `SESSION_BUSY` → resend as `steer` + info toast
  "Turn already active — sent as steer".
- success clears the draft; finally: `sending=false`, refocus textarea.

**Keys**: Enter (no shift, not IME-composing) sends; Escape while `active` runs the two-step
stop: first press shows the confirm strip, second press aborts (`bridge.abort(sessionId)`).
The strip auto-dismisses when the turn ends elsewhere (`active` flips false).

**Cross-pane insert**: watches `useUi.composerInsert` nonce; appends text to the current draft
and focuses. (An empty-string insert is the "focus composer after create session" trick.)

**Commands registered** (per active session): `composer.focus` (mod+l), `turn.abort`
(enabled only while active; keywords stop/cancel/esc), `session.compact` (keywords
context/summarize; `bridge.compact` + toast "History compacted").

**IMPROVE-ON**: hydrateDrafts uses a module `hydrateStarted` flag — mock/daemon switch never
rehydrates; queueMode resets to "steer" on every remount; the "…" menu duplicates Compact only.

### 5.3 Transcript pane (`features/transcript/transcript-pane.tsx`)

**Renders**: virtualized block list (`@tanstack/react-virtual`; `estimateSize: 64`,
`overscan: 8`, `paddingStart: 12`, `paddingEnd: 16`, `getItemKey = blocks[i]?.seq ?? "tail"`),
each row centered `max-w-[52rem] px-4 py-1.5`. Count = `blocks.length + (inFlight ? 1 : 0)` —
the tail is the virtual item AFTER the last block. Clicking any block sets
`useUi.setSelected({sessionId, seq})` (inspector target).

**States**: no transcript OR (`!live && no blocks && no tail`) → skeleton; live but empty →
EmptyState "No messages yet / Prompt below to start".

**Autoscroll**: `pinnedRef` starts true; a scroll handler computes pinned =
`scrollHeight - scrollTop - clientHeight <= 40`. Layout effect on transcript change:
- older page prepended (`firstSeq < prevFirst`): find previous first block, index-anchored
  `scrollToIndex(idx, {align:"start"})` (not pixel-exact — accepted).
- pinned → `scrollTop = scrollHeight` on next rAF.
- not pinned and blocks grew → `newCount += delta`, shows a floating "↓ N new" pill
  (click: reset, pin, scroll to bottom). Reaching the bottom by hand also clears the pill.
- per-session reset effect: repin, clear counters, scroll down.

**Backward paging**: scroll handler, when `scrollTop < 80` and `rawEvents[0].seq > 1`, calls
`useTranscripts.prependOlder(sessionId)`. While `loadingOlder`, a floating top pill
"⟳ loading older…".

**Jump/flash**: watches `useUi.jump` (nonce re-triggers); finds first block with
`seq >= jump.seq`, unpins, `scrollToIndex(align:"center")`, sets `flashSeq` for 1300ms → the
row gets class `flash-highlight`.

### 5.4 Streaming tail (`features/transcript/tail.tsx`)

Rendered inside the transcript's last virtual row when `inFlight != null`. Left accent border
(`border-l-[1.5px] border-accent pl-3`). Maps `inFlight.blocks`: `thinking` →
`ThinkingDisclosure`, else `Markdown`. Below: `StreamingDots`, the runtime status line when
`status.state !== "idle"` (`"<state> — <detail>"`), and queue badges
("N steer(s) queued" accent, "N follow-up(s) queued" neutral).

### 5.5 Block renderings (`features/transcript/blocks.tsx`)

Dispatch `BlockView({block, sessionId})` by `block.kind`.

- **ContentView** (shared): `text` → `Markdown`; `thinking` → `ThinkingDisclosure`
  (collapsed-by-default "Brain > Thinking" toggle; open = pre-wrap italic muted, left border);
  `image` → Badge "image — <alt>"; `file` → Badge with path; `toolCall` → null (tools render as
  their own rows); unknown content types → null, never crash.
- **UserRow**: right-aligned card (`ml-auto max-w-[85%] rounded-lg bg-raised`); `queued` badge
  ("steer" / "follow-up") when present.
- **AssistantRow**: plain content; `aborted` → warn Badge "aborted — shutdown|user"; `failed` →
  err Badge "failed — <code>" + message; `usage` → mono footer `"<in> → <out> tok"`
  (k-formatted ≥1000, `fmtTok`).
- **ToolRow**: bordered card. Header button = chevron, icon by name
  (bash/shell→Terminal, edit/write→FilePen, read→FileText, else Wrench), mono tool name,
  truncated `argSummary` (first string among args.command/path/file_path/filePath, else JSON
  truncated at 80 chars), status cell (`running`→StreamingDots; `completed`→green ✓ +
  `fmtDuration` (ms | s to 1dp); `failed`→red ✗ + error.code; `aborted`→"aborted" warn;
  `denied`→ShieldX + deniedReason). Expansion: `pinned: boolean | null` — null follows status
  (auto-open while running, auto-collapse on finish); clicking pins the opposite of current.
  Body: args JSON (folded behind "show args (N lines)" when ≥6 lines) via CodeBlock; output =
  `ToolOutput` fed `stripAnsi(liveOutput)` while running else
  `stripAnsi(textOf(result ?? partialOutput ?? []))`; failed also prints `code: message` in red.
- **ToolOutput**: `<pre>` max-h-64, ANSI-stripped, sticky follow-scroll while streaming
  (followRef true while within 16px of bottom); 400-line fold — streaming keeps the TAIL,
  finished keeps the HEAD, with "show all (N lines)" button; finished-empty → "no output".
- **ApprovalRow** (inline card, accent left border; dims when expired/cancelled): Shield +
  `request.title ?? "Approval requested"` + "pending" badge; message; subject grid rendering
  every present field verbatim (toolName, command, cwd, action, args JSON) — D-INV-3. Pending
  actions: `confirm` → Deny / Approve buttons calling
  `respondToApproval(sessionId, approvalId, {kind:"confirm", accepted})`; `select` → one button
  per option (`{kind:"select", optionId}`); `input`/`editor` → "Review…" button dispatching
  `CustomEvent("agena:open-approval", {detail:{approvalId}})` (hands off to the modal host).
  Responded → "✓ approved|denied|selected <id>|responded by <respondedBy>"; expired →
  "expired unanswered"; cancelled → "cancelled — <reason with _ → space>".
- **RuntimeRow**: Terminal icon + type label (`custom` shows `meta.customType ?? "system"`);
  bash rows get exit Badge (ok when 0) and `$ <command>` line; body = mono pre-wrap
  `textOf(content)`.
- **MarkerRow**: horizontal rule with centered icon + text; warn coloring for
  `malformed`/`run-failed`/`compaction-failed`. Icon map: model→Cpu, thinking→Brain,
  compaction(-failed)→Archive, terminal-*→Terminal, run-failed→AlertTriangle, session→Sparkles,
  snapshot→Camera, unknown/malformed→CircleHelp.
- `stripAnsi` (`ansi.ts`): regex covering CSI, OSC (BEL/ST-terminated), and lone two-char
  escapes.

### 5.6 Markdown (`features/transcript/markdown.tsx`)

`react-markdown` + `remarkGfm`, `skipHtml` (no raw HTML). Custom components: links prevent
default and route through `openInAppBrowser(href, "agent")` — http/https/localhost → embedded
pane; otherwise `window.open(href, "_blank", "noopener")` (mailto:/tel:/etc.). Fenced/multiline
code → `CodeBlock` (language from `language-*` class, default "text"); inline → `InlineCode`;
`pre` unwrapped. Memoized; prose styling via one big utility-class string (13px, compact
headings/lists/tables/blockquotes).

### 5.7 Approvals host + modal (`features/approvals/approvals-host.tsx`)

**ApprovalsHost** (mounted once in App):
- On mount re-seeds from `listApprovals()` (`.catch(() => {})`) — events win over HTTP.
- Listens for `"agena:open-approval"` (exported const `OPEN_APPROVAL_EVENT`): switches the
  active session to the approval's session if needed, sets `viewId` (forced view).
- Toasts "Approval requested in <session title|id>" once per approvalId (module-scope
  `toastedIds` Set survives StrictMode remounts) for pendings NOT in the active session.
- Modal shows: the forced approval, else the oldest-by-seq not-`dismissed` pending of the
  ACTIVE session. Removal via events closes it automatically (state-derived, not memory).
  Closing dismisses the whole current batch (`dismissed` set) so the next pending doesn't nag;
  a NEW pending still auto-opens.
- Nav list = pendings of the current approval's session sorted by seq; footer shows
  "‹ i of n ›" pagers when n > 1.

**ApprovalDialog** (keyed by approvalId so per-kind state resets):
- Renders ONLY the canonical request: title row ("Approval requested" + session Badge), pre-wrap
  message, subject grid (tool/command/cwd/action verbatim; args behind a `<details>` "json"
  disclosure as CodeBlock).
- `confirm`: Deny / Approve. `select`: radiogroup of options (label + description); Approve
  disabled until a choice. `input`: TextInput seeded with `request.defaultValue ?? ""`.
  `editor`: 10-row TextArea, same seeding. Responses:
  `{kind:"confirm",accepted:true}` / `{kind:"deny"}` / `{kind:"select",optionId}` /
  `{kind:"input"|"editor", text}`.
- Submit: `respondToApproval`; success → `remove(approvalId)` + toast Approved/Denied. Error
  code `APPROVAL_NOT_PENDING` → first-write-wins: remove + info toast
  "Already answered by another client". Other errors keep the modal open to retry (submitting
  reset) + err toast.
- `request.expiresAt` → `Countdown`: 1s interval; label "expired" / "expires in Nm" (≥60s) /
  "expires in Ns"; warn color under 30s.

**ApprovalChip** (status bar): pulsing warn Badge "N approval(s)"; click dispatches
OPEN_APPROVAL_EVENT for the OLDEST pending across all sessions (requestedAt then seq).

### 5.8 Inspector (`features/inspector/inspector-pane.tsx`)

**Renders**: PanelShell + header with prev/next event IconButtons (step through rawEvents
adjacency). Empty states: nothing selected → "Select any event"; selected seq not in the loaded
rawEvents (binary search by seq) → "Event #N not loaded / scroll back to page older events in".
Detail view: type (mono, truncated, title attr) + `#seq` Badge + RelativeTime; source badges
(kind: user→accent, runtime→info, else neutral; optional mono `source.runtime` badge; truncated
`source.clientId` with copy-with-✓ feedback (1.5s)); derived timing row; payload JSON CodeBlock
with "Copy JSON" button (✓ feedback); blob-ref badges.

- **Derived timing**: `payload.durationMs` if present → "duration <fmtMs>"; else for
  `message.assistant.completed|aborted|failed`, walk back to the matching
  `message.assistant.started` (same messageId) → "<fmtMs> since started (#seq)". fmtMs:
  ms / s(1dp) / "Nm Ss".
- **Blob refs**: recursive scan for `{ blob: "sha256:…" }` shapes (max 8), rendered as info
  badges "path: blob sha256:… (lazy fetch lands with M7)"; ref truncated at 19 chars.

Reads `useUi.selected`, `useTranscripts.bySession[..].rawEvents`. Writes `setSelected` (nav).

### 5.9 Timeline strip (`features/timeline/timeline-strip.tsx`) — **ORPHANED**

`TimelineStrip({sessionId})` is fully implemented but **not mounted anywhere** in the current
app (no imports outside its own file). Contract if you wire it in (IMPROVE-ON: mount it, e.g.
above the transcript):

- Filter chips (segmented, aria-pressed): All / Agent / Tools / Terminal / Approvals /
  Snapshots / Errors, backed by a shared `useTimelineFilter` zustand store
  (`{filter, setFilter}`) exported so TranscriptPane could filter by the same selection
  (it currently doesn't).
- `matchesTimelineFilter(type, filter)`: agent = `message.*` + `run.*`; tools = `tool.call.*`;
  terminal = `terminal.*`; approvals = `approval.*`; snapshots = `snapshot.*`; errors =
  `/[._](failed|denied|aborted)$/`.
- Density bar: rawEvents bucketed by pixel (DOT_PITCH = 3px → `floor(width/3)` buckets;
  bucket index = `floor((seq-1)/lastSeq * buckets)` clamped). Per bucket: first/last seq, count,
  best (lowest) rank wins the color. Rank priority: error-ish `bg-err` → approval `bg-warn` →
  user `bg-accent` → snapshot `bg-ok` → tool `bg-info` → assistant `bg-ink-dim` → rest
  `bg-ink-mute`. Dot = absolutely-positioned 2px-wide button, h-2 (h-3 for clusters), native
  `title` tooltip ("type · #seq" or "N events · #a–#b"), hover scales. Click →
  `useUi.requestJump(sessionId, seq)` + `setSelected`.
- Subscribes to `rawEvents` reference (changes only on durable appends — frames never
  re-render it) + `lastSeq`; ResizeObserver drives bucket count.

### 5.10 Terminal (`features/terminal/`)

**terminal-store.ts** — lifecycle lives in the store, NOT React effects (tabs and xterm
instances survive dock unmount/remount and StrictMode double-mounting):

```ts
export type TerminalTab = {
  id: string; // = ptyId
  cwd: string;
  sessionId: string | null;           // set when opened from a session (badges the tab)
  term: Terminal; fit: FitAddon; search: SearchAddon;
  port: MessagePort;
  readSelection: () => string;        // current selection, falling back to last non-empty
  label: string | null;               // custom rename; null → derive from cwd tail
  exited: { code: number | null; reason: string | null } | null; // null while running
};

export type TerminalsStore = {
  tabs: readonly TerminalTab[];
  activeId: string | null;
  findFor: string | null;             // tab id whose inline find bar is open
  open: (opts: { cwd?: string; sessionId?: string }) => Promise<void>;
  close: (id: string) => void;
  setActive: (id: string) => void;
  rename: (id: string, label: string) => void;
  setFind: (id: string | null) => void;
};
```

`open`: `openPty({cols:80, rows:24, cwd?, sessionId?})` → build `Terminal({fontFamily:
var(--font-mono) fallback stack, fontSize:12.5, cursorBlink, allowProposedApi, theme:
readXtermTheme()})` + Fit + Search addons. `term.onData` → encode UTF-8 →
`port.postMessage({type:"data", data})` — **NO transfer list**. Track `lastSelection` via
`onSelectionChange`. `attachCustomKeyEventHandler`: plain mod+f (no shift/alt) → open find bar
for this tab, swallow the key. `port.onmessage`: `data` → `term.write(new Uint8Array)`;
`exit` → `disableStdin` + set `exited`. Push tab, activate.

`close`: best-effort `postMessage({type:"close"})`, `port.close()`, `term.dispose()`, remove
tab, activate the neighbor (`min(idx, len-1)`), clear findFor if it pointed here.

`readXtermTheme()`: reads CSS vars `--surface`/`--ink`/`--accent` (with hex fallbacks);
selection = accent + `4d` alpha when accent is `#rrggbb`.

**terminal-dock.tsx**: 32px tab bar (scrollable) + "+" button + per-tab views (all mounted,
inactive ones `hidden` — scrollback preserved). Tab: exit dot (green code 0 / red otherwise,
title "exited (code n)"), label (double-click → inline rename input; Enter/blur commits —
`rename` trims, empty → null → cwd tail; Escape cancels), sessionId badge (last 4 chars),
hover/focus-visible close ✗. Radix ContextMenu per tab: Rename; "Send selection to composer"
(disabled when no selection at menu-open time; sends `requestComposerInsert(selection)`).
Empty state: "No terminals / ⌘` opens one in the session cwd" + button.
`openInActiveCwd()`: uses active session's `{cwd, sessionId}` else `{}`; toast on failure.
Live theme: a MutationObserver on `data-theme` re-applies `readXtermTheme()` to every tab.
Commands registered: `terminal.toggle` (mod+j — shadows the GlobalHotkeys copy),
`terminal.new` (mod+` — opens the dock first if closed, then a PTY).

**terminal-view.tsx**: attach effect keyed by `tab.id` — re-append `term.element` if it exists
(dock remount keeps scrollback) else `term.open(el)`; focus when active and not exited; element
padding "4px 8px"; try WebGL addon (dispose on context loss; DOM renderer fallback);
fit-on-resize: ResizeObserver → 50ms debounce → skip zero-size → `fit.fit()` +
`port.postMessage({type:"resize", cols, rows})`. Find bar (absolute top-right, when
`findFor === tab.id`): TextInput with incremental `findNext` on change; Enter/Shift+Enter =
next/prev; Escape or ✗ closes (`clearDecorations()` + refocus term); ▲▼ buttons. Exit overlay:
bottom strip "process exited (code n) — reason". Pointer-down anywhere focuses the term.

### 5.11 Files (`features/files/files-pane.tsx`)

Read-only browser over `listFiles`/`readFile` (the daemon has no write route yet — NO save/edit
affordance). Two columns: 240px tree + preview.

- Root path derives from the active session:
  `fileRootForSession(session) = session.scope === "project" && projectRoot ?
  workspaceRelative(projectRoot) : "."` — `workspaceRelative` strips a leading `/workspace/`
  (bare `/workspace` → "."). Root change resets dirs/expanded/viewer and reloads.
- Tree: lazy per-directory `DirState = loading | error | ready{entries}` keyed by path
  (child path = `path === "." ? name : path + "/" + name`); dirs sorted first then by name;
  loading spinner / error text / "empty" italic rows; folders toggle (chevron rotates, loads
  on first open), files open in the viewer; selected file highlighted.
- Viewer `ViewerState = idle | loading{path} | error{path,message} | binary{path,size} |
  image{path,size} | text{path,size,content,lang}`. Image extensions
  (png/jpg/jpeg/gif/webp/bmp/ico/svg) short-circuit to an "Image blob fetch lands later"
  EmptyState (no read). Otherwise `readFile(path)`: > 512 KB (`MAX_PREVIEW_BYTES`) OR a NUL
  byte in the first 1024 bytes → binary state ("Binary or too large to preview"); else
  TextDecoder + CodeBlock with lang from extension map
  (ts/tsx/js/json/css/html/md/py/sh; else "text"). Stale responses guarded by a request
  counter ref. Header: breadcrumb (segments, last one bright), human size, copy-contents
  IconButton (toast "Copied file contents").
- **IMPROVE-ON**: no refresh button; no image preview; CodeBlock height override is a hack
  (`[&>div:last-child]:max-h-none`) pending a fill-height prop.

### 5.12 Search (`features/search/search-pane.tsx`)

Dock tab. Header + input (Search icon inside, autoFocus, focused again by the
`"agena:open-search"` window event — see §4 for the re-dispatch dance). Debounced 250ms;
requires ≥2 trimmed chars (below that → idle state); stale results dropped via request counter.
Calls `bridge.search(q)` (no opts). States: idle explainer / "searching…" spinner / error
EmptyState / "No matches for “q”" / hit count + hit list. Hit row: session title (fallback
`session <last6>`), `#seq` chip when present, 2-line snippet with case-insensitive `<mark>`
highlighting (React-escaped, manual indexOf loop). Click →
`useSessions.setActive(hit.sessionId)`; if `hit.seq !== undefined` also
`setSelected` + `requestJump` (transcript flashes the block).

**IMPROVE-ON**: search always queries the whole workspace (opts like `sessionId`/`allProjects`
unused); no pagination/limit control.

### 5.13 Snapshots (`features/snapshots/snapshots-pane.tsx`)

Dock tab. Header "Snapshots" + "New snapshot" button → inline name row (optional name; Enter
creates, Escape cancels) → `createSnapshot({name?})` + toast + refresh. List:
`listSnapshots()` filtered `status !== "deleted"`, sorted `createdAt` desc. Card: Camera icon,
label (`name ?? snapshotId.slice(-8)` — unnamed renders mono/dim), kind Badge
(manual→neutral, auto→info, pre_tool→info "pre-tool", pre_restore→warn "safety"), size +
RelativeTime; "⋯" menu → "Restore…" / "Delete…" (danger).

- **RestoreConfirm** (typed confirm, D-INV-8): must type `target.name ?? "restore"` exactly;
  explains files under /workspace revert, history untouched, a safety `pre_restore` snapshot is
  taken first. `restoreSnapshot(id)` → toast
  `Restored “label” — safety snapshot <last6> taken first`; refresh.
- **DeleteConfirm**: simple confirm; `deleteSnapshot(id)`; explains /workspace unaffected.
- States: loading spinner / error EmptyState with Retry / "No snapshots yet" with create action.
- **IMPROVE-ON**: list never auto-refreshes on `snapshot.*` events (manual refresh only after
  own actions); no per-session filter despite `createSnapshot` accepting `sessionId`.

### 5.14 Browser (`features/browser/`)

Three pieces; the page itself is a native WebContentsView owned by main — the renderer owns
ONLY the toolbar and the placeholder rect.

- **browser-store.ts** — `useBrowser` = `BrowserState & { address: string; focusNonce: number }`
  plus actions `setAddress`, `requestAddressFocus` (nonce++), `open(url, opts)` (sets address,
  `bridge.browserOpen`), `navigate(action)`, `openDevTools`, `openExternal`,
  `close()` (**sets `useUi.browserOpen=false` AND calls `bridge.browserClose()`**).
  `initBrowserStore()` (idempotent, claimed synchronously): subscribes `onBrowserState` —
  merge push into store but **only re-sync `address` when `state.url` actually changed**
  (typing must not be clobbered by loading/title-only pushes); registers commands
  `browser.toggle` (mod+shift+b) and `browser.open` (opens pane + focuses URL bar via nonce).
- **router.ts** — THE single entry for opening URLs:

```ts
export function normalizeBrowserUrl(raw: string): string | null
// loopback (localhost[:port], 127.0.0.1, [::1]) → http:// (checked BEFORE the scheme test,
//   so "localhost:3000" isn't parsed as scheme "localhost")
// explicit http/https → kept; ANY other scheme (javascript:, data:, file:) → null
// scheme-less domain-shaped ("example.com/x") → https://
// final URL() parse must yield http:/https:, else null

export function openInAppBrowser(url: string, source: "user"|"agent"|"terminal"): boolean
// normalize; null → return false (caller falls back, e.g. window.open)
// else setBrowserOpen(true) + useBrowser.open(resolved, {source}); return true
```

- **browser-pane.tsx** — toolbar: Back/Forward (disabled by canGoBack/Forward), Stop-or-Reload
  (by `loading`), URL TextInput (mono; Enter → `navigate({kind:"url",url})` + blur; focus
  selects all; `focusNonce` effect focuses+selects), DevTools, Open-in-system-browser, Close
  (✗ → `useBrowser.close()`). Below: a plain placeholder div the native view composites over
  (`url === null` → EmptyState "No page open…"). Bounds streaming: rAF on mount +
  ResizeObserver + window resize + capture-phase scroll → `browserSetBounds(rounded rect)`.
  Visibility: `visible = !useUi(hasOverlay)`; effect calls `browserSetVisible(visible)`,
  re-reports bounds when re-shown, and `browserSetVisible(false)` on unmount. **This is the
  D-INV-3 enforcement point.**

### 5.15 Settings modal (`features/settings/settings-modal.tsx`)

⌘, overlay (`useUi.settingsOpen`), size lg, fixed h-540px. Left nav: "Session import" /
"MCP import" / "Skill import".

**ImportSection** (sessions): loads `importScan({refresh})` + `importStatus()` in parallel
(status catch→null; null ⇒ `daemonSupport=false` — the daemon predates /v1/imports: scan still
renders, both import buttons disabled with an explainer). Rows per `ProjectGroup`: tri-state —
project checkbox (`selected[cwd]` set of harnesses; ticking selects all harnesses with
sessions), expandable per-harness checkboxes ("Claude Code / Codex / Pi (N sessions, bytes)"),
cwd shown via `shortenHome` (line-through when `!exists`), counts summary, sizes
(`proj <codebaseBytes> · sess <sum>`, `humanBytes`), and an `ImportBadge` — "imported ✓" (ok) or
"N new since import" (warn) computed by `importedCounts(cwd, ledger)`: a ledger row matches when
`sourcePath === cwd` OR any whole path segment equals an encoded cwd (Claude's every-non-alnum→`-`
encoding, or the old pi `--cwd-dashes--` form) — segment equality, never substring. Footer:
"Import project only" (`run(filesOnly=true)` → harnesses: []) and "Import selected".
`ImportPlan.copyFiles = project.exists && codebaseBytes !== null`. Results list: per-source
Badge ok/skipped/err + error text. Refresh button re-scans with `refresh:true`.

**McpImportSection**: `mcpImportScan` + `mcpImportStatus`. Row: checkbox (disabled when already
imported or `authStatus === "missing_secret"`), name + mono target, transport Badge, state
badges — `mcpImportState(mcp, imported)` matches by `identity`: not_imported / imported
("imported · not verified") / ready ("ready · connects on use") / needs_authorization
(→ "Authorize" button: `mcpAuthStart(record.id)`, closes settings, toast "Authorization opened
in Agena's browser.") / error. "missing API key" warn badge. Footer: "Import selected (n)" →
`mcpImportRun({ids})`.

**SkillImportSection**: `skillImportScan` + `skillImportStatus({refresh})`. Row: checkbox
(disabled when imported), name, description or file count, state via
`skillImportState` (identity match; error / update_available OR contentHash mismatch → "update")
— "imported ✓" / "not imported" / Update button (`skillUpdate(record.id)`) / error badge.
Footer: "Import selected (n)" → `skillImportRun({ids})`.

### 5.16 Status bar (`features/statusbar/status-bar.tsx`)

24px footer (`h-6`, 11px text): connection button (StatusDot + label from
`{connecting:"Connecting…", connected:"Connected", reconnecting:"Reconnecting…",
closed:"Disconnected"}`; warn/err text colors; tooltip = detail ?? url; click toasts
"Daemon at <url>" / "Not connected") · `profile · host:port` when connected · divider ·
active session (StatusDot + title|id) · runtime button (`model.id · thinkingLevel` mono,
tooltip "Model · thinking level — click to change", click runs `composer.focus`) ·
`ApprovalChip` · right side: theme toggle IconButton (Sun/Moon, `setTheme(dark↔light)`) +
"daemon <version> · protocol v<n>".

### 5.17 Command palette (`features/palette/command-palette.tsx`)

`cmdk` `Command.Dialog` bound to `useUi.paletteOpen`. Groups from `allCommands(byId)` bucketed
by `group`; fuzzy filtering is cmdk's (item `value` = `"<title>·<id>"` — title first for
scoring, id suffix for uniqueness; `keywords` passed through). Items show title + chord
`Kbd(chordLabel)`, respect `enabled()` (disabled → dimmed, not selectable). Select closes the
palette FIRST, then `useCommands.run(id)`. 560px wide, top-20%, dark overlay + blur, loop nav.

### 5.18 Global hotkeys (`features/palette/global-hotkeys.tsx`)

Renderless; mounted once. Registers `BASE_COMMANDS` and owns THE single window-level
capture-phase keydown listener: skip `e.repeat || e.defaultPrevented`; first registered command
whose chord matches wins; **chords without `mod` do not fire from editable targets**
(`input, textarea, [contenteditable], .xterm`) — mod chords always fire; on match
`preventDefault` + `stopPropagation` + run.

BASE_COMMANDS: `palette.toggle` (mod+k), `settings.toggle` (mod+,), `inspector.toggle` (mod+i),
`terminal.toggle` (mod+j), `theme.toggle` (no chord), `search.open` (mod+shift+f — dispatches
`"agena:open-search"`).

---

## 6. Complete command & shortcut inventory

| id | title | group | chord | registered by | notes |
|---|---|---|---|---|---|
| palette.toggle | Toggle Command Palette | View | mod+k | GlobalHotkeys | |
| settings.toggle | Toggle Settings | View | mod+, | GlobalHotkeys | |
| inspector.toggle | Toggle Inspector | View | mod+i | GlobalHotkeys | |
| terminal.toggle | Toggle Terminal | View→Terminal | mod+j | GlobalHotkeys, shadowed by TerminalDock | shadow restore on unmount |
| theme.toggle | Toggle Theme | View | — | GlobalHotkeys | dark↔light |
| search.open | Search Transcripts | Search | mod+shift+f | GlobalHotkeys | window event "agena:open-search" |
| session.new | New global session | Session | mod+n | SessionsRail | |
| project.open | New project… | Session | mod+o | SessionsRail | opens the project modal |
| session.next | Next session | Session | mod+alt+arrowdown | SessionsRail | wraps |
| session.prev | Previous session | Session | mod+alt+arrowup | SessionsRail | wraps |
| composer.focus | Focus composer | Composer | mod+l | Composer (per session) | also run by status bar |
| turn.abort | Abort turn | Session | — | Composer (per session) | enabled only while active |
| session.compact | Compact history | Session | — | Composer (per session) | |
| terminal.new | New Terminal | Terminal | mod+` | TerminalDock | opens dock if closed |
| browser.toggle | Toggle Browser | Browser | mod+shift+b | initBrowserStore | |
| browser.open | Open URL in Browser | Browser | — | initBrowserStore | opens pane + focuses URL bar |

Non-command keys: Enter sends / Shift+Enter newline / Esc = abort-confirm (composer);
Esc closes modals/palette (radix/cmdk built-in); mod+f inside a terminal = inline find
(Enter/Shift+Enter next/prev, Esc closes); Enter confirms in rename/create/restore inputs;
double-click renames a terminal tab; right-click context menus on session rows, project
headers, terminal tabs.

Window-level CustomEvents: `"agena:open-search"` (focus/reveal search) and
`"agena:open-approval"` with `{detail:{approvalId}}` (open approval modal, switching session).

---

## 7. Shared UI kit (ui/) — what features import

`Badge` (`tone: "neutral"|"accent"|"ok"|"warn"|"err"|"info"`), `StatusDot` (session status /
connection state), `Button` (`variant: solid|ghost|danger…`, `size sm`, `icon`), `IconButton`
(`label` = aria + tooltip), `CodeBlock` (`code`, `lang`, highlight, max-h-96 internal scroll)
+ `InlineCode`, `cx` (class join), `EmptyState` (`icon?`, `title`, `hint?`, `action?`),
`TextInput`/`TextArea`/`SelectLike`, `Kbd`, `Menu/MenuTrigger/MenuContent/MenuItem/MenuSeparator`
(radix dropdown; bumps overlayCount), `Modal/ModalTitle/ModalDescription/ModalFooter/ModalClose`
(`size sm|lg`; bumps overlayCount on mount), `PanelShell`/`PanelHeader` (`title`, `actions`),
`RelativeTime` (`iso`, live-updating), `Spinner`, `StreamingDots`, `Toasts` + `toast(message,
{tone})` (module-store, auto-dismiss 4s, bottom-right stack, dismiss ✗), `Tooltip`/`TooltipProvider`.

Theme: CSS custom properties on `:root[data-theme]` (`--surface`, `--ink`, `--accent`,
`--font-mono`, …) consumed by Tailwind-style utility classes (`bg-app`, `text-ink`,
`border-border`, `text-ink-mute`, `bg-raised`, `text-accent`, `text-err/ok/warn/info`, …) and
read at runtime by the terminal theme + a `flash-highlight` animation class.

---

## 8. Rough edges — IMPROVE-ON list for the rewrite

1. **TimelineStrip is dead code**: implemented + tested store, never mounted. Wire it into the
   session workspace (and optionally let its filter drive the transcript, as intended).
2. `useTranscripts` **grows unboundedly** — no eviction of inactive sessions' blocks/rawEvents;
   `sessions.bump` runs for every event of every subscribed session.
3. `subscribedIds` never resets on disconnect — reconnect relies on the bridge/SDK re-playing;
   a renderer that reconnects to a DIFFERENT daemon would show stale "subscribed" state.
4. Composer draft hydration happens once per app run (`hydrateStarted` flag) and queueMode
   isn't persisted; drafts persist whole-map (last writer wins across windows).
5. Approval toasts aren't clickable (chip covers jump-to-session); `toastedIds` grows forever.
6. FilesPane: no refresh, no image preview (explicit "blob fetch lands later"), CodeBlock
   height override hack.
7. SnapshotsPane doesn't react to `snapshot.*` events — manual refresh only.
8. Search ignores `sessionId`/`allProjects`/`limit` options; no result paging.
9. Inspector blob refs are display-only ("lazy fetch lands with M7").
10. Sessions rail never shows `lost` sessions; archived/collapsed state not persisted.
11. Transcript prepend restore is index-anchored, not pixel-exact (accepted ponytail ceiling).
12. `chordMatches` can't express multi-key sequences and treats `mod+`\` via `e.key` — verify
    on non-US layouts.
13. Dock "the dock" = the group containing any DOCK_ID panel; user-dragged dock panels break
    the toggle mapping (accepted).
14. `session.title.changed` events mutate `useSessions` but a session UNKNOWN to `byId` is
    silently ignored (`setTitle`/`setStatus`/`bump` no-op) — events for sessions that arrived
    before the summary list do not create rail entries.
