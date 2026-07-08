import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NewEvent } from "@agena/core";
import type { EventSource } from "@agena/protocol";
import { ulid } from "ulid";
import { afterEach, expect, test } from "vitest";
import { SqliteEventStore } from "../src/store.ts";

const dirs: string[] = [];
const user: EventSource = { kind: "user" };
const userMessage = (text: string): NewEvent => ({
  type: "message.user.created",
  v: 1,
  source: user,
  payload: { messageId: ulid(), content: [{ type: "text", text }] },
});
const runtime: EventSource = { kind: "runtime" };
const pi: EventSource = { kind: "runtime", runtime: "pi" };
const approvalRequest = (approvalId = ulid()): NewEvent => ({
  type: "approval.requested",
  v: 1,
  source: pi,
  payload: { approvalId, kind: "confirm", message: "Continue?" },
});

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agena-sqlite-"));
  dirs.push(dir);
  return join(dir, "agena.db");
}

function journalModeWith(env: string | undefined): string {
  const prev = process.env.AGENA_SQLITE_JOURNAL;
  if (env === undefined) delete process.env.AGENA_SQLITE_JOURNAL;
  else process.env.AGENA_SQLITE_JOURNAL = env;
  try {
    const path = dbPath();
    new SqliteEventStore(path).close();
    const db = new DatabaseSync(path);
    const row = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    db.close();
    return row.journal_mode;
  } finally {
    if (prev === undefined) delete process.env.AGENA_SQLITE_JOURNAL;
    else process.env.AGENA_SQLITE_JOURNAL = prev;
  }
}

test("uses rollback journal by default so live local inspection does not depend on WAL sidecars", () => {
  expect(journalModeWith(undefined)).toBe("delete");
});

test("AGENA_SQLITE_JOURNAL=wal opts into WAL for replicated deployments (Litestream)", () => {
  expect(journalModeWith("wal")).toBe("wal");
});

test("persists sessions and events across store reopen", async () => {
  const path = dbPath();
  const first = new SqliteEventStore(path);
  const session = await first.createSession({
    workspaceId: "ws-1",
    title: "t",
  });
  await first.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [userMessage("one"), userMessage("two")],
  });
  first.close();

  const second = new SqliteEventStore(path);
  expect(await second.getSession(session.sessionId)).toMatchObject({
    sessionId: session.sessionId,
    lastSeq: 3,
    title: "t",
  });
  const replay = await second.readEvents(session.sessionId, 0, 10);
  expect(replay.events.map((e) => [e.seq, e.type])).toEqual([
    [1, "session.created"],
    [2, "message.user.created"],
    [3, "message.user.created"],
  ]);
  expect(replay.nextFromSeq).toBeNull();
  second.close();
});

test("persists runtime session refs across store reopen", async () => {
  const path = dbPath();
  const first = new SqliteEventStore(path);
  const session = await first.createSession({ workspaceId: "ws-1" });
  await expect(
    first.updateRuntimeSessionRef(
      session.sessionId,
      "/var/lib/agena/pi/s.jsonl",
    ),
  ).resolves.toMatchObject({
    sessionId: session.sessionId,
    runtimeSessionRef: "/var/lib/agena/pi/s.jsonl",
  });
  first.close();

  const second = new SqliteEventStore(path);
  await expect(second.getSession(session.sessionId)).resolves.toMatchObject({
    runtimeSessionRef: "/var/lib/agena/pi/s.jsonl",
  });
  second.close();
});

