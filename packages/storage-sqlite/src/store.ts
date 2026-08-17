// SQLite-backed EventStore (§7.4/§7.5), first M2 slice: durable sessions,
// append tx, paged replay, and post-commit fanout behind the existing core port.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AppendEventsInput,
  AppendEventsResult,
  CreateDerivedSessionInput,
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
  latestCompletedAssistant,
  normalizeSessionScope,
  pendingApprovalsFromEvents,
  StoreError,
} from "@agena/core";
import type {
  AgenaEvent,
  AgentTaskCreated,
  AgentTaskSummary,
  CompactTranscriptEntry,
  CompactTranscriptQuery,
  CompactTranscriptResponse,
  CompactTranscriptTurn,
  CompactTranscriptUser,
  ContentBlock,
  EventSource,
  ImportLedgerEntry,
  McpSummary,
  SearchHit,
  SessionOrigin,
  SessionStatus,
  SkillSummary,
  SnapshotSummary,
  ToolCallDetail,
  UserMessageAnchor,
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
  origin: SessionOrigin;
  purpose: "quick_chat" | null;
  side_chat_access: "read_only" | "full" | null;
  parent_session_id: string | null;
  parent_task_id: string | null;
  session_kind: "primary" | "subagent";
  source_message_id: string | null;
  derived_mode: "fork" | "clone" | null;
};

