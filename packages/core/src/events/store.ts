// The EventStore port (§7.4) — M1 subset. SQLite (M2) implements this same
// interface; nothing above the port changes (P8).
// ponytail: §7.4's createBranch/resolveBranchChain (branches are future — only the
// branchId column concept exists), readBlob/search/rebuildProjections/reconcileOpenWork/
// close and NewEvent.id (importer dedupe) land with M2+; readEvents drops the branchId
// arg until branching exists.
import type {
  AgenaEvent,
  ApprovalRequested,
  ContentBlock,
  EventSource,
  SearchHit,
  SessionStatus,
  SnapshotSummary,
} from "@agena/protocol";

export type SessionScope = "project" | "global" | "control";

export interface NewEvent {
  type: string; // must be a key of durableEventSchemas (P12)
  v: number;
  source: EventSource;
  payload: unknown;
}

export interface AppendEventsInput {
  sessionId: string;
  branchId: string;
  events: NewEvent[];
}
export interface AppendEventsResult {
  events: AgenaEvent[];
  lastSeq: number;
}
export interface ReadEventsPage {
  events: AgenaEvent[];
  nextFromSeq: number | null; // null = no more events
}

export interface PendingApproval {
  sessionId: string;
  branchId: string;
  seq: number;
  approvalId: string;
  requestedAt: string;
  payload: ApprovalRequested;
}

export interface CreateSessionInput {
  workspaceId: string;
  title?: string;
  source?: EventSource; // defaults to { kind: "user" } (§5.5 session.created)
  scope?: SessionScope;
  projectId?: string;
  projectRoot?: string;
  cwd?: string;
  hostCwdHint?: string;
}

export interface SessionRecord {
  sessionId: string;
  workspaceId: string;
  title?: string;
  rootBranchId: string;
  runtimeSessionRef?: string;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
  scope: SessionScope;
  status: SessionStatus;
  projectId?: string;
  projectRoot?: string;
  cwd: string;
  hostCwdHint?: string;
}

export interface SessionFilter {
  projectId?: string;
  scope?: SessionScope;
  status?: SessionStatus;
  allProjects?: boolean;
  includeControl?: boolean;
  includeArchived?: boolean;
}

export type SnapshotKind = SnapshotSummary["kind"];

export interface CreateSnapshotRecordInput {
  snapshotId: string;
  workspaceId: string;
  sessionId?: string;
  name?: string;
  kind: SnapshotKind;
  storagePath: string;
  sha256: string;
  sizeBytes: number;
}

export function normalizeSessionScope(input: CreateSessionInput): {
  scope: SessionScope;
  projectId?: string;
  projectRoot?: string;
  cwd: string;
  hostCwdHint?: string;
} {
  const scope = input.scope ?? "project";
  const cwd =
    input.cwd ?? (scope === "project" ? (input.projectRoot ?? ".") : ".");
  return {
    scope,
    ...(scope === "project"
      ? {
          projectId: input.projectId ?? "default",
          projectRoot: input.projectRoot ?? ".",
        }
      : {}),
    cwd,
    ...(input.hostCwdHint ? { hostCwdHint: input.hostCwdHint } : {}),
  };
}

export type StoreErrorCode =
  | "session_not_found"
  | "not_a_durable_event"
  | "invalid_payload"
  | "payload_too_large";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export interface EventStore {
  /** Row + root branch + session.created, one atomic step (§7.4). */
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  listSessions(filter?: SessionFilter): Promise<SessionRecord[]>;
  updateSessionStatus?(
    sessionId: string,
    status: SessionStatus,
  ): Promise<SessionRecord>;
  updateRuntimeSessionRef?(
    sessionId: string,
    runtimeSessionRef: string,
  ): Promise<SessionRecord>;
  listPendingApprovals?(filter?: SessionFilter): Promise<PendingApproval[]>;
  createSnapshotRecord?(
    input: CreateSnapshotRecordInput,
  ): Promise<SnapshotSummary>;
  listSnapshots?(): Promise<SnapshotSummary[]>;
  markSnapshotDeleted?(snapshotId: string): Promise<void>;

  /** The ONLY durable write path; assigns per-session monotonic seq. */
  appendEvents(input: AppendEventsInput): Promise<AppendEventsResult>;

  /** Replay. fromSeq is EXCLUSIVE (returns seq > fromSeq); fromSeq 0 replays all (§5.4). */
  readEvents(
    sessionId: string,
    fromSeq: number,
    limit?: number,
  ): Promise<ReadEventsPage>;

  /**
   * THE fanout seam (P6): listeners invoked synchronously after the append
   * commits, in seq order; a listener throwing is caught and can never
   * un-commit anything (§6.2). Returns an unsubscribe function.
   */
  onCommitted(
    listener: (batch: AppendEventsResult & { sessionId: string }) => void,
  ): () => void;

  // M2 SQLite-only mechanics; optional keeps the in-memory test double lean.
  search?(
    query: string,
    opts?: {
      sessionId?: string;
      projectId?: string;
      allProjects?: boolean;
      limit?: number;
    },
  ): Promise<SearchHit[]>;
  rebuildProjections?(sessionId?: string): Promise<RebuildReport>;
  reconcileOpenWork?(): Promise<ReconcileReport>;
  close?(): void | Promise<void>;
}

export interface RebuildReport {
  sessions: number;
  events: number;
  messages: number;
  toolCalls: number;
}

export interface ReconcileReport {
  sessions: number;
  appended: number;
}

export function pendingApprovalsFromEvents(
  events: AgenaEvent[],
): PendingApproval[] {
  const pending = new Map<string, PendingApproval>();
  for (const event of events) {
    const p = record(event.payload);
    if (event.type === "approval.requested") {
      const payload = event.payload as ApprovalRequested;
      pending.set(approvalKey(event, payload.approvalId), {
        sessionId: event.sessionId,
        branchId: event.branchId,
        seq: event.seq,
        approvalId: payload.approvalId,
        requestedAt: event.createdAt,
        payload,
      });
    } else if (
      event.type === "approval.responded" ||
      event.type === "approval.expired" ||
      event.type === "approval.cancelled"
    ) {
      const approvalId = p.approvalId;
      if (typeof approvalId === "string") {
        pending.delete(approvalKey(event, approvalId));
      }
    }
  }
  return [...pending.values()].sort((a, b) => a.seq - b.seq);
}

export function extractSearchText(content: unknown): string {
  return Array.isArray(content)
    ? content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join("\n")
    : "";
}

function approvalKey(
  event: Pick<AgenaEvent, "sessionId" | "branchId">,
  approvalId: string,
): string {
  return `${event.sessionId}\0${event.branchId}\0${approvalId}`;
}

function record(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function isTextBlock(
  block: unknown,
): block is Extract<ContentBlock, { type: "text" }> {
  return (
    block !== null &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}
