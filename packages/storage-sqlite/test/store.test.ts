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

test("stores image blobs by content hash and reads them after reopen", async () => {
  const path = dbPath();
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const first = new SqliteEventStore(path);
  const ref = await first.putBlob(bytes, "image/png");
  expect(ref).toMatchObject({
    blob: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    sizeBytes: bytes.byteLength,
    mimeType: "image/png",
  });
  first.close();

  const reopened = new SqliteEventStore(path);
  await expect(reopened.readBlob(ref.blob)).resolves.toEqual({
    bytes,
    mimeType: "image/png",
  });
  reopened.close();
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

test("lists user-message anchors in sequence order", async () => {
  const store = new SqliteEventStore(dbPath());
  const session = await store.createSession({ workspaceId: "ws-1" });
  await store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [userMessage("first prompt"), userMessage("second prompt")],
  });

  await expect(
    store.listUserMessages(session.sessionId),
  ).resolves.toMatchObject([
    { seq: 2, preview: "first prompt" },
    { seq: 3, preview: "second prompt" },
  ]);
  store.close();
});

test("reads complete turn pages without eager tool results and loads tool detail on demand", async () => {
  const store = new SqliteEventStore(dbPath());
  const session = await store.createSession({ workspaceId: "ws-1" });
  const u1 = ulid();
  const u2 = ulid();
  const u3 = ulid();
  const assistantId = ulid();
  const toolCallId = ulid();
  await store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [
      {
        type: "message.user.created",
        v: 1,
        source: user,
        payload: { messageId: u1, content: [{ type: "text", text: "one" }] },
      },
      {
        type: "message.assistant.started",
        v: 1,
        source: pi,
        payload: {
          messageId: assistantId,
          runId: ulid(),
          turnId: ulid(),
          model: { provider: "fake", id: "model" },
          inResponseTo: u1,
        },
      },
      {
        type: "tool.call.started",
        v: 1,
        source: pi,
        payload: {
          toolCallId,
          messageId: assistantId,
          runId: ulid(),
          turnId: ulid(),
          name: "browser",
          args: { url: "https://example.com" },
        },
      },
      {
        type: "message.user.created",
        v: 1,
        source: user,
        payload: {
          messageId: u2,
          content: [{ type: "text", text: "queued next" }],
          queued: "followUp",
        },
      },
      {
        type: "tool.call.completed",
        v: 1,
        source: pi,
        payload: {
          toolCallId,
          result: [{ type: "text", text: "heavy-result-body" }],
          durationMs: 12,
        },
      },
      {
        type: "message.assistant.completed",
        v: 1,
        source: pi,
        payload: {
          messageId: assistantId,
          content: [{ type: "text", text: "done" }],
          model: { provider: "fake", id: "model" },
          stopReason: "end_turn",
        },
      },
      {
        type: "message.user.created",
        v: 1,
        source: user,
        payload: {
          messageId: u3,
          content: [{ type: "text", text: "three" }],
        },
      },
    ],
  });

  const newest = await store.readCompactTranscript(session.sessionId, {
    limitTurns: 2,
  });
  expect(newest).toMatchObject({
    branchId: session.rootBranchId,
    upToSeq: 8,
    hasOlder: true,
    hasNewer: false,
  });
  expect(newest.turns.map((turn) => turn.user.messageId)).toEqual([u2, u3]);

  const older = await store.readCompactTranscript(session.sessionId, {
    limitTurns: 2,
    beforeMessageId: u3,
  });
  expect(older.turns.map((turn) => turn.user.messageId)).toEqual([u1, u2]);
  expect(JSON.stringify(older)).not.toContain("heavy-result-body");
  expect(older.turns[0]?.entries).toMatchObject([
    {
      kind: "tool",
      toolCallId,
      argsPreview: '{"url":"https://example.com"}',
      status: "completed",
      durationMs: 12,
      hasDetails: true,
    },
    { kind: "assistant", content: [{ type: "text", text: "done" }] },
  ]);
  const firstOnly = await store.readCompactTranscript(session.sessionId, {
    limitTurns: 1,
    aroundMessageId: u1,
  });
  expect(firstOnly.turns[0]?.entries).toMatchObject([
    { kind: "tool", status: "completed" },
    { kind: "assistant", status: "completed" },
  ]);

  await expect(
    store.getToolCallDetail(session.sessionId, toolCallId),
  ).resolves.toMatchObject({
    toolCallId,
    args: { url: "https://example.com" },
    result: [{ type: "text", text: "heavy-result-body" }],
    status: "ok",
  });
  store.close();
});

