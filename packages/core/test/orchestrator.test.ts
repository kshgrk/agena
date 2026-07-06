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

const approvalRequested = (store: InMemoryEventStore) =>
  new Promise<void>((resolve) => {
    const off = store.onCommitted((batch) => {
      if (batch.events.some((e) => e.type === "approval.requested")) {
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
    "run.started",
    "message.assistant.started",
    "message.assistant.completed",
    "run.completed",
  ]);
  expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);

  const userEvent = events[1];
  expect(userEvent?.source).toEqual({ kind: "user", clientId: "client-1" });
  expect(userEvent?.payload).toMatchObject({
    messageId: ack.messageId,
    content: [{ type: "text", text: "hi" }],
  });
  expect(events[2]?.source).toEqual({ kind: "runtime" }); // fake adapter: no 'pi' stamp
  expect(events[3]?.payload).toMatchObject({ inResponseTo: ack.messageId });
  expect(events[4]?.payload).toMatchObject({
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
  // deltas stream after message.assistant.started (seq 4) committed
  expect(frames.map((f) => f.afterSeq)).toEqual([4, 4]);
  expect(frames.every((f) => f.branchId === session.rootBranchId)).toBe(true);
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
    "run.started",
    "approval.requested",
    "approval.responded",
    "message.assistant.started",
    "message.assistant.completed",
    "run.completed",
  ]);
  expect(events[6]?.payload).toMatchObject({
    content: [{ type: "text", text: "approval response: selected two" }],
  });
});
