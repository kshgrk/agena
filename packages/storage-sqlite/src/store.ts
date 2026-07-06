// SQLite-backed EventStore (§7.4/§7.5), first M2 slice: durable sessions,
// append tx, paged replay, and post-commit fanout behind the existing core port.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AppendEventsInput,
  AppendEventsResult,
  CreateSessionInput,
  EventStore,
  NewEvent,
  ReadEventsPage,
  RebuildReport,
  ReconcileReport,
  SessionRecord,
} from "@agena/core";
import { StoreError } from "@agena/core";
import type { AgenaEvent, EventSource } from "@agena/protocol";
import { durableEventSchemas } from "@agena/protocol";
import { ulid } from "ulid";

type CommitListener = (
  batch: AppendEventsResult & { sessionId: string },
) => void;

type SessionRow = {
  id: string;
  workspace_id: string;
  title: string | null;
  active_branch_id: string;
  last_seq: number;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  session_id: string;
  branch_id: string;
  seq: number;
  type: string;
  v: number;
  source_kind: EventSource["kind"];
  source_runtime: string | null;
  source_client_id: string | null;
  payload: string;
  created_at: string;
};

type CountRow = { count: number };

export class SqliteEventStore implements EventStore {
  #db: DatabaseSync;
  #listeners = new Set<CommitListener>();

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS sessions (
        id               TEXT PRIMARY KEY,
        workspace_id     TEXT NOT NULL,
        title            TEXT,
        active_branch_id TEXT NOT NULL,
        last_seq         INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS branches (
        id               TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL REFERENCES sessions(id),
        parent_branch_id TEXT REFERENCES branches(id),
        forked_from_seq  INTEGER,
        name             TEXT,
        created_at       TEXT NOT NULL,
        CHECK ((parent_branch_id IS NULL) = (forked_from_seq IS NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_branches_session ON branches(session_id);

      CREATE TABLE IF NOT EXISTS events (
        session_id       TEXT    NOT NULL REFERENCES sessions(id),
        seq              INTEGER NOT NULL,
        id               TEXT    NOT NULL,
        branch_id        TEXT    NOT NULL REFERENCES branches(id),
        type             TEXT    NOT NULL,
        v                INTEGER NOT NULL DEFAULT 1,
        source_kind      TEXT    NOT NULL,
        source_runtime   TEXT,
        source_client_id TEXT,
        payload          TEXT    NOT NULL CHECK (json_valid(payload)),
        created_at       TEXT    NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_id ON events(id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type, seq);
      CREATE INDEX IF NOT EXISTS idx_events_branch ON events(session_id, branch_id, seq);

      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        branch_id  TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('user','assistant','runtime')),
        model      TEXT,
        status     TEXT NOT NULL DEFAULT 'completed'
                   CHECK (status IN ('completed','aborted','failed')),
        error      TEXT CHECK (error IS NULL OR json_valid(error)),
        content    TEXT NOT NULL CHECK (json_valid(content)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_id, branch_id, seq);

      CREATE TABLE IF NOT EXISTS tool_calls (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        branch_id   TEXT NOT NULL,
        message_id  TEXT,
        name        TEXT NOT NULL,
        args        TEXT CHECK (args IS NULL OR json_valid(args)),
        result      TEXT CHECK (result IS NULL OR json_valid(result)),
        status      TEXT NOT NULL
                   CHECK (status IN ('running','ok','error','aborted','denied')),
        started_seq INTEGER NOT NULL,
        ended_seq   INTEGER,
        created_at  TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_tool_calls_session
        ON tool_calls(session_id, branch_id, started_seq);

      CREATE TABLE IF NOT EXISTS blobs (
        hash       TEXT PRIMARY KEY,
        size_bytes INTEGER NOT NULL,
        mime       TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      sessionId: ulid(),
      workspaceId: input.workspaceId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      rootBranchId: ulid(),
      lastSeq: 1,
      createdAt: now,
      updatedAt: now,
    };
    const event: AgenaEvent = {
      sessionId: record.sessionId,
      branchId: record.rootBranchId,
      seq: 1,
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
      createdAt: now,
    };
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO sessions
           (id, workspace_id, title, active_branch_id, last_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          record.sessionId,
          record.workspaceId,
          record.title ?? null,
          record.rootBranchId,
          now,
          now,
        );
      this.#db
        .prepare(
          `INSERT INTO branches
           (id, session_id, parent_branch_id, forked_from_seq, name, created_at)
           VALUES (?, ?, NULL, NULL, NULL, ?)`,
        )
        .run(record.rootBranchId, record.sessionId, now);
      this.#insertEvent(event);
    });
    this.#emitCommitted({
      sessionId: record.sessionId,
      events: [event],
      lastSeq: 1,
    });
    return record;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const row = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row ? sessionFromRow(row) : null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const rows = this.#db
      .prepare("SELECT * FROM sessions ORDER BY id DESC")
      .all() as SessionRow[];
    return rows.map(sessionFromRow);
  }

