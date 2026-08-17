// InMemoryEventStore (§7.4, §3.2): the M1 production store AND the permanent
// test double (P8/P16). Daemon-lifetime only — a restart loses history, by design.

import { createHash } from "node:crypto";
import type {
  AgenaEvent,
  SessionStatus,
  SnapshotSummary,
} from "@agena/protocol";
import { durableEventSchemas } from "@agena/protocol";
import { ulid } from "ulid";
import {
  type AppendEventsInput,
  type AppendEventsResult,
  type CreateDerivedSessionInput,
  type CreateSessionInput,
  type CreateSnapshotRecordInput,
  type EventStore,
  latestCompletedAssistant,
  normalizeSessionScope,
  type PendingApproval,
  pendingApprovalsFromEvents,
  type ReadEventsPage,
  type SessionFilter,
  type SessionRecord,
  StoreError,
} from "./events/store.ts";

interface SessionState {
  record: SessionRecord;
  events: AgenaEvent[]; // seq-ordered and contiguous: events[i].seq === i + 1
}

type CommitListener = (
  batch: AppendEventsResult & { sessionId: string },
) => void;

export class InMemoryEventStore implements EventStore {
  #sessions = new Map<string, SessionState>();
  #snapshots = new Map<string, SnapshotSummary>();
  #listeners = new Set<CommitListener>();
  #blobs = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  async putBlob(bytes: Uint8Array, mimeType: string) {
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    this.#blobs.set(hash, { bytes: bytes.slice(), mimeType });
    return { blob: hash, sizeBytes: bytes.byteLength, mimeType };
  }

  async readBlob(hash: string) {
    const blob = this.#blobs.get(hash);
    return blob ? { bytes: blob.bytes.slice(), mimeType: blob.mimeType } : null;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const scope = normalizeSessionScope(input);
    const record: SessionRecord = {
      sessionId: ulid(),
      workspaceId: input.workspaceId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      rootBranchId: ulid(),
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
      status: "active",
      origin:
        input.origin ?? (scope.scope === "control" ? "control" : "native"),
      ...scope,
    };
    this.#sessions.set(record.sessionId, { record, events: [] });
    await this.appendEvents({
      sessionId: record.sessionId,
      branchId: record.rootBranchId,
      events: [
        {
          type: "session.created",
          v: 1,
          source: input.source ?? { kind: "user" },
          payload: {
            workspaceId: input.workspaceId,
            ...(input.title !== undefined ? { title: input.title } : {}),
            runtime: "pi",
            origin:
              input.origin ??
              (scope.scope === "control" ? "control" : "native"),
            ...scope,
            rootBranchId: record.rootBranchId,
          },
        },
      ],
    });
    return record;
  }

  async createDerivedSession(
    input: CreateDerivedSessionInput,
  ): Promise<SessionRecord> {
    const parent = this.#sessions.get(input.parentSessionId);
    if (!parent) {
      throw new StoreError(
        "session_not_found",
        `unknown session ${input.parentSessionId}`,
      );
    }
    if (
      input.mode === "fork" &&
      input.purpose !== "quick_chat" &&
      !input.sourceMessageId
    ) {
      throw new StoreError(
        "invalid_payload",
        "sourceMessageId is required for fork",
      );
    }
    if (
      input.sourceMessageId &&
      !parent.events.some(
        (event) =>
          (event.type === "message.user.created" ||
            event.type === "message.assistant.completed") &&
          (event.payload as { messageId?: unknown }).messageId ===
            input.sourceMessageId,
      )
    ) {
      throw new StoreError(
        "invalid_payload",
        "sourceMessageId does not belong to parent session",
      );
    }
    const now = new Date().toISOString();
    const sideChatAccess =
      input.purpose === "quick_chat"
        ? (input.sideChatAccess ?? "read_only")
        : undefined;
    const record: SessionRecord = {
      sessionId: input.sessionId ?? ulid(),
      workspaceId: parent.record.workspaceId,
      ...((input.title ?? parent.record.title)
        ? { title: input.title ?? parent.record.title }
        : {}),
      rootBranchId: ulid(),
      ...(input.runtimeSessionRef
        ? { runtimeSessionRef: input.runtimeSessionRef }
        : {}),
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
      status: "active",
      origin: parent.record.origin,
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(sideChatAccess ? { sideChatAccess } : {}),
      scope: parent.record.scope,
      ...(parent.record.projectId
        ? { projectId: parent.record.projectId }
        : {}),
      ...(parent.record.projectRoot
        ? { projectRoot: parent.record.projectRoot }
        : {}),
      cwd: parent.record.cwd,
      ...(parent.record.hostCwdHint
        ? { hostCwdHint: parent.record.hostCwdHint }
        : {}),
      sessionKind: "primary",
      parentSessionId: parent.record.sessionId,
      derivedFrom: {
        parentSessionId: parent.record.sessionId,
        ...(input.sourceMessageId
          ? { sourceMessageId: input.sourceMessageId }
          : {}),
        mode: input.mode,
      },
    };
    this.#sessions.set(record.sessionId, { record, events: [] });
    await this.appendEvents({
      sessionId: record.sessionId,
      branchId: record.rootBranchId,
      events: [
        {
          type: "session.created",
          v: 1,
          source: input.source ?? { kind: "user" },
          payload: {
            workspaceId: record.workspaceId,
            ...(record.title ? { title: record.title } : {}),
            runtime: "pi",
            origin: record.origin,
            scope: record.scope,
            ...(record.projectId ? { projectId: record.projectId } : {}),
            ...(record.projectRoot ? { projectRoot: record.projectRoot } : {}),
            cwd: record.cwd,
            ...(record.hostCwdHint ? { hostCwdHint: record.hostCwdHint } : {}),
            rootBranchId: record.rootBranchId,
            ...(record.purpose ? { purpose: record.purpose } : {}),
            ...(record.sideChatAccess
              ? { sideChatAccess: record.sideChatAccess }
              : {}),
            derivedFrom: record.derivedFrom,
          },
        },
      ],
    });
    return record;
  }

  async getRuntimeMessageRef(
    sessionId: string,
    messageId: string,
  ): Promise<string | null> {
    const event = this.#sessions
      .get(sessionId)
      ?.events.find(
        (candidate) =>
          candidate.type === "message.runtime.ref" &&
          (candidate.payload as { messageId?: unknown }).messageId ===
            messageId,
      );
    const runtimeEntryId = (event?.payload as { runtimeEntryId?: unknown })
      ?.runtimeEntryId;
    return typeof runtimeEntryId === "string" ? runtimeEntryId : null;
  }

  async getLatestCompletedAssistant(sessionId: string) {
    const events = this.#sessions.get(sessionId)?.events;
    if (!events) return null;
    const completed = latestCompletedAssistant(events);
    const messageId = (completed?.payload as { messageId?: unknown })
      ?.messageId;
    if (!completed || typeof messageId !== "string") return null;
    return {
      messageId,
      seq: completed.seq,
      runtimeEntryId: await this.getRuntimeMessageRef(sessionId, messageId),
    };
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.#sessions.get(sessionId)?.record ?? null;
  }

  async listSessions(filter: SessionFilter = {}): Promise<SessionRecord[]> {
    return [...this.#sessions.values()]
      .map((s) => s.record)
      .filter((s) => sessionMatches(s, filter));
  }

  async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<SessionRecord> {
    const state = this.#sessions.get(sessionId);
    if (!state) {
      throw new StoreError("session_not_found", `unknown session ${sessionId}`);
    }
    state.record = {
      ...state.record,
      status,
      updatedAt: new Date().toISOString(),
    };
    return state.record;
  }

  async updateRuntimeSessionRef(
    sessionId: string,
    runtimeSessionRef: string,
  ): Promise<SessionRecord> {
    const state = this.#sessions.get(sessionId);
    if (!state) {
      throw new StoreError("session_not_found", `unknown session ${sessionId}`);
    }
    state.record = { ...state.record, runtimeSessionRef };
    return state.record;
  }

  async listPendingApprovals(
    filter: SessionFilter = {},
  ): Promise<PendingApproval[]> {
    const events = [...this.#sessions.values()]
      .filter((s) => sessionMatches(s.record, filter))
      .flatMap((s) => s.events);
    return pendingApprovalsFromEvents(events);
  }

  async createSnapshotRecord(
    input: CreateSnapshotRecordInput,
  ): Promise<SnapshotSummary> {
    const snapshot: SnapshotSummary = {
      snapshotId: input.snapshotId,
      workspaceId: input.workspaceId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.name ? { name: input.name } : {}),
      kind: input.kind,
      storagePath: input.storagePath,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      status: "available",
      createdAt: new Date().toISOString(),
    };
    this.#snapshots.set(snapshot.snapshotId, snapshot);
    return snapshot;
  }

  async listSnapshots(): Promise<SnapshotSummary[]> {
    return [...this.#snapshots.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async markSnapshotDeleted(snapshotId: string): Promise<void> {
    const snapshot = this.#snapshots.get(snapshotId);
    if (snapshot)
      this.#snapshots.set(snapshotId, { ...snapshot, status: "deleted" });
  }

  // Atomic: validates every event (P12 type check + protocol payload schema, §6.5)
  // before any mutation, mutates synchronously, then — strictly after the append —
  // invokes onCommitted listeners (§6.2).
  async appendEvents(input: AppendEventsInput): Promise<AppendEventsResult> {
    const state = this.#sessions.get(input.sessionId);
    if (!state) {
      throw new StoreError(
        "session_not_found",
        `unknown session ${input.sessionId}`,
      );
    }
    for (const e of input.events) {
      if (!Object.hasOwn(durableEventSchemas, e.type)) {
        throw new StoreError(
          "not_a_durable_event",
          `${e.type} is not a durable event type`,
        );
      }
      const schema =
        durableEventSchemas[e.type as keyof typeof durableEventSchemas];
      const parsed = schema.safeParse(e.payload);
      if (!parsed.success) {
        throw new StoreError(
          "invalid_payload",
          `${e.type}: ${parsed.error.message}`,
        );
      }
    }

    const now = new Date().toISOString();
    let seq = state.record.lastSeq;
    const events: AgenaEvent[] = input.events.map((e) => ({
      sessionId: input.sessionId,
      branchId: input.branchId,
      seq: ++seq,
      type: e.type,
      v: e.v,
      source: e.source,
      payload: e.payload,
      createdAt: now,
    }));
    state.events.push(...events);
    state.record.lastSeq = seq;
    state.record.updatedAt = now;
    for (const event of events) {
      if (event.type === "session.title.changed") {
        const title = (event.payload as { title?: unknown }).title;
        if (typeof title === "string") state.record.title = title;
      }
    }

    const batch = { sessionId: input.sessionId, events, lastSeq: seq };
    for (const listener of this.#listeners) {
      try {
        listener(batch);
      } catch (err) {
        // §6.2: a listener throwing can never un-commit anything
        console.error("[agena-core] onCommitted listener threw:", err);
      }
    }
    return { events, lastSeq: seq };
  }

  async readEvents(
    sessionId: string,
    fromSeq: number,
    limit?: number,
  ): Promise<ReadEventsPage> {
    const state = this.#sessions.get(sessionId);
    if (!state) {
      throw new StoreError("session_not_found", `unknown session ${sessionId}`);
    }
    // seq is contiguous from 1, so "seq > fromSeq" is a plain slice
    const events =
      limit === undefined
        ? state.events.slice(fromSeq)
        : state.events.slice(fromSeq, fromSeq + limit);
    const last = events.at(-1);
    const nextFromSeq =
      last !== undefined && last.seq < state.record.lastSeq ? last.seq : null;
    return { events, nextFromSeq };
  }

  onCommitted(listener: CommitListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

function sessionMatches(s: SessionRecord, filter: SessionFilter): boolean {
  if (!filter.includeControl && s.scope === "control") return false;
  if (!filter.includeArchived && s.status === "archived") return false;
  if (filter.status && s.status !== filter.status) return false;
  if (filter.allProjects) return true;
  if (filter.projectId) {
    return s.scope === "project" && s.projectId === filter.projectId;
  }
  if (filter.scope) return s.scope === filter.scope;
  return s.scope === "project";
}
