// THE renderer↔main contract (desktop_plan.md §5). Joint-review-only file: the
// preload implements this against @agena/client in main; the mock implements it
// against fixtures. Renderer code depends on this type and @agena/protocol ONLY
// (plus type-only importer shapes, which erase at build time).
import type { ProjectGroup } from "@agena/importer";
import type {
  AgenaEvent,
  AgenaFrame,
  ApprovalResponse,
  CompactAck,
  CreatePtyRequest,
  CreateSessionRequest,
  DiagnosticsResponse,
  EmptyAck,
  FileEntry,
  Harness,
  ImportLedgerEntry,
  InFlightSnapshot,
  ListSessionsQuery,
  ModelRef,
  PendingApprovalSummary,
  PromptAck,
  PtySummary,
  RespondToApprovalAck,
  RuntimeInfoAck,
  SearchHit,
  SessionStatus,
  SessionSummary,
  SetModelAck,
  SetThinkingLevelAck,
  SnapshotSummary,
  SubscribeAck,
  ThinkingLevel,
} from "@agena/protocol";

// ---- connection -------------------------------------------------------------

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

// ---- streaming --------------------------------------------------------------

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

// ---- terminals --------------------------------------------------------------

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

// ---- persistence ------------------------------------------------------------

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

// ---- local-session import (settings_import_plan.md §1/§9) --------------------

export type { ProjectGroup };

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

// ---- local MCP import ------------------------------------------------------

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

// ---- local skill import ----------------------------------------------------

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

// ---- the bridge -------------------------------------------------------------

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
