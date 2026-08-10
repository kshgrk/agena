// node --experimental-strip-types --test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { AgenaEvent, AgenaFrame, SessionSummary } from "@agena/protocol";
import type { UiBatch } from "../../shared/bridge.ts";
import {
  __resetAllStores,
  buildCursorRecord,
  emptyTranscript,
  ingestBatch,
  useApprovals,
  useConnection,
  useSessions,
  useTranscripts,
} from "./index.ts";

const AT = "2026-07-06T00:00:00.000Z";
const text = (t: string) => ({ type: "text" as const, text: t });

/** Partial match: every key in `expected` deep-equals the actual value. */
function matchObject(actual: unknown, expected: Record<string, unknown>): void {
  assert.ok(
    actual !== null && typeof actual === "object",
    `expected an object, got ${String(actual)}`,
  );
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual((actual as Record<string, unknown>)[k], v, `key "${k}"`);
  }
}

function ev(
  seq: number,
  type: string,
  payload: unknown,
  sessionId = "s1",
): AgenaEvent {
  return {
    sessionId,
    branchId: "b1",
    seq,
    type,
    v: 1,
    createdAt: AT,
    source: { kind: "runtime", runtime: "pi" },
    payload,
  };
}

function frame(type: string, payload: unknown): AgenaFrame {
  return {
    sessionId: "s1",
    branchId: "b1",
    afterSeq: 0,
    emittedAt: AT,
    type,
    payload,
  };
}

function batch(partial: Partial<UiBatch>): UiBatch {
  return {
    events: [],
    frames: [],
    syncs: [],
    snapshots: [],
    lostSessions: [],
    ...partial,
  };
}

const summary: SessionSummary = {
  sessionId: "s1",
  workspaceId: "w1",
  rootBranchId: "b1",
  lastSeq: 0,
  createdAt: AT,
  updatedAt: AT,
  scope: "project",
  status: "active",
  projectId: "p1",
  projectRoot: "/w",
  cwd: "/w",
};

