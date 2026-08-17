import { resolve } from "node:path";
import type { AgenaFrame } from "@agena/protocol";
import { expect, test } from "vitest";
import { InMemoryEventStore } from "../src/memory-store.ts";
import { SessionOrchestrator } from "../src/sessions/orchestrator.ts";
import { FakeRuntimeAdapter } from "../src/testing/index.ts";

// Resolves one tick after run.completed commits — fanout fires inside the append,
// a microtask before the orchestrator's pump flips the session back to idle.
const runCompleted = (store: InMemoryEventStore) =>
  new Promise<void>((resolve) => {
    const off = store.onCommitted((batch) => {
      if (batch.events.some((e) => e.type === "run.completed")) {
        off();
        setTimeout(resolve, 0);
      }
    });
  });

const runFailed = (store: InMemoryEventStore) =>
  new Promise<void>((resolve) => {
    const off = store.onCommitted((batch) => {
      if (batch.events.some((e) => e.type === "run.failed")) {
        off();
        setTimeout(resolve, 0);
      }
    });
  });

const approvalRequested = (store: InMemoryEventStore) =>
  new Promise<void>((resolve) => {
    const off = store.onCommitted((batch) => {
      if (batch.events.some((e) => e.type === "approval.requested")) {
        off();
        resolve();
      }
    });
  });

const assistantStarted = (store: InMemoryEventStore) =>
  new Promise<void>((resolve) => {
    const off = store.onCommitted((batch) => {
      if (batch.events.some((e) => e.type === "message.assistant.started")) {
        off();
        resolve();
      }
    });
  });

test("happy path: prompt yields the exact durable sequence plus delta frames", async () => {
  const store = new InMemoryEventStore();
  const frames: AgenaFrame[] = [];
  const orch = new SessionOrchestrator(
    store,
    new FakeRuntimeAdapter({ script: () => ["Hello, ", "world"] }),
    { publishFrame: (f) => frames.push(f) },
  );

  const session = await orch.createSession({ workspaceId: "ws-1" });
  const done = runCompleted(store);
  const ack = await orch.handlePrompt(
    session.sessionId,
    [{ type: "text", text: "hi" }],
    "client-1",
  );
  expect(ack.seq).toBe(2); // §5.4 prompt ack: seq of message.user.created
  await done;

  const { events } = await store.readEvents(session.sessionId, 0);
  expect(events.map((e) => e.type)).toEqual([
    "session.created",
    "message.user.created",
    "session.title.changed",
    "run.started",
    "message.assistant.started",
    "message.assistant.completed",
    "run.completed",
  ]);
  expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);

  const userEvent = events[1];
  expect(userEvent?.source).toEqual({ kind: "user", clientId: "client-1" });
  expect(userEvent?.payload).toMatchObject({
    messageId: ack.messageId,
    content: [{ type: "text", text: "hi" }],
  });
  expect(events[2]?.payload).toEqual({ title: "Hi" });
  expect(events[3]?.source).toEqual({ kind: "runtime" }); // fake adapter: no 'pi' stamp
  expect(events[4]?.payload).toMatchObject({ inResponseTo: ack.messageId });
  expect(events[5]?.payload).toMatchObject({
    content: [{ type: "text", text: "Hello, world" }],
    stopReason: "end_turn",
  });

  expect(frames.map((f) => f.type)).toEqual([
    "message.assistant.text.delta",
    "message.assistant.text.delta",
  ]);
  expect(frames.map((f) => (f.payload as { delta: string }).delta)).toEqual([
    "Hello, ",
    "world",
  ]);
  // deltas stream after message.assistant.started (seq 5) committed
  expect(frames.map((f) => f.afterSeq)).toEqual([5, 5]);
  expect(frames.every((f) => f.branchId === session.rootBranchId)).toBe(true);
});

