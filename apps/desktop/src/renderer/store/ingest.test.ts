import type { AgenaEvent, AgenaFrame, SessionSummary } from "@agena/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { UiBatch } from "../../shared/bridge.ts";
import {
  __resetAllStores,
  ingestBatch,
  useApprovals,
  useSessions,
  useTranscripts,
} from "./index.ts";

const AT = "2026-07-06T00:00:00.000Z";
const text = (t: string) => ({ type: "text" as const, text: t });

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

beforeEach(() => {
  __resetAllStores();
});

describe("ingestBatch", () => {
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
    expect(t?.live).toBe(true);
    expect(t?.branchId).toBe("b1");
    expect(t?.inFlight).toBeNull(); // stale frame was dropped after finalize
    expect(t?.blocks[1]).toMatchObject({
      kind: "assistant",
      status: "completed",
      content: [text("final answer")],
    });
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
    expect(useApprovals.getState().pending.ap).toMatchObject({
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
    expect(useApprovals.getState().pending).toEqual({});
    expect(useTranscripts.getState().bySession.s1?.blocks[0]).toMatchObject({
      kind: "approval",
      state: "responded",
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
    expect(t?.blocks).toHaveLength(1);
    expect(t?.rawEvents).toHaveLength(1);
  });

  it("bumps session summaries and applies session.status.updated frames", () => {
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
        frames: [frame("session.status.updated", { status: "idle" })],
      }),
    );
    const s = useSessions.getState().byId.s1;
    expect(s?.lastSeq).toBe(5);
    expect(s?.status).toBe("idle");
    // garbage status payloads are ignored
    ingestBatch(
      batch({ frames: [frame("session.status.updated", { status: "🦖" })] }),
    );
    expect(useSessions.getState().byId.s1?.status).toBe("idle");
  });

  it("flags lost sessions in the sessions store", () => {
    ingestBatch(batch({ lostSessions: ["s9"] }));
    expect(useSessions.getState().lost).toEqual(["s9"]);
    ingestBatch(batch({ lostSessions: ["s9"] })); // idempotent
    expect(useSessions.getState().lost).toEqual(["s9"]);
  });
});
