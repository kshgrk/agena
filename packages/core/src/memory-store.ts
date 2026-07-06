// InMemoryEventStore (§7.4, §3.2): the M1 production store AND the permanent
// test double (P8/P16). Daemon-lifetime only — a restart loses history, by design.

import type { AgenaEvent } from "@agena/protocol";
import { durableEventSchemas } from "@agena/protocol";
import { ulid } from "ulid";
import {
  type AppendEventsInput,
  type AppendEventsResult,
  type CreateSessionInput,
  type EventStore,
  type ReadEventsPage,
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
  #listeners = new Set<CommitListener>();

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      sessionId: ulid(),
      workspaceId: input.workspaceId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      rootBranchId: ulid(),
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
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
            origin: "native",
            rootBranchId: record.rootBranchId,
          },
        },
      ],
    });
    return record;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.#sessions.get(sessionId)?.record ?? null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.#sessions.values()].map((s) => s.record);
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
