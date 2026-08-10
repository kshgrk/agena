// View-state contracts (D-INV-5). Every shape here is produced ONLY by the
// pure reducers in this directory; components read, never mutate. Durable
// events finalize, frames touch in-flight only, malformed known payloads
// become marker blocks, unknown types never crash (D-INV-6).
import type {
  ApprovalRequested,
  ApprovalResponse,
  ContentBlock,
  EventSource,
  FastModeState,
  ModelRef,
  SessionSummary,
  SessionUsage,
  SubscriptionUsage,
  ThinkingLevel,
  UsageTotals,
} from "@agena/protocol";
import type {
  BridgeConnectionState,
  ConnectedInfo,
} from "../../shared/bridge.ts";

// ---- transcript blocks ------------------------------------------------------

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
  editedFromMessageId?: string;
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
  /** Cold transcript pages omit heavyweight tool bodies until disclosure. */
  hasDetails?: boolean;
  detailsState?: "summary" | "loading" | "loaded" | "error";
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
  | "model"
  | "thinking"
  | "compaction"
  | "compaction-failed"
  | "terminal-start"
  | "terminal-end"
  | "run-failed"
  | "session"
  | "snapshot"
  | "unknown"
  | "malformed";

export type MarkerBlock = BlockBase & {
  kind: "marker";
  markerKind: MarkerKind;
  text: string;
  detail?: unknown;
};

export type Block =
  | UserBlock
  | AssistantBlock
  | ToolBlock
  | ApprovalBlock
  | RuntimeBlock
  | MarkerBlock;

// ---- transcript state ---------------------------------------------------------

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
  /** Compact cold-history window; live durable events still use the reducer. */
  historyInitialized: boolean;
  hasOlderHistory: boolean;
  hasNewerHistory: boolean;
  firstHistoryMessageId: string | null;
  lastHistoryMessageId: string | null;
};

export const emptyTranscript = (sessionId: string): TranscriptState => ({
  sessionId,
  branchId: null,
  blocks: [],
  rawEvents: [],
  toolIndex: {},
  approvalIndex: {},
  inFlight: null,
  lastSeq: 0,
  live: false,
  runtimeStatus: null,
  queue: { steerCount: 0, followUpCount: 0 },
  historyInitialized: false,
  hasOlderHistory: false,
  hasNewerHistory: false,
  firstHistoryMessageId: null,
  lastHistoryMessageId: null,
});

// ---- other slices -------------------------------------------------------------

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
  runtime: Readonly<
    Record<
      string,
      {
        model?: ModelRef;
        thinkingLevel: ThinkingLevel;
        availableModels: ModelRef[];
        availableThinkingLevels: ThinkingLevel[];
        fastMode?: FastModeState;
        sessionUsage?: SessionUsage;
        subscriptionUsage?: SubscriptionUsage;
      }
    >
  >;
};

// ---- toasts (ARCHITECTURE cross-feature contract 4) --------------------------

export type ToastKind = "info" | "ok" | "warn" | "err";

export type Toast = {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  /** Set by dismissToast: the view plays the 140ms exit fade before removal. */
  closing?: boolean;
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
  /** Browser pane visible in the dock (native WebContentsView follows this). */
  browserOpen: boolean;
  /**
   * True while any DOM overlay is up (palette, a modal, an open menu). The
   * browser host hides the native WebContentsView when set — it paints above
   * all renderer DOM, incl. the approval modal (D-INV-3). Menus/modals bump a
   * counter via enterOverlay/exitOverlay; palette flips it directly.
   */
  overlayCount: number;
  /** Active toasts, newest last (features render via pushToast only). */
  toasts: readonly Toast[];
};