test("image prompts reject missing blobs before creating a user event", async () => {
  const store = new InMemoryEventStore();
  const orch = new SessionOrchestrator(store, new FakeRuntimeAdapter({}));
  const session = await orch.createSession({ workspaceId: "ws-1" });

  await expect(
    orch.handlePrompt(session.sessionId, [
      {
        type: "image",
        ref: {
          blob: `sha256:${"0".repeat(64)}`,
          sizeBytes: 10,
          mimeType: "image/png",
        },
      },
    ]),
  ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  expect((await store.readEvents(session.sessionId, 0)).events).toHaveLength(1);
});

test("file prompts retain the durable BlobRef and dispatch successfully", async () => {
  const store = new InMemoryEventStore();
  const orch = new SessionOrchestrator(store, new FakeRuntimeAdapter({}));
  const session = await orch.createSession({ workspaceId: "ws-1" });
  const ref = await store.putBlob(
    new TextEncoder().encode("# Notes\n"),
    "text/markdown",
  );
  const done = runCompleted(store);
  await orch.handlePrompt(session.sessionId, [
    { type: "file", ref, path: "notes.md" },
  ]);
  await done;

  const { events } = await store.readEvents(session.sessionId, 0);
  expect(events[1]?.payload).toMatchObject({
    content: [{ type: "file", ref, path: "notes.md" }],
  });
});

test("prompt while a turn is in flight fails SESSION_BUSY; idle again after completion", async () => {
  const store = new InMemoryEventStore();
  const orch = new SessionOrchestrator(
    store,
    new FakeRuntimeAdapter({ delayMs: 5 }),
  );
  const session = await orch.createSession({ workspaceId: "ws-1" });

  const done = runCompleted(store);
  await orch.handlePrompt(session.sessionId, [{ type: "text", text: "one" }]);
  await expect(
    orch.handlePrompt(session.sessionId, [{ type: "text", text: "two" }]),
  ).rejects.toMatchObject({ code: "SESSION_BUSY" });
  await done;

  const second = runCompleted(store);
  const ack = await orch.handlePrompt(session.sessionId, [
    { type: "text", text: "three" },
  ]);
  await second;
  const { events } = await store.readEvents(session.sessionId, ack.seq - 1);
  expect(events.map((e) => e.type)).toEqual([
    "message.user.created",
    "run.started",
    "message.assistant.started",
    "message.assistant.completed",
    "run.completed",
  ]);
});

test("prompt on an unknown session fails SESSION_NOT_FOUND", async () => {
  const orch = new SessionOrchestrator(
    new InMemoryEventStore(),
    new FakeRuntimeAdapter(),
  );
  await expect(
    orch.handlePrompt("nope", [{ type: "text", text: "hi" }]),
  ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
});

test("forks an immutable primary child from a persisted runtime message ref", async () => {
  const store = new InMemoryEventStore();
  const adapter = new FakeRuntimeAdapter();
  const orch = new SessionOrchestrator(store, adapter);
  const parent = await orch.createSession({ workspaceId: "ws-1" });
  const messageId = "01MESSAGE";
  await store.appendEvents({
    sessionId: parent.sessionId,
    branchId: parent.rootBranchId,
    events: [
      {
        type: "message.user.created",
        v: 1,
        source: { kind: "user" },
        payload: { messageId, content: [{ type: "text", text: "branch" }] },
      },
      {
        type: "message.runtime.ref",
        v: 1,
        source: { kind: "runtime" },
        payload: { messageId, runtimeEntryId: "pi-entry-1" },
      },
    ],
  });

  const child = await orch.forkSession({
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
  expect(adapter.forkInputs[0]).toMatchObject({
    runtimeEntryId: "pi-entry-1",
    position: "before",
  });
});

test("quick chat inherits the latest completed assistant and stays read-only", async () => {
  const store = new InMemoryEventStore();
  const adapter = new FakeRuntimeAdapter({ delayMs: 5 });
  const orch = new SessionOrchestrator(store, adapter);
  const parent = await orch.createSession({ workspaceId: "ws-1" });

  const firstDone = runCompleted(store);
  await orch.handlePrompt(parent.sessionId, [{ type: "text", text: "first" }]);
  await firstDone;
  const completed = await store.getLatestCompletedAssistant(parent.sessionId);
  expect(completed?.messageId).toBeTruthy();
  await store.appendEvents({
    sessionId: parent.sessionId,
    branchId: parent.rootBranchId,
    events: [
      {
        type: "message.runtime.ref",
        v: 1,
        source: { kind: "runtime" },
        payload: {
          messageId: completed?.messageId,
          runtimeEntryId: "pi-assistant-entry",
        },
      },
    ],
  });

  const secondDone = runCompleted(store);
  await orch.handlePrompt(parent.sessionId, [{ type: "text", text: "second" }]);
  const child = await orch.createQuickChat(parent.sessionId);
  const sibling = await orch.createQuickChat(parent.sessionId);

  expect(child).toMatchObject({
    title: "Quick Chat 1",
    purpose: "quick_chat",
    sideChatAccess: "read_only",
    parentSessionId: parent.sessionId,
    runtimeSessionRef: `fake:${child.sessionId}`,
    derivedFrom: {
      parentSessionId: parent.sessionId,
      sourceMessageId: completed?.messageId,
      mode: "fork",
    },
  });
  expect(sibling).toMatchObject({
    title: "Quick Chat 2",
    purpose: "quick_chat",
    parentSessionId: parent.sessionId,
  });
  expect(sibling.sessionId).not.toBe(child.sessionId);
  expect(adapter.forkInputs.at(-1)).toMatchObject({
    runtimeEntryId: "pi-assistant-entry",
    position: "at",
    toolNames: ["read", "grep", "find", "ls"],
    systemPromptAppendix: expect.stringContaining("read-only side chat"),
  });
  expect(adapter.forkInputs).toHaveLength(2);
  await secondDone;
});

test("full side chat gets ordinary primary-session tools and explicit context", async () => {
  const store = new InMemoryEventStore();
  const adapter = new FakeRuntimeAdapter();
  const orch = new SessionOrchestrator(store, adapter);
  const parent = await orch.createSession({ workspaceId: "ws-1" });

  const child = await orch.createQuickChat(parent.sessionId, "full");

  expect(child).toMatchObject({
    purpose: "quick_chat",
    sideChatAccess: "full",
  });
  expect(adapter.createInputs[0]).toMatchObject({
    sessionId: child.sessionId,
    systemPromptAppendix: expect.stringContaining("full-access side chat"),
  });
  expect(adapter.createInputs[0]?.toolNames).toBeUndefined();

  const reopenedAdapter = new FakeRuntimeAdapter();
  const reopened = new SessionOrchestrator(store, reopenedAdapter);
  await reopened.handleRuntimeInfo(child.sessionId);
  expect(reopenedAdapter.createInputs[0]).toMatchObject({
    runtimeSessionRef: `fake:${child.sessionId}`,
    systemPromptAppendix: expect.stringContaining("full-access side chat"),
  });
  expect(reopenedAdapter.createInputs[0]?.toolNames).toBeUndefined();
});

test("quick chat is empty when the parent has no completed turn", async () => {
  const store = new InMemoryEventStore();
  const adapter = new FakeRuntimeAdapter();
  const orch = new SessionOrchestrator(store, adapter);
  const parent = await orch.createSession({ workspaceId: "ws-1" });

  const child = await orch.createQuickChat(parent.sessionId);
  const [sibling, grandchild] = await Promise.all([
    orch.createQuickChat(parent.sessionId),
    orch.createQuickChat(child.sessionId),
  ]);

  expect(child).toMatchObject({
    title: "Quick Chat 1",
    purpose: "quick_chat",
    parentSessionId: parent.sessionId,
    derivedFrom: { parentSessionId: parent.sessionId, mode: "fork" },
  });
  expect(grandchild).toMatchObject({
    title: "Quick Chat 3",
    purpose: "quick_chat",
    parentSessionId: child.sessionId,
    derivedFrom: { parentSessionId: child.sessionId, mode: "fork" },
  });
  expect(sibling).toMatchObject({
    title: "Quick Chat 2",
    purpose: "quick_chat",
    parentSessionId: parent.sessionId,
  });
  expect(adapter.createInputs[0]).toMatchObject({
    sessionId: child.sessionId,
    toolNames: ["read", "grep", "find", "ls"],
  });
  expect(adapter.createInputs).toHaveLength(3);
});

test("quick chat waits for the latest completed assistant runtime reference", async () => {
  const store = new InMemoryEventStore();
  const adapter = new FakeRuntimeAdapter();
  const orch = new SessionOrchestrator(store, adapter);
  const parent = await orch.createSession({ workspaceId: "ws-1" });
  const done = runCompleted(store);
  await orch.handlePrompt(parent.sessionId, [{ type: "text", text: "done" }]);
  await done;

  await expect(orch.createQuickChat(parent.sessionId)).rejects.toMatchObject({
    code: "NOT_READY",
  });
  expect(adapter.forkInputs).toHaveLength(0);
});

test("quick-chat cutoff ignores abandoned completions after repeated edits", async () => {
  const store = new InMemoryEventStore();
  const session = await store.createSession({ workspaceId: "ws-1" });
  const events = [
    ["u1", undefined, "a1"],
    ["u2", undefined, "a2"],
    ["u2-edit-1", "u2", "a2-edit-1"],
    ["u2-edit-2", "u2-edit-1", undefined],
  ] as const;
  for (const [userId, editedFromMessageId, assistantId] of events) {
    await store.appendEvents({
      sessionId: session.sessionId,
      branchId: session.rootBranchId,
      events: [
        {
          type: "message.user.created",
          v: 1,
          source: { kind: "user" },
          payload: {
            messageId: userId,
            content: [{ type: "text", text: userId }],
            ...(editedFromMessageId ? { editedFromMessageId } : {}),
          },
        },
        ...(assistantId
          ? [
              {
                type: "message.assistant.started",
                v: 1,
                source: { kind: "runtime" } as const,
                payload: {
                  messageId: assistantId,
                  inResponseTo: userId,
                  runId: `run-${assistantId}`,
                  turnId: `turn-${assistantId}`,
                  model: { provider: "fake", id: "fake-1" },
                },
              },
              {
                type: "message.assistant.completed",
                v: 1,
                source: { kind: "runtime" } as const,
                payload: {
                  messageId: assistantId,
                  runId: `run-${assistantId}`,
                  turnId: `turn-${assistantId}`,
                  content: [{ type: "text", text: assistantId }],
                  model: { provider: "fake", id: "fake-1" },
                  stopReason: "end_turn" as const,
                },
              },
            ]
          : []),
      ],
    });
  }

  expect(
    await store.getLatestCompletedAssistant(session.sessionId),
  ).toMatchObject({ messageId: "a1" });
});

test("editing a previous message stays in the same session", async () => {
  const store = new InMemoryEventStore();
  const orch = new SessionOrchestrator(store, new FakeRuntimeAdapter());
  const session = await orch.createSession({ workspaceId: "ws-1" });
  await store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [
      {
        type: "message.user.created",
        v: 1,
        source: { kind: "user" },
        payload: {
          messageId: "01EDIT",
          content: [{ type: "text", text: "edit me" }],
        },
      },
      {
        type: "message.runtime.ref",
        v: 1,
        source: { kind: "runtime" },
        payload: { messageId: "01EDIT", runtimeEntryId: "pi-entry-edit" },
      },
    ],
  });

  await expect(
    orch.navigateToMessage(session.sessionId, "01EDIT"),
  ).resolves.toEqual({ editorText: "" });
  expect((await store.listSessions()).map((item) => item.sessionId)).toEqual([
    session.sessionId,
  ]);

  const done = runCompleted(store);
  const next = await orch.handlePrompt(session.sessionId, [
    { type: "text", text: "edited" },
  ]);
  await done;
  const { events } = await store.readEvents(session.sessionId, next.seq - 1);
  expect(events[0]?.payload).toMatchObject({
    editedFromMessageId: "01EDIT",
  });
});

test("runtime starts in the durable session cwd", async () => {
  const store = new InMemoryEventStore();
  const adapter = new FakeRuntimeAdapter();
  const orch = new SessionOrchestrator(store, adapter, {
    workspaceDir: "/workspace",
  });
  const session = await orch.createSession({
    workspaceId: "ws-1",
    projectId: "project-a",
    projectRoot: "repo",
    cwd: "repo/pkg",
  });

  const done = runCompleted(store);
  await orch.handlePrompt(session.sessionId, [{ type: "text", text: "hi" }]);
  await done;

  expect(adapter.createInputs[0]).toMatchObject({
    sessionId: session.sessionId,
    workspaceDir: "/workspace",
    cwd: resolve("/workspace", "repo/pkg"),
  });
});

test("runtime rehydrates with the persisted runtime session ref", async () => {
  const store = new InMemoryEventStore();
  const adapter = new FakeRuntimeAdapter();
  const first = new SessionOrchestrator(store, adapter);
  const session = await first.createSession({ workspaceId: "ws-1" });

  const firstDone = runCompleted(store);
  await first.handlePrompt(session.sessionId, [{ type: "text", text: "one" }]);
  await firstDone;

  const second = new SessionOrchestrator(store, adapter);
  const secondDone = runCompleted(store);
  await second.handlePrompt(session.sessionId, [{ type: "text", text: "two" }]);
  await secondDone;

  expect(adapter.createInputs).toHaveLength(2);
  expect(adapter.createInputs[1]).toMatchObject({
    sessionId: session.sessionId,
    runtimeSessionRef: `fake:${session.sessionId}`,
  });
});

test("runtime pump failure is discarded so the next prompt rehydrates", async () => {
  const store = new InMemoryEventStore();
  const adapter = new FakeRuntimeAdapter({ failFirstPump: true });
  const orch = new SessionOrchestrator(store, adapter);
  const session = await orch.createSession({ workspaceId: "ws-1" });

  const failed = runFailed(store);
  await orch.handlePrompt(session.sessionId, [{ type: "text", text: "one" }]);
  await failed;

  const completed = runCompleted(store);
  await orch.handlePrompt(session.sessionId, [{ type: "text", text: "two" }]);
  await completed;

  expect(adapter.createInputs).toHaveLength(2);
});

test("abort terminalizes active work as aborted, not failed", async () => {
  const store = new InMemoryEventStore();
  const orch = new SessionOrchestrator(
    store,
    new FakeRuntimeAdapter({ delayMs: 5, script: () => ["a", "b", "c"] }),
  );
  const session = await orch.createSession({ workspaceId: "ws-1" });

  const started = assistantStarted(store);
  await orch.handlePrompt(session.sessionId, [{ type: "text", text: "stop" }]);
  await started;
  await expect(orch.handleAbort(session.sessionId)).resolves.toEqual({});

  const { events } = await store.readEvents(session.sessionId, 0);
  expect(events.map((e) => e.type)).toContain("message.assistant.aborted");
  expect(events.map((e) => e.type)).toContain("run.aborted");
  expect(events.map((e) => e.type)).not.toContain("message.assistant.failed");
});

test("runtime info is served from the runtime session", async () => {
  const orch = new SessionOrchestrator(
    new InMemoryEventStore(),
    new FakeRuntimeAdapter({
      model: { provider: "fake-provider", id: "fake-model" },
    }),
  );
  const session = await orch.createSession({ workspaceId: "ws-1" });

  await expect(
    orch.handleRuntimeInfo(session.sessionId),
  ).resolves.toMatchObject({
    model: { provider: "fake-provider", id: "fake-model" },
    thinkingLevel: "off",
    availableModels: [{ provider: "fake-provider", id: "fake-model" }],
  });
});

test("fake runtime manual approval blocks the turn until answered", async () => {
  const store = new InMemoryEventStore();
  const orch = new SessionOrchestrator(store, new FakeRuntimeAdapter());
  const session = await orch.createSession({ workspaceId: "ws-1" });

  const requested = approvalRequested(store);
  await orch.handlePrompt(session.sessionId, [
    { type: "text", text: "approval select" },
  ]);
  await requested;

  const pending = await store.listPendingApprovals({ allProjects: true });
  expect(pending).toHaveLength(1);
  expect(pending[0]?.payload).toMatchObject({
    kind: "select",
    title: "Manual approval test",
  });

  const done = runCompleted(store);
  await orch.handleRespondToApproval(
    session.sessionId,
    pending[0]?.approvalId ?? "",
    { kind: "select", optionId: "two" },
    "client-1",
  );
  await done;

  const { events } = await store.readEvents(session.sessionId, 0);
  expect(events.map((e) => e.type)).toEqual([
    "session.created",
    "message.user.created",
    "session.title.changed",
    "run.started",
    "approval.requested",
    "approval.responded",
    "message.assistant.started",
    "message.assistant.completed",
    "run.completed",
  ]);
  expect(events[7]?.payload).toMatchObject({
    content: [{ type: "text", text: "approval response: selected two" }],
  });
});