test("stores M4 project scope and filters project/global sessions", async () => {
  const store = new SqliteEventStore(dbPath());
  const a = await store.createSession({
    workspaceId: "ws-1",
    title: "a",
    projectId: "project-a",
    projectRoot: "repo-a",
    cwd: "repo-a/pkg",
    hostCwdHint: "/host/repo-a/pkg",
  });
  const b = await store.createSession({
    workspaceId: "ws-1",
    title: "b",
    projectId: "project-b",
    projectRoot: "repo-a",
    cwd: "repo-a",
  });
  const global = await store.createSession({
    workspaceId: "ws-1",
    title: "g",
    scope: "global",
  });

  expect(await store.getSession(a.sessionId)).toMatchObject({
    sessionId: a.sessionId,
    scope: "project",
    projectId: "project-a",
    projectRoot: "repo-a",
    cwd: "repo-a/pkg",
    hostCwdHint: "/host/repo-a/pkg",
  });
  expect(
    (await store.listSessions({ projectId: "project-a" })).map(id),
  ).toEqual([a.sessionId]);
  expect(
    (
      await store.listSessions({ scope: "project", projectId: "project-a" })
    ).map(id),
  ).toEqual([a.sessionId]);
  expect((await store.listSessions()).map(id).sort()).toEqual(
    [a.sessionId, b.sessionId].sort(),
  );
  expect((await store.listSessions({ scope: "global" })).map(id)).toEqual([
    global.sessionId,
  ]);
  expect(
    (await store.listSessions({ allProjects: true })).map(id).sort(),
  ).toEqual([a.sessionId, b.sessionId, global.sessionId].sort());

  const replay = await store.readEvents(a.sessionId, 0, 10);
  expect(replay.events[0]?.payload).toMatchObject({
    scope: "project",
    projectId: "project-a",
    projectRoot: "repo-a",
    cwd: "repo-a/pkg",
    hostCwdHint: "/host/repo-a/pkg",
  });
  store.close();
});

test("rejects invalid batches without consuming a seq", async () => {
  const store = new SqliteEventStore(dbPath());
  const session = await store.createSession({ workspaceId: "ws-1" });

  await expect(
    store.appendEvents({
      sessionId: session.sessionId,
      branchId: session.rootBranchId,
      events: [
        userMessage("ok"),
        { type: "run.started", v: 1, source: user, payload: {} },
      ],
    }),
  ).rejects.toMatchObject({ code: "invalid_payload" });

  const replay = await store.readEvents(session.sessionId, 0, 10);
  expect(replay.events.map((e) => e.type)).toEqual(["session.created"]);
  store.close();
});

test("stores M4.5 control events and lists pending approvals after reopen", async () => {
  const path = dbPath();
  const first = new SqliteEventStore(path);
  const a = await first.createSession({
    workspaceId: "ws-1",
    projectId: "project-a",
  });
  const b = await first.createSession({
    workspaceId: "ws-1",
    projectId: "project-b",
  });
  const pending = ulid();
  const answered = ulid();
  await first.appendEvents({
    sessionId: a.sessionId,
    branchId: a.rootBranchId,
    events: [
      approvalRequest(pending),
      approvalRequest(answered),
      {
        type: "approval.responded",
        v: 1,
        source: user,
        payload: {
          approvalId: answered,
          response: { kind: "confirm", accepted: true },
          respondedBy: "client-1",
        },
      },
      {
        type: "model.changed",
        v: 1,
        source: user,
        payload: { to: { provider: "fake", id: "fake-2" }, reason: "auto" },
      },
      {
        type: "thinking.level.changed",
        v: 1,
        source: user,
        payload: { from: "low", to: "high" },
      },
      {
        type: "compaction.created",
        v: 1,
        source: pi,
        payload: {
          compactionId: ulid(),
          summary: [{ type: "text", text: "summary" }],
          replacesUpToSeq: 1,
          trigger: "auto",
        },
      },
    ],
  });
  await first.appendEvents({
    sessionId: b.sessionId,
    branchId: b.rootBranchId,
    events: [approvalRequest()],
  });
  first.close();

  const second = new SqliteEventStore(path);
  expect(await second.listPendingApprovals({ projectId: "project-a" })).toEqual(
    [
      expect.objectContaining({
        sessionId: a.sessionId,
        branchId: a.rootBranchId,
        approvalId: pending,
        payload: expect.objectContaining({ message: "Continue?" }),
      }),
    ],
  );
  await expect(second.rebuildProjections()).resolves.toMatchObject({
    events: 9,
  });
  second.close();
});

test("reconcileOpenWork cancels dangling approvals", async () => {
  const store = new SqliteEventStore(dbPath());
  const session = await store.createSession({ workspaceId: "ws-1" });
  const approvalId = ulid();
  await store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [approvalRequest(approvalId)],
  });

  await expect(store.reconcileOpenWork()).resolves.toEqual({
    sessions: 1,
    appended: 1,
  });
  await expect(store.listPendingApprovals()).resolves.toEqual([]);
  const replay = await store.readEvents(session.sessionId, 0, 10);
  expect(replay.events.at(-1)).toMatchObject({
    type: "approval.cancelled",
    payload: { approvalId, reason: "daemon_restart" },
  });
  store.close();
});