  async appendEvents(input: AppendEventsInput): Promise<AppendEventsResult> {
    for (const e of input.events) validateNewEvent(e.type, e.payload);

    const now = new Date().toISOString();
    let committed: AgenaEvent[] = [];
    let lastSeq = 0;
    this.#transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get(input.sessionId) as SessionRow | undefined;
      if (!row) {
        throw new StoreError(
          "session_not_found",
          `unknown session ${input.sessionId}`,
        );
      }
      let seq = row.last_seq;
      committed = input.events.map((e) => ({
        sessionId: input.sessionId,
        branchId: input.branchId,
        seq: ++seq,
        type: e.type,
        v: e.v,
        source: e.source,
        payload: e.payload,
        createdAt: now,
      }));
      for (const event of committed) {
        this.#insertEvent(event);
        this.#applyProjection(event);
      }
      this.#db
        .prepare(
          "UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?",
        )
        .run(seq, now, input.sessionId);
      lastSeq = seq;
    });

    const batch = { sessionId: input.sessionId, events: committed, lastSeq };
    this.#emitCommitted(batch);
    return { events: committed, lastSeq };
  }

  async readEvents(
    sessionId: string,
    fromSeq: number,
    limit?: number,
  ): Promise<ReadEventsPage> {
    const row = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    if (!row) {
      throw new StoreError("session_not_found", `unknown session ${sessionId}`);
    }
    const pageLimit = limit ?? row.last_seq;
    const rows = this.#db
      .prepare(
        `SELECT * FROM events
         WHERE session_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(sessionId, fromSeq, pageLimit) as EventRow[];
    const events = rows.map(eventFromRow);
    const last = events.at(-1);
    return {
      events,
      nextFromSeq:
        last !== undefined && last.seq < row.last_seq ? last.seq : null,
    };
  }

  onCommitted(listener: CommitListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async rebuildProjections(sessionId?: string): Promise<RebuildReport> {
    let report: RebuildReport = {
      sessions: 0,
      events: 0,
      messages: 0,
      toolCalls: 0,
    };
    this.#transaction(() => {
      if (sessionId) {
        this.#db
          .prepare("DELETE FROM messages WHERE session_id = ?")
          .run(sessionId);
        this.#db
          .prepare("DELETE FROM tool_calls WHERE session_id = ?")
          .run(sessionId);
      } else {
        this.#db.prepare("DELETE FROM messages").run();
        this.#db.prepare("DELETE FROM tool_calls").run();
      }
      const rows = (
        sessionId
          ? this.#db
              .prepare(
                `SELECT * FROM events
                 WHERE session_id = ?
                 ORDER BY session_id ASC, seq ASC`,
              )
              .all(sessionId)
          : this.#db
              .prepare(
                `SELECT * FROM events
                 ORDER BY session_id ASC, seq ASC`,
              )
              .all()
      ) as EventRow[];
      for (const row of rows) this.#applyProjection(eventFromRow(row));
      report = this.#projectionReport(sessionId, rows.length);
    });
    return report;
  }

  async reconcileOpenWork(): Promise<ReconcileReport> {
    let appended = 0;
    const sessions = await this.listSessions();
    for (const session of sessions) {
      const rows = this.#db
        .prepare(
          `SELECT * FROM events
           WHERE session_id = ?
           ORDER BY seq ASC`,
        )
        .all(session.sessionId) as EventRow[];
      const events = openWork(rows.map(eventFromRow));
      if (events.length === 0) continue;
      const result = await this.appendEvents({
        sessionId: session.sessionId,
        branchId: session.rootBranchId,
        events,
      });
      appended += result.events.length;
    }
    return { sessions: sessions.length, appended };
  }

  close(): void {
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.#db.close();
  }

  #transaction(fn: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  #insertEvent(event: AgenaEvent): void {
    this.#db
      .prepare(
        `INSERT INTO events
         (session_id, seq, id, branch_id, type, v, source_kind, source_runtime,
          source_client_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.sessionId,
        event.seq,
        ulid(),
        event.branchId,
        event.type,
        event.v,
        event.source.kind,
        event.source.runtime ?? null,
        event.source.clientId ?? null,
        JSON.stringify(event.payload),
        event.createdAt,
      );
  }

  #applyProjection(event: AgenaEvent): void {
    const p = record(event.payload);
    switch (event.type) {
      case "message.user.created":
        this.#insertMessage(event, "user", "completed", p.content, null, null);
        return;
      case "message.runtime.created":
        this.#insertMessage(
          event,
          "runtime",
          "completed",
          p.content,
          null,
          null,
        );
        return;
      case "message.assistant.completed":
        this.#insertMessage(
          event,
          "assistant",
          "completed",
          p.content,
          p.model,
          null,
        );
        return;
      case "message.assistant.aborted":
        this.#insertMessage(
          event,
          "assistant",
          "aborted",
          p.partialContent,
          null,
          null,
        );
        return;
      case "message.assistant.failed":
        this.#insertMessage(
          event,
          "assistant",
          "failed",
          p.partialContent,
          null,
          p.error,
        );
        return;
      case "tool.call.started":
        this.#db
          .prepare(
            `INSERT OR REPLACE INTO tool_calls
             (id, session_id, branch_id, message_id, name, args, result, status,
              started_seq, ended_seq, created_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, 'running', ?, NULL, ?)`,
          )
          .run(
            stringField(p, "toolCallId"),
            event.sessionId,
            event.branchId,
            stringField(p, "messageId"),
            stringField(p, "name"),
            JSON.stringify(p.args ?? null),
            event.seq,
            event.createdAt,
          );
        return;
      case "tool.call.completed":
        this.#finishToolCall(event, "ok", p.result);
        return;
      case "tool.call.failed":
        this.#finishToolCall(event, "error", p.error);
        return;
      case "tool.call.aborted":
        this.#finishToolCall(event, "aborted", p.partialOutput);
        return;
      case "tool.call.denied":
        this.#finishToolCall(event, "denied", { reason: p.reason });
        return;
      default:
        return;
    }
  }

  #insertMessage(
    event: AgenaEvent,
    role: "user" | "assistant" | "runtime",
    status: "completed" | "aborted" | "failed",
    content: unknown,
    model: unknown,
    error: unknown,
  ): void {
    const p = record(event.payload);
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO messages
         (id, session_id, branch_id, seq, role, model, status, error, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stringField(p, "messageId"),
        event.sessionId,
        event.branchId,
        event.seq,
        role,
        model === null ? null : JSON.stringify(model),
        status,
        error === null ? null : JSON.stringify(error),
        JSON.stringify(content ?? []),
        event.createdAt,
      );
  }

  #finishToolCall(
    event: AgenaEvent,
    status: "ok" | "error" | "aborted" | "denied",
    result: unknown,
  ): void {
    const p = record(event.payload);
    this.#db
      .prepare(
        `UPDATE tool_calls
         SET status = ?, result = ?, ended_seq = ?
         WHERE id = ?`,
      )
      .run(
        status,
        JSON.stringify(result ?? null),
        event.seq,
        stringField(p, "toolCallId"),
      );
  }

  #projectionReport(
    sessionId: string | undefined,
    eventCount: number,
  ): RebuildReport {
    const sessions =
      sessionId === undefined
        ? (
            this.#db
              .prepare("SELECT COUNT(*) AS count FROM sessions")
              .get() as CountRow
          ).count
        : 1;
    const messages = countProjection(this.#db, "messages", sessionId);
    const toolCalls = countProjection(this.#db, "tool_calls", sessionId);
    return { sessions, events: eventCount, messages, toolCalls };
  }

  #emitCommitted(batch: AppendEventsResult & { sessionId: string }): void {
    for (const listener of this.#listeners) {
      try {
        listener(batch);
      } catch (err) {
        console.error(
          "[agena-storage-sqlite] onCommitted listener threw:",
          err,
        );
      }
    }
  }
}

