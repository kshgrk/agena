// The EventStore port (§7.4) — M1 subset. SQLite (M2) implements this same
// interface; nothing above the port changes (P8).
// ponytail: §7.4's createBranch/resolveBranchChain (branches are future — only the
// branchId column concept exists), readBlob/search/rebuildProjections/reconcileOpenWork/
// close and NewEvent.id (importer dedupe) land with M2+; readEvents drops the branchId
// arg until branching exists.
import type { AgenaEvent, EventSource } from "@agena/protocol";

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

export interface CreateSessionInput {
  workspaceId: string;
  title?: string;
  source?: EventSource; // defaults to { kind: "user" } (§5.5 session.created)
}

export interface SessionRecord {
  sessionId: string;
  workspaceId: string;
  title?: string;
  rootBranchId: string;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
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
  listSessions(): Promise<SessionRecord[]>;

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