test("compact transcript associates imported assistants and tools without start events", async () => {
  const store = new SqliteEventStore(dbPath());
  const session = await store.createSession({ workspaceId: "ws-1" });
  const userMessageId = ulid();
  const assistantMessageId = ulid();
  const finalAssistantMessageId = ulid();
  const toolCallId = ulid();
  const importer = { kind: "importer" } as const;
  await store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [
      {
        type: "message.user.created",
        v: 1,
        source: importer,
        payload: {
          messageId: userMessageId,
          content: [{ type: "text", text: "inspect this" }],
        },
      },
      {
        type: "message.assistant.completed",
        v: 1,
        source: importer,
        payload: {
          messageId: assistantMessageId,
          content: [{ type: "text", text: "I will inspect it" }],
          model: { provider: "imported", id: "model" },
          stopReason: "tool_use",
        },
      },
      {
        type: "tool.call.started",
        v: 1,
        source: importer,
        payload: {
          toolCallId,
          messageId: assistantMessageId,
          runId: ulid(),
          turnId: ulid(),
          name: "read",
          args: { path: "note.txt" },
        },
      },
      {
        type: "tool.call.completed",
        v: 1,
        source: importer,
        payload: {
          toolCallId,
          result: [{ type: "text", text: "contents" }],
          durationMs: 0,
        },
      },
      {
        type: "message.assistant.completed",
        v: 1,
        source: importer,
        payload: {
          messageId: finalAssistantMessageId,
          content: [{ type: "text", text: "Inspection complete" }],
          model: { provider: "imported", id: "model" },
          stopReason: "end_turn",
        },
      },
    ],
  });

  const page = await store.readCompactTranscript(session.sessionId, {
    limitTurns: 10,
  });
  expect(page.turns[0]?.entries).toMatchObject([
    {
      kind: "assistant",
      messageId: assistantMessageId,
      content: [{ type: "text", text: "I will inspect it" }],
    },
    { kind: "tool", toolCallId, status: "completed" },
    {
      kind: "assistant",
      messageId: finalAssistantMessageId,
      content: [{ type: "text", text: "Inspection complete" }],
    },
  ]);
  store.close();
});

test("compact transcript follows the active edited-message path", async () => {
  const store = new SqliteEventStore(dbPath());
  const session = await store.createSession({ workspaceId: "ws-1" });
  const first = ulid();
  const replaced = ulid();
  const edit = ulid();
  await store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [
      {
        type: "message.user.created",
        v: 1,
        source: user,
        payload: {
          messageId: first,
          content: [{ type: "text", text: "first" }],
        },
      },
      {
        type: "message.user.created",
        v: 1,
        source: user,
        payload: {
          messageId: replaced,
          content: [{ type: "text", text: "old second" }],
        },
      },
      {
        type: "message.user.created",
        v: 1,
        source: user,
        payload: {
          messageId: edit,
          editedFromMessageId: replaced,
          content: [{ type: "text", text: "new second" }],
        },
      },
    ],
  });

  const page = await store.readCompactTranscript(session.sessionId, {
    limitTurns: 10,
  });
  expect(page.turns.map((turn) => turn.user.messageId)).toEqual([first, edit]);
  await expect(
    store.listUserMessages(session.sessionId),
  ).resolves.toMatchObject([
    { messageId: first, preview: "first" },
    { messageId: edit, preview: "new second" },
  ]);
  await expect(
    store.readCompactTranscript(session.sessionId, {
      limitTurns: 1,
      aroundMessageId: replaced,
    }),
  ).rejects.toThrow(`unknown active user message ${replaced}`);
  store.close();
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

test("atomically creates a linked subagent session and rebuildable task projection", async () => {
  const store = new SqliteEventStore(dbPath());
  const parent = await store.createSession({ workspaceId: "ws-1" });
  const taskId = ulid();
  const created = await store.createSubagentSession({
    parentSessionId: parent.sessionId,
    title: "Security review",
    source: pi,
    task: {
      taskId,
      parentRunId: ulid(),
      parentMessageId: ulid(),
      parentToolCallId: ulid(),
      role: "security-reviewer",
      task: "Review the auth boundary",
      execution: "background",
      context: "fresh",
      workspaceMode: "shared_readonly",
      resolvedModel: { provider: "fake", id: "reviewer" },
    },
  });

  expect(created.session).toMatchObject({
    sessionKind: "subagent",
    origin: "native",
    parentSessionId: parent.sessionId,
    parentTaskId: taskId,
    projectId: "default",
  });
  expect(store.getAgentTask(taskId)).toMatchObject({
    status: "created",
    childSessionId: created.session.sessionId,
    parentSessionId: parent.sessionId,
  });

  await store.appendEvents({
    sessionId: parent.sessionId,
    branchId: parent.rootBranchId,
    events: [
      {
        type: "agent.task.started",
        v: 1,
        source: pi,
        payload: { taskId, startedAt: "2026-07-12T00:00:00.000Z" },
      },
      {
        type: "agent.task.completed",
        v: 1,
        source: pi,
        payload: {
          taskId,
          resultMessageId: ulid(),
          summary: [{ type: "text", text: "No issues" }],
          usage: { inputTokens: 12, outputTokens: 4, costUsd: 0.01 },
        },
      },
    ],
  });
  expect(store.getAgentTask(taskId)).toMatchObject({
    status: "completed",
    summary: [{ type: "text", text: "No issues" }],
    usage: { inputTokens: 12, outputTokens: 4, costUsd: 0.01 },
  });

  await store.rebuildProjections(parent.sessionId);
  expect(store.getAgentTask(taskId)).toMatchObject({
    status: "completed",
    childSessionId: created.session.sessionId,
  });
  store.close();
});

