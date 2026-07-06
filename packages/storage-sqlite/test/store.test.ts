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

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agena-sqlite-"));
  dirs.push(dir);
  return join(dir, "agena.db");
}

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