function validateNewEvent(type: string, payload: unknown): void {
  if (!Object.hasOwn(durableEventSchemas, type)) {
    throw new StoreError(
      "not_a_durable_event",
      `${type} is not a durable event type`,
    );
  }
  const schema = durableEventSchemas[type as keyof typeof durableEventSchemas];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new StoreError("invalid_payload", `${type}: ${parsed.error.message}`);
  }
}

function sessionFromRow(row: SessionRow): SessionRecord {
  return {
    sessionId: row.id,
    workspaceId: row.workspace_id,
    ...(row.title !== null ? { title: row.title } : {}),
    rootBranchId: row.active_branch_id,
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row: EventRow): AgenaEvent {
  return {
    sessionId: row.session_id,
    branchId: row.branch_id,
    seq: row.seq,
    type: row.type,
    v: row.v,
    source: {
      kind: row.source_kind,
      ...(row.source_runtime === "pi" ? { runtime: "pi" as const } : {}),
      ...(row.source_client_id !== null
        ? { clientId: row.source_client_id }
        : {}),
    },
    payload: JSON.parse(row.payload) as unknown,
    createdAt: row.created_at,
  };
}

function countProjection(
  db: DatabaseSync,
  table: "messages" | "tool_calls",
  sessionId: string | undefined,
): number {
  return sessionId === undefined
    ? (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow)
        .count
    : (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`,
          )
          .get(sessionId) as CountRow
      ).count;
}

function record(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new StoreError("invalid_payload", `${key} must be a string`);
  }
  return value;
}

function openWork(events: AgenaEvent[]): NewEvent[] {
  const runs = new Map<string, { branchId: string }>();
  const messages = new Map<string, { branchId: string }>();
  const tools = new Map<string, { branchId: string }>();
  const terminals = new Map<string, { branchId: string }>();
  for (const event of events) {
    const p = record(event.payload);
    switch (event.type) {
      case "run.started":
        runs.set(stringField(p, "runId"), { branchId: event.branchId });
        break;
      case "run.completed":
      case "run.aborted":
      case "run.failed":
        runs.delete(stringField(p, "runId"));
        break;
      case "message.assistant.started":
        messages.set(stringField(p, "messageId"), { branchId: event.branchId });
        break;
      case "message.assistant.completed":
      case "message.assistant.aborted":
      case "message.assistant.failed":
        messages.delete(stringField(p, "messageId"));
        break;
      case "tool.call.started":
        tools.set(stringField(p, "toolCallId"), { branchId: event.branchId });
        break;
      case "tool.call.completed":
      case "tool.call.failed":
      case "tool.call.aborted":
      case "tool.call.denied":
        tools.delete(stringField(p, "toolCallId"));
        break;
      case "terminal.session.started":
        terminals.set(stringField(p, "terminalId"), {
          branchId: event.branchId,
        });
        break;
      case "terminal.session.ended":
        terminals.delete(stringField(p, "terminalId"));
        break;
    }
  }
  const source = { kind: "daemon" } as const;
  return [
    ...[...messages.keys()].map(
      (messageId): NewEvent => ({
        type: "message.assistant.failed",
        v: 1,
        source,
        payload: {
          messageId,
          partialContent: [],
          error: {
            code: "daemon_restart",
            message: "daemon restarted before the assistant message completed",
          },
          recovered: true,
        },
      }),
    ),
    ...[...tools.keys()].map(
      (toolCallId): NewEvent => ({
        type: "tool.call.aborted",
        v: 1,
        source,
        payload: {
          toolCallId,
          partialOutput: [],
          reason: "daemon_restart",
        },
      }),
    ),
    ...[...runs.keys()].map(
      (runId): NewEvent => ({
        type: "run.failed",
        v: 1,
        source,
        payload: {
          runId,
          phase: "recovery",
          error: {
            code: "daemon_restart",
            message: "daemon restarted before the run completed",
          },
        },
      }),
    ),
    ...[...terminals.keys()].map(
      (terminalId): NewEvent => ({
        type: "terminal.session.ended",
        v: 1,
        source,
        payload: {
          terminalId,
          exitCode: null,
          reason: "daemon_restart",
        },
      }),
    ),
  ];
}
