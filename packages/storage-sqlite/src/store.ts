// SQLite-backed EventStore (§7.4/§7.5), first M2 slice: durable sessions,
// append tx, paged replay, and post-commit fanout behind the existing core port.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AppendEventsInput,
  AppendEventsResult,
  CreateSessionInput,
  CreateSnapshotRecordInput,
  EventStore,
  NewEvent,
  PendingApproval,
  ReadEventsPage,
  RebuildReport,
  ReconcileReport,
  SessionFilter,
  SessionRecord,
} from "@agena/core";
import {
  extractSearchText,
  normalizeSessionScope,
  pendingApprovalsFromEvents,
  StoreError,
} from "@agena/core";
import type {
  AgenaEvent,
  EventSource,
  SearchHit,
  SessionStatus,
  SnapshotSummary,
} from "@agena/protocol";
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
  pi_session_path: string | null;
  last_seq: number;
  created_at: string;
  updated_at: string;
  scope: SessionRecord["scope"];
  status: SessionStatus;
  project_id: string | null;
  project_root: string | null;
  cwd: string;
  host_cwd_hint: string | null;
};

type SnapshotRow = {
  id: string;
  workspace_id: string;
  session_id: string | null;
  name: string | null;
  kind: SnapshotSummary["kind"];
  storage_path: string;
  sha256: string;
  size_bytes: number;
  status: SnapshotSummary["status"];
  created_at: string;
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
type TableColumnRow = { name: string };
type SearchRow = {
  session_id: string;
  message_id: string | null;
  snippet: string;
  rank: number;
  seq: number | null;
};

export class SqliteEventStore implements EventStore {
  #db: DatabaseSync;
  #listeners = new Set<CommitListener>();

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new DatabaseSync(dbPath);
    // WAL sidecar files are fragile on Docker bind mounts when host tools
    // inspect the DB live; Agena has one writer, so rollback journaling stays
    // the local default. Replicated deployments (Litestream on Modal) REQUIRE
    // WAL — they opt in via AGENA_SQLITE_JOURNAL=wal.
    const wal = process.env.AGENA_SQLITE_JOURNAL === "wal";
    this.#db.exec(`
      PRAGMA journal_mode = ${wal ? "WAL" : "DELETE"};
      ${wal ? "PRAGMA busy_timeout = 5000;" : ""}
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS sessions (
        id               TEXT PRIMARY KEY,
        workspace_id     TEXT NOT NULL,
        title            TEXT,
        active_branch_id TEXT NOT NULL,
        pi_session_path  TEXT,
        last_seq         INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        scope            TEXT NOT NULL DEFAULT 'project'
                         CHECK (scope IN ('project','global','control')),
        project_id       TEXT,
        project_root     TEXT,
        cwd              TEXT NOT NULL DEFAULT '.',
        host_cwd_hint    TEXT,
        status           TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','idle','archived')),
        is_control       INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS projects (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        root         TEXT NOT NULL,
        name         TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
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

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        session_id UNINDEXED,
        branch_id UNINDEXED,
        message_id UNINDEXED,
        tokenize = 'unicode61 tokenchars ''_-.'''
      );

      CREATE TABLE IF NOT EXISTS blobs (
        hash       TEXT PRIMARY KEY,
        size_bytes INTEGER NOT NULL,
        mime       TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS snapshots (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id   TEXT,
        name         TEXT,
        kind         TEXT NOT NULL CHECK (kind IN ('manual','auto','pre_tool','pre_restore')),
        storage_path TEXT NOT NULL,
        sha256       TEXT NOT NULL,
        size_bytes   INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','deleted')),
        created_at   TEXT NOT NULL
      ) STRICT;
    `);
    this.#migrateSessionColumns();
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_scope
        ON sessions(scope, project_id, updated_at);
    `);
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const scope = normalizeSessionScope(input);
    const record: SessionRecord = {
      sessionId: ulid(),
      workspaceId: input.workspaceId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      rootBranchId: ulid(),
      lastSeq: 1,
      createdAt: now,
      updatedAt: now,
      status: "active",
      ...scope,
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
        origin: scope.scope === "control" ? "control" : "native",
        ...scope,
        rootBranchId: record.rootBranchId,
      },
      createdAt: now,
    };
    this.#transaction(() => {
      if (scope.scope === "project") {
        const projectId = scope.projectId;
        const projectRoot = scope.projectRoot;
        if (!projectId || !projectRoot) {
          throw new StoreError(
            "invalid_payload",
            "project scope is incomplete",
          );
        }
        this.#db
          .prepare(
            `INSERT OR IGNORE INTO projects (id, workspace_id, root, name, created_at, updated_at)
             VALUES (?, ?, ?, NULL, ?, ?)`,
          )
          .run(projectId, input.workspaceId, projectRoot, now, now);
      }
      this.#db
        .prepare(
          `INSERT INTO sessions
           (id, workspace_id, title, active_branch_id, last_seq, created_at,
            pi_session_path, updated_at, scope, project_id, project_root, cwd,
            host_cwd_hint, status, is_control)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          record.sessionId,
          record.workspaceId,
          record.title ?? null,
          record.rootBranchId,
          now,
          null,
          now,
          scope.scope,
          scope.projectId ?? null,
          scope.projectRoot ?? null,
          scope.cwd,
          scope.hostCwdHint ?? null,
          scope.scope === "control" ? 1 : 0,
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

  async listSessions(filter: SessionFilter = {}): Promise<SessionRecord[]> {
    const { where, params } = sessionWhere(filter);
    const rows = this.#db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY id DESC`)
      .all(...params) as SessionRow[];
    return rows.map(sessionFromRow);
  }

  async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const result = this.#db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, sessionId);
    if (result.changes === 0) {
      throw new StoreError("session_not_found", `unknown session ${sessionId}`);
    }
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new StoreError("session_not_found", `unknown session ${sessionId}`);
    }
    return session;
  }

  async updateRuntimeSessionRef(
    sessionId: string,
    runtimeSessionRef: string,
  ): Promise<SessionRecord> {
    const result = this.#db
      .prepare("UPDATE sessions SET pi_session_path = ? WHERE id = ?")
      .run(runtimeSessionRef, sessionId);
    if (result.changes === 0) {
      throw new StoreError("session_not_found", `unknown session ${sessionId}`);
    }
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new StoreError("session_not_found", `unknown session ${sessionId}`);
    }
    return session;
  }

  async listPendingApprovals(
    filter: SessionFilter = {},
  ): Promise<PendingApproval[]> {
    const sessions = await this.listSessions(filter);
    const events = sessions.flatMap(
      (session) =>
        this.#db
          .prepare(
            `SELECT * FROM events
             WHERE session_id = ?
             ORDER BY seq ASC`,
          )
          .all(session.sessionId) as EventRow[],
    );
    return pendingApprovalsFromEvents(events.map(eventFromRow));
  }

  async createSnapshotRecord(
    input: CreateSnapshotRecordInput,
  ): Promise<SnapshotSummary> {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO snapshots
         (id, workspace_id, session_id, name, kind, storage_path, sha256,
          size_bytes, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)`,
      )
      .run(
        input.snapshotId,
        input.workspaceId,
        input.sessionId ?? null,
        input.name ?? null,
        input.kind,
        input.storagePath,
        input.sha256,
        input.sizeBytes,
        now,
      );
    return snapshotFromRow(
      this.#db
        .prepare("SELECT * FROM snapshots WHERE id = ?")
        .get(input.snapshotId) as SnapshotRow,
    );
  }

  async listSnapshots(): Promise<SnapshotSummary[]> {
    const rows = this.#db
      .prepare("SELECT * FROM snapshots ORDER BY created_at DESC")
      .all() as SnapshotRow[];
    return rows.map(snapshotFromRow);
  }

  async markSnapshotDeleted(snapshotId: string): Promise<void> {
    this.#db
      .prepare("UPDATE snapshots SET status = 'deleted' WHERE id = ?")
      .run(snapshotId);
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

  async search(
    query: string,
    opts: {
      sessionId?: string;
      projectId?: string;
      allProjects?: boolean;
      limit?: number;
    } = {},
  ): Promise<SearchHit[]> {
    const limit = opts.limit ?? 20;
    if (query.trim() === "") return [];
    const fts = ftsQuery(query);
    const { where, params } = searchSessionFilter(opts);
    const rows = this.#db
      .prepare(
        `SELECT messages_fts.session_id, messages_fts.message_id,
                snippet(messages_fts, 0, '[', ']', '...', 12) AS snippet,
                bm25(messages_fts) AS rank,
                m.seq
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.message_id
         JOIN sessions s ON s.id = messages_fts.session_id
         WHERE messages_fts MATCH ? ${where}
         UNION ALL
         SELECT s.id AS session_id, NULL AS message_id, s.title AS snippet,
                0 AS rank, NULL AS seq
         FROM sessions s
         WHERE s.title IS NOT NULL
           AND lower(s.title) LIKE lower(?) ${where}
         ORDER BY rank ASC, seq DESC
         LIMIT ?`,
      )
      .all(fts, ...params, `%${query}%`, ...params, limit) as SearchRow[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      ...(row.message_id ? { messageId: row.message_id } : {}),
      snippet: row.snippet,
      rank: row.rank,
      ...(row.seq !== null ? { seq: row.seq } : {}),
    }));
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
        this.#db
          .prepare("DELETE FROM messages_fts WHERE session_id = ?")
          .run(sessionId);
      } else {
        this.#db.prepare("DELETE FROM messages").run();
        this.#db.prepare("DELETE FROM tool_calls").run();
        this.#db.prepare("DELETE FROM messages_fts").run();
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
    this.#db.close();
  }

  #migrateSessionColumns(): void {
    const columns = new Set(
      (
        this.#db
          .prepare("PRAGMA table_info(sessions)")
          .all() as TableColumnRow[]
      ).map((c) => c.name),
    );
    const add = (name: string, ddl: string) => {
      if (!columns.has(name))
        this.#db.exec(`ALTER TABLE sessions ADD COLUMN ${ddl}`);
    };
    add(
      "scope",
      "scope TEXT NOT NULL DEFAULT 'project' CHECK (scope IN ('project','global','control'))",
    );
    add("project_id", "project_id TEXT");
    add("project_root", "project_root TEXT");
    add("cwd", "cwd TEXT NOT NULL DEFAULT '.'");
    add("host_cwd_hint", "host_cwd_hint TEXT");
    add("pi_session_path", "pi_session_path TEXT");
    add(
      "status",
      "status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','idle','archived'))",
    );
    add("is_control", "is_control INTEGER NOT NULL DEFAULT 0");
    this.#db
      .prepare(
        `UPDATE sessions
         SET project_id = COALESCE(project_id, 'default'),
             project_root = COALESCE(project_root, '.'),
             cwd = COALESCE(cwd, '.')
         WHERE scope = 'project'`,
      )
      .run();
    this.#db
      .prepare("UPDATE sessions SET is_control = 1 WHERE scope = 'control'")
      .run();
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
      case "session.created":
        this.#db
          .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
          .run(
            typeof p.title === "string" ? p.title : null,
            event.createdAt,
            event.sessionId,
          );
        return;
      case "session.title.changed":
        this.#db
          .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
          .run(stringField(p, "title"), event.createdAt, event.sessionId);
        return;
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
    const messageId = stringField(p, "messageId");
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO messages
         (id, session_id, branch_id, seq, role, model, status, error, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        messageId,
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
    const searchText = extractSearchText(content);
    if (searchText !== "") {
      this.#db
        .prepare(
          `INSERT INTO messages_fts (content, session_id, branch_id, message_id)
           VALUES (?, ?, ?, ?)`,
        )
        .run(searchText, event.sessionId, event.branchId, messageId);
    }
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
    ...(row.pi_session_path !== null
      ? { runtimeSessionRef: row.pi_session_path }
      : {}),
    lastSeq: row.last_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scope: row.scope,
    status: row.status,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    ...(row.project_root !== null ? { projectRoot: row.project_root } : {}),
    cwd: row.cwd,
    ...(row.host_cwd_hint !== null ? { hostCwdHint: row.host_cwd_hint } : {}),
  };
}

function snapshotFromRow(row: SnapshotRow): SnapshotSummary {
  return {
    snapshotId: row.id,
    workspaceId: row.workspace_id,
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(row.name !== null ? { name: row.name } : {}),
    kind: row.kind,
    storagePath: row.storage_path,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    status: row.status,
    createdAt: row.created_at,
  };
}

function sessionWhere(filter: SessionFilter): {
  where: string;
  params: string[];
} {
  if (filter.allProjects) {
    const clauses = [];
    if (!filter.includeControl) clauses.push("scope != 'control'");
    if (!filter.includeArchived) clauses.push("status != 'archived'");
    if (filter.status) clauses.push("status = ?");
    return {
      where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
      params: filter.status ? [filter.status] : [],
    };
  }
  const statusClause = [
    !filter.includeArchived ? "status != 'archived'" : "",
    filter.status ? "status = ?" : "",
  ].filter(Boolean);
  const statusParams = filter.status ? [filter.status] : [];
  if (filter.projectId) {
    return {
      where: [
        "WHERE scope = 'project' AND project_id = ?",
        ...statusClause.map((c) => `AND ${c}`),
      ].join(" "),
      params: [filter.projectId, ...statusParams],
    };
  }
  if (filter.scope) {
    return {
      where: ["WHERE scope = ?", ...statusClause.map((c) => `AND ${c}`)].join(
        " ",
      ),
      params: [filter.scope, ...statusParams],
    };
  }
  return {
    where: [
      "WHERE scope = 'project'",
      ...statusClause.map((c) => `AND ${c}`),
    ].join(" "),
    params: statusParams,
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

function searchSessionFilter(opts: {
  sessionId?: string;
  projectId?: string;
  allProjects?: boolean;
}): { where: string; params: string[] } {
  const clauses = ["s.status != 'archived'", "s.scope != 'control'"];
  const params: string[] = [];
  if (opts.sessionId) {
    clauses.push("s.id = ?");
    params.push(opts.sessionId);
  } else if (!opts.allProjects && opts.projectId) {
    clauses.push("s.scope = 'project'", "s.project_id = ?");
    params.push(opts.projectId);
  }
  return { where: `AND ${clauses.join(" AND ")}`, params };
}

function ftsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" ");
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
  const approvals = new Map<string, { branchId: string }>();
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
      case "approval.requested":
        approvals.set(stringField(p, "approvalId"), {
          branchId: event.branchId,
        });
        break;
      case "approval.responded":
      case "approval.expired":
      case "approval.cancelled":
        approvals.delete(stringField(p, "approvalId"));
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
    ...[...approvals.keys()].map(
      (approvalId): NewEvent => ({
        type: "approval.cancelled",
        v: 1,
        source,
        payload: {
          approvalId,
          reason: "daemon_restart",
        },
      }),
    ),
  ];
}