describe("ingestBatch", () => {
  beforeEach(() => {
    __resetAllStores();
  });

  it("applies events → syncs → frames: a finalize beats a stale delta in the same batch", () => {
    ingestBatch(
      batch({
        events: [
          {
            event: ev(1, "message.user.created", {
              messageId: "mu",
              content: [text("hi")],
            }),
            replayed: true,
          },
          {
            event: ev(2, "message.assistant.started", {
              messageId: "ma",
              runId: "r1",
              turnId: "t1",
              model: { provider: "pi", id: "gpt-x" },
              inResponseTo: "mu",
            }),
            replayed: true,
          },
          {
            event: ev(3, "message.assistant.completed", {
              messageId: "ma",
              content: [text("final answer")],
              model: { provider: "pi", id: "gpt-x" },
              stopReason: "end_turn",
            }),
            replayed: false,
          },
        ],
        syncs: [{ sessionId: "s1", branchId: "b1", upToSeq: 3 }],
        frames: [
          frame("message.assistant.text.delta", {
            messageId: "ma",
            blockIndex: 0,
            delta: "stale delta",
          }),
        ],
      }),
    );
    const t = useTranscripts.getState().bySession.s1;
    assert.equal(t?.live, true);
    assert.equal(t?.branchId, "b1");
    assert.equal(t?.inFlight, null); // stale frame was dropped after finalize
    matchObject(t?.blocks[1], {
      kind: "assistant",
      status: "completed",
      content: [text("final answer")],
    });
  });

  it("gates frames until the session's sync arrives", () => {
    ingestBatch(
      batch({
        events: [
          {
            event: ev(1, "message.assistant.started", {
              messageId: "ma",
              runId: "r1",
              turnId: "t1",
              model: { provider: "pi", id: "gpt-x" },
              inResponseTo: "mu",
            }),
            replayed: true,
          },
        ],
        // no sync in this batch: the delta must be dropped
        frames: [
          frame("message.assistant.text.delta", {
            messageId: "ma",
            blockIndex: 0,
            delta: "too early",
          }),
        ],
      }),
    );
    let t = useTranscripts.getState().bySession.s1;
    assert.equal(t?.live, false);
    assert.deepEqual(t?.inFlight?.blocks, []);

    // after the sync, identical frames apply
    ingestBatch(
      batch({
        syncs: [{ sessionId: "s1", branchId: "b1", upToSeq: 1 }],
        frames: [
          frame("message.assistant.text.delta", {
            messageId: "ma",
            blockIndex: 0,
            delta: "now",
          }),
        ],
      }),
    );
    t = useTranscripts.getState().bySession.s1;
    assert.equal(t?.live, true);
    assert.deepEqual(t?.inFlight?.blocks, [{ type: "text", text: "now" }]);
  });

  it("routes approval events to the approvals store (add then remove)", () => {
    ingestBatch(
      batch({
        events: [
          {
            event: ev(1, "approval.requested", {
              approvalId: "ap",
              kind: "confirm",
              message: "push?",
            }),
            replayed: false,
          },
        ],
      }),
    );
    matchObject(useApprovals.getState().pending.ap, {
      sessionId: "s1",
      approvalId: "ap",
      seq: 1,
    });

    ingestBatch(
      batch({
        events: [
          {
            event: ev(2, "approval.responded", {
              approvalId: "ap",
              response: { kind: "confirm", accepted: false },
              respondedBy: "client-9",
            }),
            replayed: false,
          },
        ],
      }),
    );
    assert.deepEqual(useApprovals.getState().pending, {});
    matchObject(useTranscripts.getState().bySession.s1?.blocks[0], {
      kind: "approval",
      state: "responded",
    });
  });

  it("syncs fast mode changes into loaded runtime controls", () => {
    useConnection.getState().setRuntime("s1", {
      thinkingLevel: "medium",
      availableModels: [],
      availableThinkingLevels: ["medium"],
      fastMode: { enabled: false, available: true, active: false },
      slashCommands: [],
    });
    ingestBatch(
      batch({
        events: [
          {
            event: ev(1, "fast.mode.changed", { enabled: true }),
            replayed: false,
          },
        ],
      }),
    );
    assert.deepEqual(useConnection.getState().runtime.s1?.fastMode, {
      enabled: true,
      available: true,
      active: true,
    });
  });

  it("creates transcripts on first sight and dedupes re-delivered events", () => {
    const e = {
      event: ev(1, "message.user.created", {
        messageId: "mu",
        content: [text("x")],
      }),
      replayed: true,
    };
    ingestBatch(batch({ events: [e] }));
    ingestBatch(batch({ events: [e] })); // duplicate delivery
    const t = useTranscripts.getState().bySession.s1;
    assert.equal(t?.blocks.length, 1);
    assert.equal(t?.rawEvents.length, 1);
  });

  it("bumps session summaries and applies runtime status frames", () => {
    useSessions.getState().setAll([summary]);
    ingestBatch(
      batch({
        events: [
          {
            event: ev(5, "message.user.created", {
              messageId: "mu",
              content: [text("x")],
            }),
            replayed: false,
          },
        ],
        syncs: [{ sessionId: "s1", branchId: "b1", upToSeq: 5 }],
        frames: [
          frame("session.status.updated", {
            state: "compacting",
            detail: "reducing task context",
          }),
        ],
      }),
    );
    const s = useSessions.getState().byId.s1;
    assert.equal(s?.lastSeq, 5);
    assert.equal(s?.status, "active");
    assert.equal(useTranscripts.getState().bySession.s1?.blocks.length, 1);
    assert.deepEqual(useTranscripts.getState().bySession.s1?.runtimeStatus, {
      state: "compacting",
      detail: "reducing task context",
    });
    // malformed runtime states are ignored
    ingestBatch(
      batch({ frames: [frame("session.status.updated", { state: "🦖" })] }),
    );
    assert.deepEqual(useTranscripts.getState().bySession.s1?.runtimeStatus, {
      state: "compacting",
      detail: "reducing task context",
    });
  });

  it("moves a session to the top as soon as a durable event arrives", () => {
    useSessions.getState().setAll([
      { ...summary, updatedAt: "2026-07-01T00:00:00.000Z" },
      {
        ...summary,
        sessionId: "s2",
        updatedAt: "2026-07-05T00:00:00.000Z",
      },
    ]);
    assert.deepEqual(useSessions.getState().order, ["s2", "s1"]);

    ingestBatch(
      batch({
        events: [
          {
            event: ev(1, "message.user.created", {
              messageId: "mu",
              content: [text("latest")],
            }),
            replayed: false,
          },
        ],
      }),
    );

    assert.deepEqual(useSessions.getState().order, ["s1", "s2"]);
  });

  it("routes session.title.changed to the sessions store", () => {
    useSessions.getState().setAll([summary]);
    ingestBatch(
      batch({
        events: [
          {
            event: ev(2, "session.title.changed", { title: "fix the bug" }),
            replayed: false,
          },
        ],
      }),
    );
    assert.equal(useSessions.getState().byId.s1?.title, "fix the bug");
    // and it stays out of the block list (rawEvents only)
    const t = useTranscripts.getState().bySession.s1;
    assert.equal(t?.blocks.length, 0);
    assert.equal(t?.rawEvents.length, 1);
  });

  it("flags lost sessions in the sessions store", () => {
    ingestBatch(batch({ lostSessions: ["s9"] }));
    assert.deepEqual(useSessions.getState().lost, ["s9"]);
    ingestBatch(batch({ lostSessions: ["s9"] })); // idempotent
    assert.deepEqual(useSessions.getState().lost, ["s9"]);
  });

  it("keeps sessions independent: one batch touching two sessions", () => {
    ingestBatch(
      batch({
        events: [
          {
            event: ev(1, "message.user.created", {
              messageId: "m1",
              content: [text("a")],
            }),
            replayed: false,
          },
          {
            event: ev(
              4,
              "message.user.created",
              { messageId: "m2", content: [text("b")] },
              "s2",
            ),
            replayed: false,
          },
        ],
        syncs: [{ sessionId: "s2", branchId: "b2", upToSeq: 4 }],
      }),
    );
    const st = useTranscripts.getState();
    assert.equal(st.bySession.s1?.lastSeq, 1);
    assert.equal(st.bySession.s1?.live, false);
    assert.equal(st.bySession.s2?.lastSeq, 4);
    assert.equal(st.bySession.s2?.live, true);
    // the first-applied event's branchId sticks; the sync only fills null
    assert.equal(st.bySession.s2?.branchId, "b1");
  });

  it("a sync for an unseen session seeds its transcript with the sync branchId", () => {
    ingestBatch(
      batch({ syncs: [{ sessionId: "s3", branchId: "b3", upToSeq: 12 }] }),
    );
    const t = useTranscripts.getState().bySession.s3;
    assert.equal(t?.live, true);
    assert.equal(t?.lastSeq, 12);
    assert.equal(t?.branchId, "b3");
  });
});