test("preserves imported harness origin on child sessions", async () => {
  const path = dbPath();
  const store = new SqliteEventStore(path);
  const parent = await store.createSession({
    workspaceId: "ws-1",
    origin: "import.codex",
  });
  const created = await store.createSubagentSession({
    parentSessionId: parent.sessionId,
    source: pi,
    origin: "import.codex",
    task: {
      taskId: ulid(),
      parentRunId: ulid(),
      parentMessageId: ulid(),
      parentToolCallId: ulid(),
      role: "worker",
      task: "Inspect the repository",
      execution: "foreground",
      context: "fork",
      workspaceMode: "shared_readonly",
      resolvedModel: { provider: "openai", id: "gpt-5" },
    },
  });

  expect(created.session.origin).toBe("import.codex");
  expect(await store.getSession(created.session.sessionId)).toMatchObject({
    origin: "import.codex",
  });
  store.close();

  const db = new DatabaseSync(path);
  db.prepare("UPDATE sessions SET origin = 'native' WHERE id = ?").run(
    created.session.sessionId,
  );
  db.close();
  const reopened = new SqliteEventStore(path);
  expect(await reopened.getSession(created.session.sessionId)).toMatchObject({
    origin: "import.codex",
  });
  reopened.close();
});

test("creates a primary derived session with durable fork provenance", async () => {
  const path = dbPath();
  const store = new SqliteEventStore(path);
  const parent = await store.createSession({ workspaceId: "ws-1" });
  const messageId = ulid();
  await store.appendEvents({
    sessionId: parent.sessionId,
    branchId: parent.rootBranchId,
    events: [
      {
        type: "message.user.created",
        v: 1,
        source: { kind: "user" },
        payload: {
          messageId,
          content: [{ type: "text", text: "branch here" }],
        },
      },
      {
        type: "message.runtime.ref",
        v: 1,
        source: pi,
        payload: { messageId, runtimeEntryId: "pi-entry-1" },
      },
    ],
  });
  const child = await store.createDerivedSession({
    parentSessionId: parent.sessionId,
    sourceMessageId: messageId,
    mode: "fork",
  });

  expect(child).toMatchObject({
    sessionKind: "primary",
    parentSessionId: parent.sessionId,
    derivedFrom: {
      parentSessionId: parent.sessionId,
      sourceMessageId: messageId,
      mode: "fork",
    },
  });
  expect(await store.getRuntimeMessageRef(parent.sessionId, messageId)).toBe(
    "pi-entry-1",
  );
  expect(
    (await store.readEvents(child.sessionId, 0)).events[0]?.payload,
  ).toMatchObject({
    derivedFrom: child.derivedFrom,
  });
  store.close();

  const reopened = new SqliteEventStore(path);
  expect(await reopened.getSession(child.sessionId)).toMatchObject({
    derivedFrom: child.derivedFrom,
  });
  reopened.close();
});

test("persists an empty quick chat with its runtime reference", async () => {
  const path = dbPath();
  const store = new SqliteEventStore(path);
  const parent = await store.createSession({ workspaceId: "ws-1" });
  const child = await store.createDerivedSession({
    sessionId: ulid(),
    parentSessionId: parent.sessionId,
    mode: "fork",
    purpose: "quick_chat",
    runtimeSessionRef: "pi:quick-chat",
  });

  expect(child).toMatchObject({
    purpose: "quick_chat",
    runtimeSessionRef: "pi:quick-chat",
    parentSessionId: parent.sessionId,
    derivedFrom: { parentSessionId: parent.sessionId, mode: "fork" },
  });
  store.close();

  const reopened = new SqliteEventStore(path);
  expect(await reopened.getSession(child.sessionId)).toMatchObject({
    purpose: "quick_chat",
    runtimeSessionRef: "pi:quick-chat",
  });
  reopened.close();
});

test("rolls back the child session when task creation fails", async () => {
  const store = new SqliteEventStore(dbPath());
  const parent = await store.createSession({ workspaceId: "ws-1" });
  const task = {
    taskId: ulid(),
    parentRunId: ulid(),
    parentMessageId: ulid(),
    parentToolCallId: ulid(),
    role: "reviewer",
    task: "Review",
    execution: "foreground" as const,
    context: "fresh" as const,
    workspaceMode: "shared_readonly" as const,
    resolvedModel: { provider: "fake", id: "reviewer" },
  };
  await store.createSubagentSession({
    parentSessionId: parent.sessionId,
    source: pi,
    task,
  });
  await expect(
    store.createSubagentSession({
      parentSessionId: parent.sessionId,
      source: pi,
      task,
    }),
  ).rejects.toThrow();
  expect((await store.listSessions({ allProjects: true })).length).toBe(2);
  store.close();
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