type AgentTaskRow = {
  id: string;
  parent_session_id: string;
  child_session_id: string;
  parent_run_id: string;
  parent_message_id: string;
  parent_tool_call_id: string;
  role: string;
  task: string;
  execution: AgentTaskCreated["execution"];
  context_mode: AgentTaskCreated["context"];
  workspace_mode: AgentTaskCreated["workspaceMode"];
  requested_model: string | null;
  resolved_model: string;
  retry_of_task_id: string | null;
  status: AgentTaskSummary["status"];
  summary: string | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
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

type BranchRow = {
  id: string;
  parent_branch_id: string | null;
  forked_from_seq: number | null;
};

type ToolCallRow = {
  id: string;
  session_id: string;
  branch_id: string;
  message_id: string | null;
  name: string;
  args: string | null;
  result: string | null;
  status: ToolCallDetail["status"];
  started_seq: number;
  ended_seq: number | null;
  created_at: string;
};

type ImportRow = {
  id: string;
  session_id: string | null;
  project_id: string;
  machine_id: string;
  harness: ImportLedgerEntry["harness"];
  source_path: string;
  source_session_id: string | null;
  source_mtime_ms: number | null;
  source_size: number | null;
  imported_at: string;
};

type McpRow = {
  id: string;
  identity: string;
  name: string;
  transport: McpSummary["transport"];
  command: string | null;
  args: string | null;
  url: string | null;
  auth_kind: McpSummary["authKind"];
  status: McpSummary["status"];
  enabled: number;
  config: string;
  imported_at: string;
  updated_at: string;
};

type SkillRow = {
  id: string;
  identity: string;
  name: string;
  description: string | null;
  content_hash: string;
  source_url: string | null;
  source_path: string | null;
  source_revision: string | null;
  status: SkillSummary["status"];
  imported_at: string;
  updated_at: string;
};

export type McpRegistryRecord = McpSummary & {
  enabled: boolean;
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

export type CreateSubagentSessionInput = {
  parentSessionId: string;
  title?: string;
  source: EventSource;
  origin?: "import.claude" | "import.codex";
  task: Omit<AgentTaskCreated, "parentSessionId" | "childSessionId">;
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

function mcpFromRow(row: McpRow): McpRegistryRecord {
  const config = JSON.parse(row.config) as {
    env?: Record<string, string>;
    headers?: Record<string, string>;
  };
  return {
    id: row.id,
    identity: row.identity,
    name: row.name,
    transport: row.transport,
    ...(row.command ? { command: row.command } : {}),
    ...(row.args ? { args: JSON.parse(row.args) as string[] } : {}),
    ...(row.url ? { url: row.url } : {}),
    authKind: row.auth_kind,
    status: row.status,
    enabled: row.enabled === 1,
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
    ...(config.env && Object.keys(config.env).length
      ? { env: config.env }
      : {}),
    ...(config.headers && Object.keys(config.headers).length
      ? { headers: config.headers }
      : {}),
  };
}

function skillFromRow(row: SkillRow): SkillSummary {
  return {
    id: row.id,
    identity: row.identity,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    contentHash: row.content_hash,
    ...(row.source_url ? { sourceUrl: row.source_url } : {}),
    ...(row.source_path ? { sourcePath: row.source_path } : {}),
    ...(row.source_revision ? { sourceRevision: row.source_revision } : {}),
    status: row.status,
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteEventStore implements EventStore {
  #db: DatabaseSync;
  #blobDir: string;
  #listeners = new Set<CommitListener>();

  constructor(
    dbPath: string,
    blobDir = resolve(dirname(dbPath), "..", "blobs", "sha256"),
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#blobDir = blobDir;
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
        origin           TEXT NOT NULL DEFAULT 'native'
                         CHECK (origin IN ('native','import.claude','import.codex','control')),
        status           TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','idle','archived')),
        is_control       INTEGER NOT NULL DEFAULT 0,
        parent_session_id TEXT REFERENCES sessions(id),
        parent_task_id    TEXT,
        source_message_id TEXT,
        derived_mode      TEXT CHECK (derived_mode IN ('fork','clone')),
        purpose           TEXT CHECK (purpose IN ('quick_chat')),
        side_chat_access  TEXT CHECK (side_chat_access IN ('read_only','full')),
        session_kind      TEXT NOT NULL DEFAULT 'primary'
                          CHECK (session_kind IN ('primary','subagent'))
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

      CREATE TABLE IF NOT EXISTS runtime_message_refs (
        session_id       TEXT NOT NULL REFERENCES sessions(id),
        message_id       TEXT NOT NULL,
        runtime_entry_id TEXT NOT NULL,
        PRIMARY KEY (session_id, message_id)
      ) STRICT;

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

      CREATE TABLE IF NOT EXISTS agent_tasks (
        id                  TEXT PRIMARY KEY,
        parent_session_id   TEXT NOT NULL REFERENCES sessions(id),
        child_session_id    TEXT NOT NULL UNIQUE REFERENCES sessions(id),
        parent_run_id       TEXT NOT NULL,
        parent_message_id   TEXT NOT NULL,
        parent_tool_call_id TEXT NOT NULL,
        role                TEXT NOT NULL,
        task                TEXT NOT NULL,
        execution           TEXT NOT NULL CHECK (execution IN ('foreground','background')),
        context_mode        TEXT NOT NULL CHECK (context_mode IN ('fresh','fork')),
        workspace_mode      TEXT NOT NULL CHECK (workspace_mode IN ('shared_readonly','shared_serial_writer','isolated_worktree')),
        requested_model     TEXT CHECK (requested_model IS NULL OR json_valid(requested_model)),
        resolved_model      TEXT NOT NULL CHECK (json_valid(resolved_model)),
        retry_of_task_id    TEXT,
        status              TEXT NOT NULL CHECK (status IN ('created','running','completed','failed','cancelled')),
        summary             TEXT CHECK (summary IS NULL OR json_valid(summary)),
        error               TEXT CHECK (error IS NULL OR json_valid(error)),
        input_tokens        INTEGER,
        output_tokens       INTEGER,
        cost_usd            REAL,
        created_at          TEXT NOT NULL,
        started_at          TEXT,
        finished_at         TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent
        ON agent_tasks(parent_session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_status
        ON agent_tasks(status, created_at);

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

      CREATE TABLE IF NOT EXISTS imports (
        id                TEXT PRIMARY KEY,
        session_id        TEXT,
        project_id        TEXT NOT NULL,
        machine_id        TEXT NOT NULL,
        harness           TEXT NOT NULL CHECK (harness IN ('claude','codex','pi','files')),
        source_path       TEXT NOT NULL,
        source_session_id TEXT,
        source_mtime_ms   REAL,
        source_size       INTEGER,
        imported_at       TEXT NOT NULL,
        UNIQUE (machine_id, harness, source_session_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS mcps (
        id          TEXT PRIMARY KEY,
        identity    TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL UNIQUE,
        transport   TEXT NOT NULL CHECK (transport IN ('stdio','http','sse')),
        command     TEXT,
        args        TEXT CHECK (args IS NULL OR json_valid(args)),
        url         TEXT,
        auth_kind   TEXT NOT NULL CHECK (auth_kind IN ('none','oauth','api_key')),
        status      TEXT NOT NULL CHECK (status IN ('imported','needs_auth','connected','error')),
        enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
        config      TEXT NOT NULL CHECK (json_valid(config)),
        imported_at TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS skills (
        id              TEXT PRIMARY KEY,
        identity        TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL UNIQUE,
        description     TEXT,
        content_hash    TEXT NOT NULL,
        source_url      TEXT,
        source_path     TEXT,
        source_revision TEXT,
        status          TEXT NOT NULL CHECK (status IN ('ready','update_available','error')),
        imported_at     TEXT NOT NULL,
        updated_at      TEXT NOT NULL
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
    this.#migrateMcpColumns();
    this.#db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_scope
        ON sessions(scope, project_id, updated_at);
    `);
  }

  async putBlob(bytes: Uint8Array, mimeType: string) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const hash = `sha256:${digest}`;
    const dir = join(this.#blobDir, digest.slice(0, 2));
    const path = join(dir, digest);
    await mkdir(dir, { recursive: true });
    const temporary = `${path}.${ulid()}.tmp`;
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    this.#db
      .prepare(
        `INSERT INTO blobs (hash, size_bytes, mime, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`,
      )
      .run(hash, bytes.byteLength, mimeType, new Date().toISOString());
    return { blob: hash, sizeBytes: bytes.byteLength, mimeType };
  }

  async readBlob(hash: string) {
    const digest = hash.startsWith("sha256:") ? hash.slice(7) : "";
    if (!/^[0-9a-f]{64}$/.test(digest)) return null;
    const row = this.#db
      .prepare("SELECT mime FROM blobs WHERE hash = ?")
      .get(hash) as { mime: string | null } | undefined;
    if (!row) return null;
    try {
      return {
        bytes: new Uint8Array(
          await readFile(join(this.#blobDir, digest.slice(0, 2), digest)),
        ),
        ...(row.mime ? { mimeType: row.mime } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const scope = normalizeSessionScope(input);
    const origin =
      input.origin ?? (scope.scope === "control" ? "control" : "native");
    const record: SessionRecord = {
      sessionId: ulid(),
      workspaceId: input.workspaceId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      rootBranchId: ulid(),
      lastSeq: 1,
      createdAt: now,
      updatedAt: now,
      status: "active",
      origin,
      sessionKind: "primary",
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
        origin,
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
            host_cwd_hint, origin, status, is_control)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
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
          origin,
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

  async createDerivedSession(
    input: CreateDerivedSessionInput,
  ): Promise<SessionRecord> {
    const parent = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(input.parentSessionId) as SessionRow | undefined;
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
    if (input.sourceMessageId) {
      const source = this.#db
        .prepare(
          `SELECT 1 FROM events
           WHERE session_id = ?
             AND type IN ('message.user.created', 'message.assistant.completed')
             AND json_extract(payload, '$.messageId') = ?
           LIMIT 1`,
        )
        .get(input.parentSessionId, input.sourceMessageId);
      if (!source) {
        throw new StoreError(
          "invalid_payload",
          "sourceMessageId does not belong to parent session",
        );
      }
    }
    const now = new Date().toISOString();
    const sessionId = input.sessionId ?? ulid();
    const rootBranchId = ulid();
    const title = input.title ?? parent.title ?? undefined;
    const sideChatAccess =
      input.purpose === "quick_chat"
        ? (input.sideChatAccess ?? "read_only")
        : undefined;
    const derivedFrom = {
      parentSessionId: parent.id,
      ...(input.sourceMessageId
        ? { sourceMessageId: input.sourceMessageId }
        : {}),
      mode: input.mode,
    } as const;
    const session: SessionRecord = {
      sessionId,
      workspaceId: parent.workspace_id,
      ...(title ? { title } : {}),
      rootBranchId,
      ...(input.runtimeSessionRef
        ? { runtimeSessionRef: input.runtimeSessionRef }
        : {}),
      lastSeq: 1,
      createdAt: now,
      updatedAt: now,
      scope: parent.scope,
      status: "active",
      origin: parent.origin,
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(sideChatAccess ? { sideChatAccess } : {}),
      ...(parent.project_id ? { projectId: parent.project_id } : {}),
      ...(parent.project_root ? { projectRoot: parent.project_root } : {}),
      cwd: parent.cwd,
      ...(parent.host_cwd_hint ? { hostCwdHint: parent.host_cwd_hint } : {}),
      sessionKind: "primary",
      parentSessionId: parent.id,
      derivedFrom,
    };
    const event: AgenaEvent = {
      sessionId,
      branchId: rootBranchId,
      seq: 1,
      type: "session.created",
      v: 1,
      source: input.source ?? { kind: "user" },
      payload: {
        workspaceId: parent.workspace_id,
        ...(title ? { title } : {}),
        runtime: "pi",
        origin: parent.origin,
        scope: parent.scope,
        ...(parent.project_id ? { projectId: parent.project_id } : {}),
        ...(parent.project_root ? { projectRoot: parent.project_root } : {}),
        cwd: parent.cwd,
        ...(parent.host_cwd_hint ? { hostCwdHint: parent.host_cwd_hint } : {}),
        rootBranchId,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(sideChatAccess ? { sideChatAccess } : {}),
        derivedFrom,
      },
      createdAt: now,
    };
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO sessions
           (id, workspace_id, title, active_branch_id, last_seq, created_at,
            pi_session_path, updated_at, scope, project_id, project_root, cwd,
            host_cwd_hint, origin, status, is_control, parent_session_id, source_message_id,
            derived_mode, purpose, side_chat_access, session_kind)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?, 'primary')`,
        )
        .run(
          sessionId,
          parent.workspace_id,
          title ?? null,
          rootBranchId,
          now,
          input.runtimeSessionRef ?? null,
          now,
          parent.scope,
          parent.project_id,
          parent.project_root,
          parent.cwd,
          parent.host_cwd_hint,
          parent.origin,
          parent.id,
          input.sourceMessageId ?? null,
          input.mode,
          input.purpose ?? null,
          sideChatAccess ?? null,
        );
      this.#db
        .prepare(
          `INSERT INTO branches
           (id, session_id, parent_branch_id, forked_from_seq, name, created_at)
           VALUES (?, ?, NULL, NULL, NULL, ?)`,
        )
        .run(rootBranchId, sessionId, now);
      this.#insertEvent(event);
    });
    this.#emitCommitted({ sessionId, events: [event], lastSeq: 1 });
    return session;
  }

  async getRuntimeMessageRef(
    sessionId: string,
    messageId: string,
  ): Promise<string | null> {
    const row = this.#db
      .prepare(
        `SELECT runtime_entry_id FROM runtime_message_refs
         WHERE session_id = ? AND message_id = ?`,
      )
      .get(sessionId, messageId) as { runtime_entry_id: string } | undefined;
    return row?.runtime_entry_id ?? null;
  }

  async getLatestCompletedAssistant(sessionId: string) {
    const session = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    if (!session) return null;
    const branches = this.#activeBranchSegments(session.active_branch_id);
    const events = (
      this.#db
        .prepare(
          `SELECT * FROM events
         WHERE session_id = ?
           AND type IN ('message.user.created', 'message.assistant.started',
                        'message.assistant.completed')
         ORDER BY seq ASC`,
        )
        .all(sessionId) as EventRow[]
    )
      .filter((row) => {
        const upper = branches.get(row.branch_id);
        return upper !== undefined && (upper === null || row.seq <= upper);
      })
      .map(eventFromRow);
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

  async createSubagentSession(input: CreateSubagentSessionInput): Promise<{
    session: SessionRecord;
    task: AgentTaskSummary;
  }> {
    const parent = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(input.parentSessionId) as SessionRow | undefined;
    if (!parent) {
      throw new StoreError(
        "session_not_found",
        `unknown session ${input.parentSessionId}`,
      );
    }
    const now = new Date().toISOString();
    const origin = input.origin ?? "native";
    const childSessionId = ulid();
    const rootBranchId = ulid();
    const payload: AgentTaskCreated = {
      ...input.task,
      parentSessionId: parent.id,
      childSessionId,
    };
    validateNewEvent("agent.task.created", payload);
    const session: SessionRecord = {
      sessionId: childSessionId,
      workspaceId: parent.workspace_id,
      title: input.title ?? input.task.role,
      rootBranchId,
      lastSeq: 1,
      createdAt: now,
      updatedAt: now,
      scope: parent.scope,
      status: "active",
      origin,
      ...(parent.project_id ? { projectId: parent.project_id } : {}),
      ...(parent.project_root ? { projectRoot: parent.project_root } : {}),
      cwd: parent.cwd,
      ...(parent.host_cwd_hint ? { hostCwdHint: parent.host_cwd_hint } : {}),
      sessionKind: "subagent",
      parentSessionId: parent.id,
      parentTaskId: input.task.taskId,
    };
    const childEvent: AgenaEvent = {
      sessionId: childSessionId,
      branchId: rootBranchId,
      seq: 1,
      type: "session.created",
      v: 1,
      source: { kind: "daemon" },
      payload: {
        workspaceId: parent.workspace_id,
        title: session.title,
        runtime: "pi",
        origin,
        scope: parent.scope,
        ...(parent.project_id ? { projectId: parent.project_id } : {}),
        ...(parent.project_root ? { projectRoot: parent.project_root } : {}),
        cwd: parent.cwd,
        ...(parent.host_cwd_hint ? { hostCwdHint: parent.host_cwd_hint } : {}),
        rootBranchId,
      },
      createdAt: now,
    };
    const parentEvent: AgenaEvent = {
      sessionId: parent.id,
      branchId: parent.active_branch_id,
      seq: parent.last_seq + 1,
      type: "agent.task.created",
      v: 1,
      source: input.source,
      payload,
      createdAt: now,
    };
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO sessions
           (id, workspace_id, title, active_branch_id, last_seq, created_at,
            pi_session_path, updated_at, scope, project_id, project_root, cwd,
            host_cwd_hint, origin, status, is_control, parent_session_id, parent_task_id,
            session_kind)
           VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, 'subagent')`,
        )
        .run(
          childSessionId,
          parent.workspace_id,
          session.title ?? null,
          rootBranchId,
          now,
          now,
          parent.scope,
          parent.project_id,
          parent.project_root,
          parent.cwd,
          parent.host_cwd_hint,
          origin,
          parent.id,
          input.task.taskId,
        );
      this.#db
        .prepare(
          `INSERT INTO branches
           (id, session_id, parent_branch_id, forked_from_seq, name, created_at)
           VALUES (?, ?, NULL, NULL, NULL, ?)`,
        )
        .run(rootBranchId, childSessionId, now);
      this.#insertEvent(childEvent);
      this.#insertEvent(parentEvent);
      this.#applyProjection(parentEvent);
      this.#db
        .prepare(
          "UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?",
        )
        .run(parentEvent.seq, now, parent.id);
    });
    this.#emitCommitted({
      sessionId: childSessionId,
      events: [childEvent],
      lastSeq: 1,
    });
    this.#emitCommitted({
      sessionId: parent.id,
      events: [parentEvent],
      lastSeq: parentEvent.seq,
    });
    const task = this.getAgentTask(input.task.taskId);
    if (!task) throw new Error("agent task projection was not created");
    return { session, task };
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

  getAgentTask(taskId: string): AgentTaskSummary | null {
    const row = this.#db
      .prepare("SELECT * FROM agent_tasks WHERE id = ?")
      .get(taskId) as AgentTaskRow | undefined;
    return row ? agentTaskFromRow(row) : null;
  }

  listAgentTasks(parentSessionId?: string): AgentTaskSummary[] {
    const rows = (
      parentSessionId
        ? this.#db
            .prepare(
              `SELECT * FROM agent_tasks
               WHERE parent_session_id = ? ORDER BY created_at ASC`,
            )
            .all(parentSessionId)
        : this.#db
            .prepare("SELECT * FROM agent_tasks ORDER BY created_at ASC")
            .all()
    ) as AgentTaskRow[];
    return rows.map(agentTaskFromRow);
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

  async listUserMessages(sessionId: string): Promise<UserMessageAnchor[]> {
    const session = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    if (!session) {
      throw new StoreError("session_not_found", `unknown session ${sessionId}`);
    }
    const branches = this.#activeBranchSegments(session.active_branch_id);
    const rows = this.#db
      .prepare(
        `SELECT * FROM events
         WHERE session_id = ? AND type = 'message.user.created'
         ORDER BY seq ASC`,
      )
      .all(sessionId) as EventRow[];
    return activeUserEvents(
      rows
        .filter((row) => {
          const upper = branches.get(row.branch_id);
          return upper !== undefined && (upper === null || row.seq <= upper);
        })
        .map(eventFromRow),
    ).map((event) => {
      const payload = record(event.payload);
      return {
        messageId: stringField(payload, "messageId"),
        seq: event.seq,
        preview: extractSearchText(payload.content).slice(0, 320),
        createdAt: event.createdAt,
      };
    });
  }

  async readCompactTranscript(
    sessionId: string,
    query: CompactTranscriptQuery,
  ): Promise<CompactTranscriptResponse> {
    const session = this.#db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    if (!session) {
      throw new StoreError("session_not_found", `unknown session ${sessionId}`);
    }
    const branches = this.#activeBranchSegments(session.active_branch_id);
    const isActiveBranchEvent = (row: Pick<EventRow, "branch_id" | "seq">) => {
      const segment = branches.get(row.branch_id);
      return segment !== undefined && (segment === null || row.seq <= segment);
    };
    const userRows = (
      this.#db
        .prepare(
          `SELECT * FROM events
           WHERE session_id = ? AND type = 'message.user.created'
           ORDER BY seq ASC`,
        )
        .all(sessionId) as EventRow[]
    ).filter(isActiveBranchEvent);
    const activeUsers = activeUserEvents(userRows.map(eventFromRow));
    const anchorId = query.beforeMessageId ?? query.aroundMessageId;
    const anchorIndex = anchorId
      ? activeUsers.findIndex(
          (event) => record(event.payload).messageId === anchorId,
        )
      : -1;
    if (anchorId && anchorIndex < 0) {
      throw new StoreError(
        "invalid_payload",
        `unknown active user message ${anchorId}`,
      );
    }
    let start: number;
    let end: number;
    if (query.beforeMessageId) {
      end = anchorIndex;
      start = Math.max(0, end - query.limitTurns);
    } else if (query.aroundMessageId) {
      start = Math.max(0, anchorIndex - Math.floor(query.limitTurns / 2));
      end = Math.min(activeUsers.length, start + query.limitTurns);
      start = Math.max(0, end - query.limitTurns);
    } else {
      end = activeUsers.length;
      start = Math.max(0, end - query.limitTurns);
    }
    const selected = activeUsers.slice(start, end);
    if (selected.length === 0) {
      return {
        sessionId,
        branchId: session.active_branch_id,
        upToSeq: session.last_seq,
        turns: [],
        hasOlder: start > 0,
        hasNewer: end < activeUsers.length,
      };
    }
    const lowerSeq = selected[0]?.seq ?? 1;
    const upperSeq = activeUsers[end]?.seq
      ? (activeUsers[end]?.seq ?? session.last_seq + 1) - 1
      : session.last_seq;
    const windowRows = (
      this.#db
        .prepare(
          `SELECT session_id, branch_id, seq, type, v, source_kind,
                  source_runtime, source_client_id,
                  CASE
                    WHEN type = 'tool.call.completed'
                      THEN json_remove(payload, '$.result')
                    WHEN type IN ('tool.call.failed', 'tool.call.aborted')
                      THEN json_remove(payload, '$.partialOutput')
                    WHEN type = 'compaction.created'
                      THEN json_remove(payload, '$.summary')
                    ELSE payload
                  END AS payload,
                  created_at
           FROM events
           WHERE session_id = ? AND seq >= ? AND seq <= ?
             AND type IN (
               'message.user.created', 'message.assistant.started',
               'message.assistant.completed', 'message.assistant.aborted',
               'message.assistant.failed', 'message.runtime.created',
               'tool.call.started', 'tool.call.completed', 'tool.call.failed',
               'tool.call.aborted', 'tool.call.denied',
               'approval.requested', 'approval.responded', 'approval.expired',
               'approval.cancelled', 'model.changed',
               'thinking.level.changed', 'compaction.created',
               'compaction.failed', 'terminal.session.started',
               'terminal.session.ended', 'run.failed'
             )
           ORDER BY seq ASC`,
        )
        .all(sessionId, lowerSeq, upperSeq) as EventRow[]
    ).filter(isActiveBranchEvent);
    const selectedIds = selected.map((event) =>
      stringField(record(event.payload), "messageId"),
    );
    const associatedRows = this.#associatedTranscriptRows(
      sessionId,
      selectedIds,
      windowRows
        .filter((row) => row.type === "approval.requested")
        .map((row) =>
          stringField(record(eventFromRow(row).payload), "approvalId"),
        ),
    ).filter(isActiveBranchEvent);
    const rows = [
      ...new Map(
        [...windowRows, ...associatedRows].map((row) => [row.seq, row]),
      ).values(),
    ].sort((a, b) => a.seq - b.seq);
    return {
      sessionId,
      branchId: session.active_branch_id,
      upToSeq: session.last_seq,
      turns: compactTurns(selected, rows.map(eventFromRow)),
      hasOlder: start > 0,
      hasNewer: end < activeUsers.length,
    };
  }

  async getToolCallDetail(
    sessionId: string,
    toolCallId: string,
  ): Promise<ToolCallDetail | null> {
    const row = this.#db
      .prepare(`SELECT * FROM tool_calls WHERE session_id = ? AND id = ?`)
      .get(sessionId, toolCallId) as ToolCallRow | undefined;
    if (!row) return null;
    return {
      toolCallId: row.id,
      sessionId: row.session_id,
      branchId: row.branch_id,
      ...(row.message_id ? { messageId: row.message_id } : {}),
      name: row.name,
      args: row.args === null ? null : (JSON.parse(row.args) as unknown),
      ...(row.result === null
        ? {}
        : { result: JSON.parse(row.result) as unknown }),
      status: row.status,
      startedSeq: row.started_seq,
      ...(row.ended_seq === null ? {} : { endedSeq: row.ended_seq }),
      createdAt: row.created_at,
    };
  }

  #activeBranchSegments(branchId: string): Map<string, number | null> {
    const segments = new Map<string, number | null>();
    let currentId: string | null = branchId;
    let upper: number | null = null;
    while (currentId) {
      const row = this.#db
        .prepare(
          "SELECT id, parent_branch_id, forked_from_seq FROM branches WHERE id = ?",
        )
        .get(currentId) as BranchRow | undefined;
      if (!row) break;
      segments.set(row.id, upper);
      upper = row.forked_from_seq;
      currentId = row.parent_branch_id;
    }
    return segments;
  }

  #associatedTranscriptRows(
    sessionId: string,
    userMessageIds: string[],
    windowApprovalIds: string[],
  ): EventRow[] {
    const byPayloadIds = (
      types: string[],
      jsonPath: string,
      ids: string[],
    ): EventRow[] => {
      if (ids.length === 0) return [];
      const typeSlots = types.map(() => "?").join(", ");
      const idSlots = ids.map(() => "?").join(", ");
      return this.#db
        .prepare(
          `SELECT session_id, branch_id, seq, type, v, source_kind,
                  source_runtime, source_client_id,
                  CASE
                    WHEN type = 'tool.call.completed'
                      THEN json_remove(payload, '$.result')
                    WHEN type IN ('tool.call.failed', 'tool.call.aborted')
                      THEN json_remove(payload, '$.partialOutput')
                    ELSE payload
                  END AS payload,
                  created_at
           FROM events
           WHERE session_id = ? AND type IN (${typeSlots})
             AND json_extract(payload, ?) IN (${idSlots})`,
        )
        .all(sessionId, ...types, jsonPath, ...ids) as EventRow[];
    };
    const assistantStarts = byPayloadIds(
      ["message.assistant.started"],
      "$.inResponseTo",
      userMessageIds,
    );
    const assistantIds = assistantStarts.map((row) =>
      stringField(record(eventFromRow(row).payload), "messageId"),
    );
    const assistantEnds = byPayloadIds(
      [
        "message.assistant.completed",
        "message.assistant.aborted",
        "message.assistant.failed",
      ],
      "$.messageId",
      assistantIds,
    );
    const toolStarts = byPayloadIds(
      ["tool.call.started"],
      "$.messageId",
      assistantIds,
    );
    const toolIds = toolStarts.map((row) =>
      stringField(record(eventFromRow(row).payload), "toolCallId"),
    );
    const toolEnds = byPayloadIds(
      [
        "tool.call.completed",
        "tool.call.failed",
        "tool.call.aborted",
        "tool.call.denied",
      ],
      "$.toolCallId",
      toolIds,
    );
    const approvalStarts = byPayloadIds(
      ["approval.requested"],
      "$.toolCallId",
      toolIds,
    );
    const approvalIds = approvalStarts.map((row) =>
      stringField(record(eventFromRow(row).payload), "approvalId"),
    );
    const approvalEnds = byPayloadIds(
      ["approval.responded", "approval.expired", "approval.cancelled"],
      "$.approvalId",
      [...new Set([...approvalIds, ...windowApprovalIds])],
    );
    const runFailures = byPayloadIds(
      ["run.failed"],
      "$.triggerMessageId",
      userMessageIds,
    );
    return [
      ...assistantStarts,
      ...assistantEnds,
      ...toolStarts,
      ...toolEnds,
      ...approvalStarts,
      ...approvalEnds,
      ...runFailures,
    ];
  }

  insertImport(
    entry: Omit<ImportLedgerEntry, "id" | "importedAt">,
  ): ImportLedgerEntry {
    const id = ulid();
    const importedAt = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO imports
         (id, session_id, project_id, machine_id, harness, source_path,
          source_session_id, source_mtime_ms, source_size, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.sessionId ?? null,
        entry.projectId,
        entry.machineId,
        entry.harness,
        entry.sourcePath,
        entry.sourceSessionId ?? null,
        entry.sourceMtimeMs ?? null,
        entry.sourceSize ?? null,
        importedAt,
      );
    return { ...entry, id, importedAt };
  }

  findImport(
    machineId: string,
    harness: string,
    sourceSessionId: string,
  ): ImportLedgerEntry | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM imports
         WHERE machine_id = ? AND harness = ? AND source_session_id = ?`,
      )
      .get(machineId, harness, sourceSessionId) as ImportRow | undefined;
    return row ? importFromRow(row) : null;
  }

  listImports(machineId?: string): ImportLedgerEntry[] {
    const rows = (
      machineId === undefined
        ? this.#db.prepare("SELECT * FROM imports ORDER BY id ASC").all()
        : this.#db
            .prepare(
              "SELECT * FROM imports WHERE machine_id = ? ORDER BY id ASC",
            )
            .all(machineId)
    ) as ImportRow[];
    return rows.map(importFromRow);
  }

  upsertMcp(
    input: Omit<
      McpRegistryRecord,
      "id" | "importedAt" | "updatedAt" | "enabled"
    > & { enabled?: boolean },
  ): McpRegistryRecord {
    const existing = this.#db
      .prepare("SELECT id, imported_at FROM mcps WHERE identity = ?")
      .get(input.identity) as { id: string; imported_at: string } | undefined;
    const id = existing?.id ?? ulid();
    const now = new Date().toISOString();
    const importedAt = existing?.imported_at ?? now;
    const config = JSON.stringify({
      env: input.env ?? {},
      headers: input.headers ?? {},
    });
    this.#db
      .prepare(`INSERT INTO mcps
      (id,identity,name,transport,command,args,url,auth_kind,status,enabled,config,imported_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(identity) DO UPDATE SET name=excluded.name,transport=excluded.transport,command=excluded.command,
      args=excluded.args,url=excluded.url,auth_kind=excluded.auth_kind,status=excluded.status,enabled=excluded.enabled,
      config=excluded.config,updated_at=excluded.updated_at`)
      .run(
        id,
        input.identity,
        input.name,
        input.transport,
        input.command ?? null,
        input.args ? JSON.stringify(input.args) : null,
        input.url ?? null,
        input.authKind,
        input.status,
        input.enabled === false ? 0 : 1,
        config,
        importedAt,
        now,
      );
    const record = this.getMcp(id);
    if (!record) throw new Error("failed to persist MCP registry record");
    return record;
  }

  getMcp(id: string): McpRegistryRecord | null {
    const row = this.#db.prepare("SELECT * FROM mcps WHERE id = ?").get(id) as
      | McpRow
      | undefined;
    return row ? mcpFromRow(row) : null;
  }

  listMcps(): McpRegistryRecord[] {
    return (
      this.#db
        .prepare("SELECT * FROM mcps ORDER BY name COLLATE NOCASE")
        .all() as McpRow[]
    ).map(mcpFromRow);
  }

  setMcpStatus(
    id: string,
    status: McpSummary["status"],
  ): McpRegistryRecord | null {
    this.#db
      .prepare("UPDATE mcps SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
    return this.getMcp(id);
  }

  setMcpEnabled(id: string, enabled: boolean): McpRegistryRecord | null {
    this.#db
      .prepare("UPDATE mcps SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
    return this.getMcp(id);
  }

  deleteMcp(id: string): boolean {
    return (
      this.#db.prepare("DELETE FROM mcps WHERE id = ?").run(id).changes > 0
    );
  }

  upsertSkill(
    input: Omit<SkillSummary, "id" | "importedAt" | "updatedAt">,
  ): SkillSummary {
    const existing = this.#db
      .prepare("SELECT id, imported_at FROM skills WHERE identity = ?")
      .get(input.identity) as { id: string; imported_at: string } | undefined;
    const id =
      existing?.id ??
      `skill_${createHash("sha256").update(input.identity).digest("hex").slice(0, 24)}`;
    const now = new Date().toISOString();
    const importedAt = existing?.imported_at ?? now;
    this.#db
      .prepare(`INSERT INTO skills
      (id,identity,name,description,content_hash,source_url,source_path,source_revision,status,imported_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(identity) DO UPDATE SET name=excluded.name,description=excluded.description,
      content_hash=excluded.content_hash,source_url=excluded.source_url,
      source_path=excluded.source_path,source_revision=excluded.source_revision,
      status=excluded.status,updated_at=excluded.updated_at`)
      .run(
        id,
        input.identity,
        input.name,
        input.description ?? null,
        input.contentHash,
        input.sourceUrl ?? null,
        input.sourcePath ?? null,
        input.sourceRevision ?? null,
        input.status,
        importedAt,
        now,
      );
    const skill = this.getSkill(id);
    if (!skill) throw new Error("failed to persist skill registry record");
    return skill;
  }

  getSkill(id: string): SkillSummary | null {
    const row = this.#db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as
      | SkillRow
      | undefined;
    return row ? skillFromRow(row) : null;
  }

  listSkills(): SkillSummary[] {
    return (
      this.#db
        .prepare("SELECT * FROM skills ORDER BY name COLLATE NOCASE")
        .all() as SkillRow[]
    ).map(skillFromRow);
  }

  setSkillStatus(
    id: string,
    status: SkillSummary["status"],
  ): SkillSummary | null {
    this.#db
      .prepare("UPDATE skills SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), id);
    return this.getSkill(id);
  }

  /**
   * Full-teardown of a project: every row referencing it, in one tx. Returns
   * what the caller must remove from the filesystem (pi JSONLs, snapshot
   * archives, the workspace root) — null when the project doesn't exist.
   */
  deleteProject(projectId: string): {
    root: string;
    sessionIds: string[];
    piSessionPaths: string[];
    snapshotPaths: string[];
  } | null {
    const project = this.#db
      .prepare("SELECT root FROM projects WHERE id = ?")
      .get(projectId) as { root: string } | undefined;
    if (!project) return null;
    const sessions = this.#db
      .prepare("SELECT id, pi_session_path FROM sessions WHERE project_id = ?")
      .all(projectId) as { id: string; pi_session_path: string | null }[];
    const sessionIds = sessions.map((s) => s.id);
    const ph = sessionIds.map(() => "?").join(",");
    const snapshots = sessionIds.length
      ? (this.#db
          .prepare(
            `SELECT storage_path FROM snapshots WHERE session_id IN (${ph})`,
          )
          .all(...sessionIds) as { storage_path: string }[])
      : [];
    this.#transaction(() => {
      if (sessionIds.length) {
        this.#db
          .prepare(
            `DELETE FROM agent_tasks
             WHERE parent_session_id IN (${ph}) OR child_session_id IN (${ph})`,
          )
          .run(...sessionIds, ...sessionIds);
        for (const table of [
          "events",
          "runtime_message_refs",
          "messages",
          "tool_calls",
          "messages_fts",
          "branches",
          "snapshots",
        ]) {
          this.#db
            .prepare(`DELETE FROM ${table} WHERE session_id IN (${ph})`)
            .run(...sessionIds);
        }
        this.#db
          .prepare(`DELETE FROM sessions WHERE id IN (${ph})`)
          .run(...sessionIds);
      }
      this.#db
        .prepare("DELETE FROM imports WHERE project_id = ?")
        .run(projectId);
      this.#db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    });
    return {
      root: project.root,
      sessionIds,
      piSessionPaths: sessions
        .map((s) => s.pi_session_path)
        .filter((p): p is string => p !== null),
      snapshotPaths: snapshots.map((s) => s.storage_path),
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
          .prepare("DELETE FROM runtime_message_refs WHERE session_id = ?")
          .run(sessionId);
        this.#db
          .prepare("DELETE FROM tool_calls WHERE session_id = ?")
          .run(sessionId);
        this.#db
          .prepare("DELETE FROM messages_fts WHERE session_id = ?")
          .run(sessionId);
        this.#db
          .prepare("DELETE FROM agent_tasks WHERE parent_session_id = ?")
          .run(sessionId);
      } else {
        this.#db.prepare("DELETE FROM messages").run();
        this.#db.prepare("DELETE FROM runtime_message_refs").run();
        this.#db.prepare("DELETE FROM tool_calls").run();
        this.#db.prepare("DELETE FROM messages_fts").run();
        this.#db.prepare("DELETE FROM agent_tasks").run();
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
    add(
      "origin",
      "origin TEXT NOT NULL DEFAULT 'native' CHECK (origin IN ('native','import.claude','import.codex','control'))",
    );
    add("pi_session_path", "pi_session_path TEXT");
    add("parent_session_id", "parent_session_id TEXT REFERENCES sessions(id)");
    add("parent_task_id", "parent_task_id TEXT");
    add("source_message_id", "source_message_id TEXT");
    add(
      "derived_mode",
      "derived_mode TEXT CHECK (derived_mode IN ('fork','clone'))",
    );
    add("purpose", "purpose TEXT CHECK (purpose IN ('quick_chat'))");
    add(
      "side_chat_access",
      "side_chat_access TEXT CHECK (side_chat_access IN ('read_only','full'))",
    );
    add(
      "session_kind",
      "session_kind TEXT NOT NULL DEFAULT 'primary' CHECK (session_kind IN ('primary','subagent'))",
    );
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
    this.#db
      .prepare(
        "UPDATE sessions SET side_chat_access = 'read_only' WHERE purpose = 'quick_chat' AND side_chat_access IS NULL",
      )
      .run();
    this.#db
      .prepare(
        `UPDATE sessions
         SET origin = COALESCE(
           (SELECT json_extract(payload, '$.origin')
            FROM events
            WHERE events.session_id = sessions.id
              AND events.type = 'session.created'
            ORDER BY seq ASC
            LIMIT 1),
           CASE WHEN scope = 'control' THEN 'control' ELSE 'native' END
         )`,
      )
      .run();
  }

  #migrateMcpColumns(): void {
    const columns = new Set(
      (
        this.#db.prepare("PRAGMA table_info(mcps)").all() as TableColumnRow[]
      ).map((column) => column.name),
    );
    if (!columns.has("identity")) {
      this.#db.exec("ALTER TABLE mcps ADD COLUMN identity TEXT");
      this.#db.exec(
        "UPDATE mcps SET identity = CASE WHEN url IS NOT NULL THEN 'remote:' || rtrim(url, '/') ELSE 'legacy:' || id END",
      );
      this.#db.exec("CREATE UNIQUE INDEX idx_mcps_identity ON mcps(identity)");
    }
    if (!columns.has("enabled"))
      this.#db.exec(
        "ALTER TABLE mcps ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1))",
      );
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
      case "message.runtime.ref":
        this.#db
          .prepare(
            `INSERT OR REPLACE INTO runtime_message_refs
             (session_id, message_id, runtime_entry_id) VALUES (?, ?, ?)`,
          )
          .run(
            event.sessionId,
            stringField(p, "messageId"),
            stringField(p, "runtimeEntryId"),
          );
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
      case "agent.task.created":
        this.#db
          .prepare(
            `INSERT INTO agent_tasks
             (id, parent_session_id, child_session_id, parent_run_id,
              parent_message_id, parent_tool_call_id, role, task, execution,
              context_mode, workspace_mode, requested_model, resolved_model,
              retry_of_task_id, status, summary, error, input_tokens,
              output_tokens, cost_usd, created_at, started_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created',
                     NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL)`,
          )
          .run(
            stringField(p, "taskId"),
            stringField(p, "parentSessionId"),
            stringField(p, "childSessionId"),
            stringField(p, "parentRunId"),
            stringField(p, "parentMessageId"),
            stringField(p, "parentToolCallId"),
            stringField(p, "role"),
            stringField(p, "task"),
            stringField(p, "execution"),
            stringField(p, "context"),
            stringField(p, "workspaceMode"),
            p.requestedModel ? JSON.stringify(p.requestedModel) : null,
            JSON.stringify(p.resolvedModel),
            typeof p.retryOfTaskId === "string" ? p.retryOfTaskId : null,
            event.createdAt,
          );
        return;
      case "agent.task.started":
        this.#db
          .prepare(
            "UPDATE agent_tasks SET status = 'running', started_at = ? WHERE id = ?",
          )
          .run(stringField(p, "startedAt"), stringField(p, "taskId"));
        return;
      case "agent.task.completed": {
        const usage = record(p.usage);
        this.#db
          .prepare(
            `UPDATE agent_tasks SET status = 'completed', summary = ?, error = NULL,
             input_tokens = ?, output_tokens = ?, cost_usd = ?, finished_at = ?
             WHERE id = ?`,
          )
          .run(
            JSON.stringify(p.summary ?? []),
            optionalNumberField(usage, "inputTokens"),
            optionalNumberField(usage, "outputTokens"),
            optionalNumberField(usage, "costUsd"),
            event.createdAt,
            stringField(p, "taskId"),
          );
        return;
      }
      case "agent.task.failed":
        this.#finishAgentTask(event, "failed", p.summary, p.error);
        return;
      case "agent.task.cancelled":
        this.#finishAgentTask(event, "cancelled", undefined, {
          code: "cancelled",
          message: stringField(p, "reason"),
        });
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

  #finishAgentTask(
    event: AgenaEvent,
    status: "failed" | "cancelled",
    summary: unknown,
    error: unknown,
  ): void {
    const p = record(event.payload);
    this.#db
      .prepare(
        `UPDATE agent_tasks
         SET status = ?, summary = ?, error = ?, finished_at = ? WHERE id = ?`,
      )
      .run(
        status,
        summary === undefined ? null : JSON.stringify(summary),
        JSON.stringify(error),
        event.createdAt,
        stringField(p, "taskId"),
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
    origin: row.origin,
    ...(row.purpose !== null ? { purpose: row.purpose } : {}),
    ...(row.side_chat_access !== null
      ? { sideChatAccess: row.side_chat_access }
      : {}),
    sessionKind: row.session_kind,
    ...(row.parent_session_id !== null
      ? { parentSessionId: row.parent_session_id }
      : {}),
    ...(row.parent_task_id !== null
      ? { parentTaskId: row.parent_task_id }
      : {}),
    ...(row.derived_mode !== null && row.parent_session_id !== null
      ? {
          derivedFrom: {
            parentSessionId: row.parent_session_id,
            ...(row.source_message_id !== null
              ? { sourceMessageId: row.source_message_id }
              : {}),
            mode: row.derived_mode,
          },
        }
      : {}),
  };
}

function agentTaskFromRow(row: AgentTaskRow): AgentTaskSummary {
  return {
    taskId: row.id,
    parentSessionId: row.parent_session_id,
    childSessionId: row.child_session_id,
    parentRunId: row.parent_run_id,
    parentMessageId: row.parent_message_id,
    parentToolCallId: row.parent_tool_call_id,
    role: row.role,
    task: row.task,
    execution: row.execution,
    context: row.context_mode,
    workspaceMode: row.workspace_mode,
    ...(row.requested_model
      ? { requestedModel: JSON.parse(row.requested_model) }
      : {}),
    resolvedModel: JSON.parse(row.resolved_model),
    ...(row.retry_of_task_id ? { retryOfTaskId: row.retry_of_task_id } : {}),
    status: row.status,
    ...(row.summary ? { summary: JSON.parse(row.summary) } : {}),
    ...(row.error ? { error: JSON.parse(row.error) } : {}),
    ...(row.input_tokens !== null && row.output_tokens !== null
      ? {
          usage: {
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}),
          },
        }
      : {}),
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  } as AgentTaskSummary;
}

function importFromRow(row: ImportRow): ImportLedgerEntry {
  return {
    id: row.id,
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    projectId: row.project_id,
    machineId: row.machine_id,
    harness: row.harness,
    sourcePath: row.source_path,
    ...(row.source_session_id !== null
      ? { sourceSessionId: row.source_session_id }
      : {}),
    ...(row.source_mtime_ms !== null
      ? { sourceMtimeMs: row.source_mtime_ms }
      : {}),
    ...(row.source_size !== null ? { sourceSize: row.source_size } : {}),
    importedAt: row.imported_at,
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

function activeUserEvents(events: AgenaEvent[]): AgenaEvent[] {
  const users = events.map((event) => {
    const payload = record(event.payload);
    return {
      event,
      messageId: stringField(payload, "messageId"),
      editedFromMessageId:
        typeof payload.editedFromMessageId === "string"
          ? payload.editedFromMessageId
          : undefined,
    };
  });
  if (!users.some((user) => user.editedFromMessageId)) return events;
  const byId = new Map(users.map((user) => [user.messageId, user]));
  const previous = new Map<string, string | undefined>();
  for (let index = 0; index < users.length; index += 1) {
    previous.set(users[index]?.messageId ?? "", users[index - 1]?.messageId);
  }
  const active = new Set<string>();
  let current = users.at(-1);
  while (current && !active.has(current.messageId)) {
    active.add(current.messageId);
    const parentId = current.editedFromMessageId
      ? previous.get(current.editedFromMessageId)
      : previous.get(current.messageId);
    current = parentId ? byId.get(parentId) : undefined;
  }
  return users
    .filter((user) => active.has(user.messageId))
    .map((user) => user.event);
}

function compactTurns(
  selectedUsers: AgenaEvent[],
  events: AgenaEvent[],
): CompactTranscriptTurn[] {
  type AssistantEntry = Extract<CompactTranscriptEntry, { kind: "assistant" }>;
  type ToolEntry = Extract<CompactTranscriptEntry, { kind: "tool" }>;
  type ApprovalEntry = Extract<CompactTranscriptEntry, { kind: "approval" }>;
  const turns = new Map<string, CompactTranscriptTurn>();
  for (const event of selectedUsers) {
    const payload = record(event.payload);
    const messageId = stringField(payload, "messageId");
    const user: CompactTranscriptUser = {
      ...compactBase(event),
      kind: "user",
      messageId,
      content: payload.content as ContentBlock[],
      ...(payload.queued === "steer" || payload.queued === "followUp"
        ? { queued: payload.queued }
        : {}),
      ...(typeof payload.editedFromMessageId === "string"
        ? { editedFromMessageId: payload.editedFromMessageId }
        : {}),
    };
    turns.set(messageId, { user, entries: [] });
  }
  const assistantUsers = new Map<string, string>();
  const assistantModels = new Map<string, AssistantEntry["model"]>();
  const toolUsers = new Map<string, string>();
  const toolEntries = new Map<string, ToolEntry>();
  const approvalEntries = new Map<string, ApprovalEntry>();
  let currentUserId: string | undefined;
  const append = (
    userId: string | undefined,
    entry: CompactTranscriptEntry,
  ) => {
    if (userId) turns.get(userId)?.entries.push(entry);
  };
  for (const event of events) {
    const payload = record(event.payload);
    if (event.type === "message.user.created") {
      currentUserId = stringField(payload, "messageId");
      continue;
    }
    if (event.type === "message.assistant.started") {
      const messageId = stringField(payload, "messageId");
      assistantUsers.set(messageId, stringField(payload, "inResponseTo"));
      assistantModels.set(messageId, payload.model as AssistantEntry["model"]);
      continue;
    }
    if (
      event.type === "message.assistant.completed" ||
      event.type === "message.assistant.aborted" ||
      event.type === "message.assistant.failed"
    ) {
      const messageId = stringField(payload, "messageId");
      const shared = {
        ...compactBase(event),
        kind: "assistant" as const,
        messageId,
      };
      const entry: AssistantEntry =
        event.type === "message.assistant.completed"
          ? {
              ...shared,
              content: payload.content as ContentBlock[],
              model: payload.model as AssistantEntry["model"],
              status: "completed",
              stopReason: payload.stopReason as AssistantEntry["stopReason"],
              ...(payload.usage
                ? {
                    usage: payload.usage as NonNullable<
                      AssistantEntry["usage"]
                    >,
                  }
                : {}),
            }
          : event.type === "message.assistant.aborted"
            ? {
                ...shared,
                content: payload.partialContent as ContentBlock[],
                status: "aborted",
                abortReason: payload.reason as NonNullable<
                  AssistantEntry["abortReason"]
                >,
                ...(assistantModels.get(messageId)
                  ? { model: assistantModels.get(messageId) }
                  : {}),
              }
            : {
                ...shared,
                content: payload.partialContent as ContentBlock[],
                status: "failed",
                error: payload.error as NonNullable<AssistantEntry["error"]>,
                ...(assistantModels.get(messageId)
                  ? { model: assistantModels.get(messageId) }
                  : {}),
              };
      const userId = assistantUsers.get(messageId) ?? currentUserId;
      if (userId && !assistantUsers.has(messageId)) {
        assistantUsers.set(messageId, userId);
      }
      append(userId, entry);
      continue;
    }
    if (event.type === "message.runtime.created") {
      append(currentUserId, {
        ...compactBase(event),
        kind: "runtime",
        messageId: stringField(payload, "messageId"),
        runtimeType: payload.runtimeType as
          | "custom"
          | "bash"
          | "branch-summary",
        content: payload.content as ContentBlock[],
        ...(payload.meta
          ? {
              meta: payload.meta as NonNullable<
                Extract<CompactTranscriptEntry, { kind: "runtime" }>["meta"]
              >,
            }
          : {}),
      });
      continue;
    }
    if (event.type === "tool.call.started") {
      const toolCallId = stringField(payload, "toolCallId");
      const messageId = stringField(payload, "messageId");
      const userId = assistantUsers.get(messageId);
      const entry: ToolEntry = {
        ...compactBase(event),
        kind: "tool",
        toolCallId,
        messageId,
        name: stringField(payload, "name"),
        argsPreview: previewValue(payload.args),
        status: "running",
        hasDetails: true,
      };
      toolUsers.set(toolCallId, userId ?? "");
      toolEntries.set(toolCallId, entry);
      append(userId, entry);
      continue;
    }
    if (event.type.startsWith("tool.call.")) {
      const toolCallId = stringField(payload, "toolCallId");
      const entry = toolEntries.get(toolCallId);
      if (!entry) continue;
      if (event.type === "tool.call.completed") {
        entry.status = "completed";
        entry.durationMs = payload.durationMs as number;
      } else if (event.type === "tool.call.failed") {
        entry.status = "failed";
        entry.error = payload.error as NonNullable<ToolEntry["error"]>;
        if (typeof payload.durationMs === "number") {
          entry.durationMs = payload.durationMs;
        }
      } else if (event.type === "tool.call.aborted") {
        entry.status = "aborted";
        entry.abortReason = String(payload.reason ?? "runtime_error");
      } else if (event.type === "tool.call.denied") {
        entry.status = "denied";
        entry.deniedReason = String(payload.reason ?? "policy");
        if (typeof payload.approvalId === "string") {
          entry.approvalId = payload.approvalId;
        }
      }
      continue;
    }
    if (event.type === "approval.requested") {
      const approvalId = stringField(payload, "approvalId");
      const entry: ApprovalEntry = {
        ...compactBase(event),
        kind: "approval",
        approvalId,
        request: payload as ApprovalEntry["request"],
        state: "pending",
      };
      approvalEntries.set(approvalId, entry);
      const toolCallId =
        typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
      append(toolCallId ? toolUsers.get(toolCallId) : currentUserId, entry);
      continue;
    }
    if (event.type.startsWith("approval.")) {
      const approvalId = stringField(payload, "approvalId");
      const entry = approvalEntries.get(approvalId);
      if (!entry) continue;
      if (event.type === "approval.responded") {
        entry.state = "responded";
        entry.response = payload.response as NonNullable<
          ApprovalEntry["response"]
        >;
        entry.respondedBy = stringField(payload, "respondedBy");
      } else if (event.type === "approval.expired") {
        entry.state = "expired";
      } else if (event.type === "approval.cancelled") {
        entry.state = "cancelled";
        entry.cancelReason = String(payload.reason ?? "runtime_cancelled");
      }
      continue;
    }
    const marker = compactMarker(event, payload);
    if (marker) {
      const userId =
        event.type === "run.failed" &&
        typeof payload.triggerMessageId === "string"
          ? payload.triggerMessageId
          : currentUserId;
      append(userId, marker);
    }
  }
  return [...turns.values()].map((turn) => ({
    ...turn,
    entries: turn.entries.sort((a, b) => a.seq - b.seq),
  }));
}

function compactBase(event: AgenaEvent) {
  return { seq: event.seq, at: event.createdAt, source: event.source };
}

function compactMarker(
  event: AgenaEvent,
  payload: Record<string, unknown>,
): CompactTranscriptEntry | null {
  const base = { ...compactBase(event), kind: "marker" as const };
  switch (event.type) {
    case "model.changed": {
      const to = record(payload.to);
      return {
        ...base,
        markerKind: "model",
        text: `model → ${String(to.provider)}/${String(to.id)}`,
      };
    }
    case "thinking.level.changed":
      return {
        ...base,
        markerKind: "thinking",
        text: `thinking → ${String(payload.to)}`,
      };
    case "compaction.created":
      return {
        ...base,
        markerKind: "compaction",
        text: `compacted history up to seq ${String(payload.replacesUpToSeq)}`,
      };
    case "compaction.failed":
      return {
        ...base,
        markerKind: "compaction-failed",
        text: `compaction failed: ${String(record(payload.error).code)}`,
      };
    case "terminal.session.started":
      return {
        ...base,
        markerKind: "terminal-start",
        text: `terminal opened (${String(payload.shell)})`,
      };
    case "terminal.session.ended":
      return {
        ...base,
        markerKind: "terminal-end",
        text: `terminal closed${payload.exitCode === null ? "" : ` (exit ${String(payload.exitCode)})`}`,
      };
    case "run.failed":
      return {
        ...base,
        markerKind: "run-failed",
        text: `run failed${payload.phase ? ` at ${String(payload.phase)}` : ""}: ${String(record(payload.error).code)}`,
      };
    default:
      return null;
  }
}

function previewValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return (json ?? String(value)).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new StoreError("invalid_payload", `${key} must be a string`);
  }
  return value;
}

function optionalNumberField(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = payload[key];
  return typeof value === "number" ? value : null;
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
