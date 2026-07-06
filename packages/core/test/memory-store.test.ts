import type { EventSource } from "@agena/protocol";
import { ulid } from "ulid";
import { expect, test } from "vitest";
import type { AppendEventsResult, NewEvent } from "../src/events/store.ts";
import { InMemoryEventStore } from "../src/memory-store.ts";

const user: EventSource = { kind: "user" };
const userMessage = (text: string): NewEvent => ({
  type: "message.user.created",
  v: 1,
  source: user,
  payload: { messageId: ulid(), content: [{ type: "text", text }] },
});

test("assigns contiguous per-session seqs and replay returns exactly what was appended", async () => {
  const store = new InMemoryEventStore();
  const session = await store.createSession({
    workspaceId: "ws-1",
    title: "t",
  });
  expect(session.lastSeq).toBe(1); // session.created

  const res = await store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [userMessage("one"), userMessage("two")],
  });
  expect(res.events.map((e) => e.seq)).toEqual([2, 3]);
  expect(res.lastSeq).toBe(3);

  const all = await store.readEvents(session.sessionId, 0);
  expect(all.events.map((e) => e.type)).toEqual([
    "session.created",
    "message.user.created",
    "message.user.created",
  ]);
  expect(all.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(all.events.slice(1)).toEqual(res.events); // replay is exactly the appended events
  expect(all.nextFromSeq).toBeNull();

  const page = await store.readEvents(session.sessionId, 1, 1); // fromSeq exclusive
  expect(page.events.map((e) => e.seq)).toEqual([2]);
  expect(page.nextFromSeq).toBe(2);
});

test("onCommitted fires after the append, once per batch, and a throwing listener cannot un-commit", async () => {
  const store = new InMemoryEventStore();
  const session = await store.createSession({ workspaceId: "ws-1" });

  const batches: Array<AppendEventsResult & { sessionId: string }> = [];
  let appendResolved = false;
  store.onCommitted(() => {
    throw new Error("listener boom");
  });
  store.onCommitted((batch) => {
    expect(appendResolved).toBe(false); // fanout happens inside the append, post-commit (§6.2)
    batches.push(batch);
  });

  const res = await store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [userMessage("hi")],
  });
  appendResolved = true;

  expect(batches).toHaveLength(1);
  expect(batches[0]?.lastSeq).toBe(res.lastSeq);
  expect(batches[0]?.events).toEqual(res.events); // seqs already assigned at fanout time
  const { events } = await store.readEvents(session.sessionId, 0);
  expect(events.at(-1)?.seq).toBe(res.lastSeq); // the throwing listener lost nothing
});

test("rejects non-durable types and invalid payloads without mutating state (P12)", async () => {
  const store = new InMemoryEventStore();
  const session = await store.createSession({ workspaceId: "ws-1" });

  await expect(
    store.appendEvents({
      sessionId: session.sessionId,
      branchId: session.rootBranchId,
      events: [
        {
          type: "message.assistant.text.delta",
          v: 1,
          source: user,
          payload: {},
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "not_a_durable_event" });

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

  const { events } = await store.readEvents(session.sessionId, 0);
  expect(events.map((e) => e.type)).toEqual(["session.created"]); // batch was atomic
});