describe("buildCursorRecord", () => {
  beforeEach(() => {
    __resetAllStores();
  });

  it("emits the FULL cursor map from applied transcripts, pruning lost sessions", () => {
    ingestBatch(
      batch({
        events: [
          {
            event: ev(3, "message.user.created", {
              messageId: "m1",
              content: [text("a")],
            }),
            replayed: false,
          },
          {
            event: ev(
              7,
              "message.user.created",
              { messageId: "m2", content: [text("b")] },
              "s2",
            ),
            replayed: false,
          },
        ],
        syncs: [{ sessionId: "s1", branchId: "b1", upToSeq: 3 }],
      }),
    );
    const st = useTranscripts.getState().bySession;
    assert.deepEqual(buildCursorRecord(st, []), {
      s1: { branchId: "b1", seq: 3 },
      s2: { branchId: "b1", seq: 7 },
    });
    // a lost session's cursor is dropped by omission (full-record write)
    assert.deepEqual(buildCursorRecord(st, ["s2"]), {
      s1: { branchId: "b1", seq: 3 },
    });
  });

  it("seeds from the on-disk base so sessions not loaded this run keep their cursors", () => {
    const base = {
      unloaded: { branchId: "b0", seq: 42 },
      stale: { branchId: "b0", seq: 5 },
      gone: { branchId: "b0", seq: 9 },
    };
    ingestBatch(
      batch({
        events: [
          {
            event: ev(
              10,
              "message.user.created",
              { messageId: "m1", content: [text("a")] },
              "stale",
            ),
            replayed: false,
          },
        ],
      }),
    );
    const st = useTranscripts.getState().bySession;
    assert.deepEqual(buildCursorRecord(st, ["gone"], base), {
      unloaded: { branchId: "b0", seq: 42 }, // untouched this run → kept
      stale: { branchId: "b1", seq: 10 }, // loaded this run → overwritten
      // gone: lost by the daemon → deleted from the base too
    });
    // the base record itself is never mutated
    assert.equal(base.gone.seq, 9);
    assert.equal(base.stale.seq, 5);
  });

  it("skips sessions with no durably applied events", () => {
    assert.deepEqual(
      buildCursorRecord(
        {
          s0: {
            ...emptyTranscript("s0"),
            sessionId: "s0",
          },
        },
        [],
      ),
      {},
    );
  });
});