test("rebuildProjections recreates byte-identical message rows from the event log", async () => {
  const path = dbPath();
  let store = new SqliteEventStore(path);
  const session = await store.createSession({ workspaceId: "ws-1" });
  await store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [userMessage("hello"), userMessage("again")],
  });
  store.close();

  const before = rows(path, "messages");
  expect(before).toHaveLength(2);

  exec(path, "DELETE FROM messages");
  expect(countRows(path, "messages")).toBe(0);

  store = new SqliteEventStore(path);
  await expect(store.rebuildProjections()).resolves.toMatchObject({
    events: 3,
    messages: 2,
  });
  store.close();
  expect(rows(path, "messages")).toEqual(before);
});

test("rebuildProjections restores generated session titles", async () => {
  const path = dbPath();
  let store = new SqliteEventStore(path);
  const session = await store.createSession({
    workspaceId: "ws-1",
    title: "Initial title",
  });
  await store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [
      {
        type: "session.title.changed",
        v: 1,
        source: pi,
        payload: { title: "Generated session name" },
      },
    ],
  });
  await expect(store.getSession(session.sessionId)).resolves.toMatchObject({
    title: "Generated session name",
  });
  store.close();

  exec(path, "UPDATE sessions SET title = 'stale title'");
  store = new SqliteEventStore(path);
  await expect(store.rebuildProjections()).resolves.toMatchObject({
    sessions: 1,
    events: 2,
  });
  await expect(store.getSession(session.sessionId)).resolves.toMatchObject({
    title: "Generated session name",
  });
  store.close();
});

test("search is project-filtered and rebuild restores identical FTS hits", async () => {
  const path = dbPath();
  let store = new SqliteEventStore(path);
  const a = await store.createSession({
    workspaceId: "ws-1",
    projectId: "project-a",
  });
  const b = await store.createSession({
    workspaceId: "ws-1",
    projectId: "project-b",
  });
  await store.appendEvents({
    sessionId: a.sessionId,
    branchId: a.rootBranchId,
    events: [userMessage("needle in project alpha")],
  });
  await store.appendEvents({
    sessionId: b.sessionId,
    branchId: b.rootBranchId,
    events: [userMessage("needle in project beta")],
  });

  const before = await store.search("needle", { projectId: "project-a" });
  expect(before.map((h) => h.sessionId)).toEqual([a.sessionId]);
  await expect(
    store.search("needle", { allProjects: true }),
  ).resolves.toHaveLength(2);
  store.close();

  exec(path, "DELETE FROM messages_fts");
  store = new SqliteEventStore(path);
  await expect(
    store.search("needle", { projectId: "project-a" }),
  ).resolves.toEqual([]);

  await store.rebuildProjections();
  await expect(
    store.search("needle", { projectId: "project-a" }),
  ).resolves.toEqual(before);
  store.close();
});

test("reconcileOpenWork terminalizes dangling assistant and run rows", async () => {
  const store = new SqliteEventStore(dbPath());
  const session = await store.createSession({ workspaceId: "ws-1" });
  const runId = ulid();
  const messageId = ulid();
  await store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [
      {
        type: "run.started",
        v: 1,
        source: runtime,
        payload: { runId, trigger: "prompt", triggerMessageId: ulid() },
      },
      {
        type: "message.assistant.started",
        v: 1,
        source: runtime,
        payload: {
          messageId,
          runId,
          turnId: ulid(),
          model: { provider: "fake", id: "fake-1" },
          inResponseTo: ulid(),
        },
      },
    ],
  });

  await expect(store.reconcileOpenWork()).resolves.toEqual({
    sessions: 1,
    appended: 2,
  });
  const replay = await store.readEvents(session.sessionId, 0, 10);
  expect(replay.events.map((e) => e.type)).toEqual([
    "session.created",
    "run.started",
    "message.assistant.started",
    "message.assistant.failed",
    "run.failed",
  ]);
  store.close();
});

function countRows(path: string, table: "messages" | "tool_calls"): number {
  return rows(path, table).length;
}

function rows(path: string, table: "messages" | "tool_calls"): unknown[] {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  } finally {
    db.close();
  }
}

function exec(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

const id = (s: { sessionId: string }) => s.sessionId;
