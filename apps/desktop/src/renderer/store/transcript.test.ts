import type {
  AgenaEvent,
  AgenaFrame,
  InFlightSnapshot,
  ModelRef,
} from "@agena/protocol";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applyFrame,
  applySnapshot,
  markSynced,
  prependOlderEvents,
} from "./transcript.ts";
import { emptyTranscript } from "./types.ts";

const MODEL: ModelRef = { provider: "pi", id: "gpt-x" };
const AT = "2026-07-06T00:00:00.000Z";

function ev(seq: number, type: string, payload: unknown): AgenaEvent {
  return {
    sessionId: "s1",
    branchId: "b1",
    seq,
    type,
    v: 1,
    createdAt: AT,
    source: { kind: "runtime", runtime: "pi" },
    payload,
  };
}

function textDelta(
  messageId: string,
  blockIndex: number,
  delta: string,
): AgenaFrame {
  return {
    sessionId: "s1",
    branchId: "b1",
    afterSeq: 2,
    emittedAt: AT,
    type: "message.assistant.text.delta",
    payload: { messageId, blockIndex, delta },
  };
}

function toolDelta(
  toolCallId: string,
  delta: string,
  reset?: boolean,
): AgenaFrame {
  return {
    sessionId: "s1",
    branchId: "b1",
    afterSeq: 2,
    emittedAt: AT,
    type: "tool.call.output.delta",
    payload: { toolCallId, delta, ...(reset ? { reset } : {}) },
  };
}

const text = (t: string) => ({ type: "text" as const, text: t });

const started = (messageId: string) =>
  ev(2, "message.assistant.started", {
    messageId,
    runId: "r1",
    turnId: "t1",
    model: MODEL,
    inResponseTo: "mu",
  });

describe("applyEvent + applyFrame", () => {
  it("runs a full happy turn; completed content replaces accumulated deltas", () => {
    let s = markSynced(emptyTranscript("s1"), 0);
    s = applyEvent(
      s,
      ev(1, "message.user.created", {
        messageId: "mu",
        content: [text("fix it")],
      }),
      true,
    );
    expect(s.blocks[0]).toMatchObject({ kind: "user", messageId: "mu" });

    s = applyEvent(s, started("ma"), false);
    expect(s.inFlight).toMatchObject({ messageId: "ma", blocks: [] });

    s = applyFrame(s, textDelta("ma", 0, "Hel"));
    s = applyFrame(s, textDelta("ma", 0, "lo"));
    expect(s.inFlight?.blocks).toEqual([{ type: "text", text: "Hello" }]);

    s = applyEvent(
      s,
      ev(3, "tool.call.started", {
        toolCallId: "tc",
        messageId: "ma",
        runId: "r1",
        turnId: "t1",
        name: "bash",
        args: { command: "pwd" },
      }),
      false,
    );
    expect(s.toolIndex).toEqual({ tc: 1 });
    s = applyFrame(s, toolDelta("tc", "/work"));
    s = applyFrame(s, toolDelta("tc", "space"));
    expect(s.blocks[1]).toMatchObject({
      kind: "tool",
      status: "running",
      liveOutput: "/workspace",
    });
    s = applyFrame(s, toolDelta("tc", "/tmp", true)); // reset replaces
    expect(s.blocks[1]).toMatchObject({ liveOutput: "/tmp" });

    s = applyEvent(
      s,
      ev(4, "tool.call.completed", {
        toolCallId: "tc",
        result: [text("/workspace")],
        durationMs: 12,
      }),
      false,
    );
    expect(s.blocks[1]).toMatchObject({
      kind: "tool",
      status: "completed",
      result: [text("/workspace")],
      durationMs: 12,
    });

    s = applyEvent(
      s,
      ev(5, "message.assistant.completed", {
        messageId: "ma",
        content: [text("Hello, world!")],
        model: MODEL,
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      false,
    );
    expect(s.inFlight).toBeNull();
    expect(s.blocks[2]).toMatchObject({
      kind: "assistant",
      status: "completed",
      content: [text("Hello, world!")], // authoritative, not "Hello"
      stopReason: "end_turn",
    });
    expect(s.lastSeq).toBe(5);
    expect(s.rawEvents.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(s.branchId).toBe("b1");
  });

  it("finalizes an abort with partial content and clears the tail", () => {
    let s = markSynced(emptyTranscript("s1"), 0);
    s = applyEvent(s, started("ma"), false);
    s = applyFrame(s, textDelta("ma", 0, "half a tho"));
    s = applyEvent(
      s,
      ev(3, "message.assistant.aborted", {
        messageId: "ma",
        partialContent: [text("half a")],
        reason: "user_abort",
      }),
      false,
    );
    expect(s.inFlight).toBeNull();
    expect(s.blocks[0]).toMatchObject({
      kind: "assistant",
      status: "aborted",
      abortReason: "user_abort",
      content: [text("half a")],
      model: MODEL, // carried over from the matching in-flight tail
    });
  });

  it("finalizes a failure with the error payload", () => {
    let s = markSynced(emptyTranscript("s1"), 0);
    s = applyEvent(s, started("ma"), false);
    s = applyEvent(
      s,
      ev(3, "message.assistant.failed", {
        messageId: "ma",
        partialContent: [],
        error: { code: "daemon_restart", message: "daemon restarted mid-turn" },
      }),
      false,
    );
    expect(s.inFlight).toBeNull();
    expect(s.blocks[0]).toMatchObject({
      kind: "assistant",
      status: "failed",
      error: { code: "daemon_restart", message: "daemon restarted mid-turn" },
    });
  });

  it("keeps the turn active after an assistant message completes until the run ends", () => {
    let s = markSynced(emptyTranscript("s1"), 0);
    s = applyEvent(
      s,
      ev(1, "run.started", {
        runId: "r1",
        trigger: "prompt",
        triggerMessageId: "mu",
      }),
      false,
    );
    s = applyEvent(s, started("ma"), false);
    s = applyEvent(
      s,
      ev(3, "message.assistant.completed", {
        messageId: "ma",
        content: [text("I'll check.")],
        model: MODEL,
        stopReason: "tool_use",
      }),
      false,
    );
    expect(s.inFlight).toBeNull();
    expect(s.runtimeStatus).toEqual({ state: "generating" });

    s = applyEvent(
      s,
      ev(4, "tool.call.started", {
        toolCallId: "tc",
        messageId: "ma",
        runId: "r1",
        turnId: "t1",
        name: "bash",
        args: { command: "pwd" },
      }),
      false,
    );
    expect(s.runtimeStatus).toEqual({ state: "generating" });

    s = applyEvent(s, ev(5, "run.completed", { runId: "r1" }), false);
    expect(s.runtimeStatus).toEqual({ state: "idle" });
  });

  it("tracks the approval lifecycle in place", () => {
    let s = emptyTranscript("s1");
    s = applyEvent(
      s,
      ev(1, "approval.requested", {
        approvalId: "ap",
        kind: "confirm",
        message: "run git push?",
      }),
      false,
    );
    expect(s.approvalIndex).toEqual({ ap: 0 });
    expect(s.blocks[0]).toMatchObject({ kind: "approval", state: "pending" });
    s = applyEvent(
      s,
      ev(2, "approval.responded", {
        approvalId: "ap",
        response: { kind: "confirm", accepted: true },
        respondedBy: "client-1",
      }),
      false,
    );
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({
      state: "responded",
      response: { kind: "confirm", accepted: true },
      respondedBy: "client-1",
    });
  });

  it("renders unknown event types as neutral markers and still records raw", () => {
    const s = applyEvent(
      emptyTranscript("s1"),
      ev(1, "wormhole.opened", { x: 1 }),
      false,
    );
    expect(s.blocks[0]).toMatchObject({
      kind: "marker",
      markerKind: "unknown",
      text: "event wormhole.opened (seq 1)",
    });
    expect(s.rawEvents).toHaveLength(1);
    expect(s.lastSeq).toBe(1);
  });

  it("renders malformed known payloads as malformed markers", () => {
    const s = applyEvent(
      emptyTranscript("s1"),
      ev(1, "message.user.created", { nope: true }),
      false,
    );
    expect(s.blocks[0]).toMatchObject({
      kind: "marker",
      markerKind: "malformed",
      text: "malformed event message.user.created (seq 1)",
    });
  });

  it("renders lifecycle marker rows with concise text", () => {
    let s = emptyTranscript("s1");
    s = applyEvent(
      s,
      ev(1, "model.changed", { to: MODEL, reason: "user_selected" }),
      false,
    );
    s = applyEvent(
      s,
      ev(2, "terminal.session.started", {
        terminalId: "term",
        shell: "bash",
        cols: 80,
        rows: 24,
      }),
      false,
    );
    s = applyEvent(
      s,
      ev(3, "run.failed", {
        runId: "r1",
        error: { code: "E_DISPATCH" },
        phase: "dispatch",
      }),
      false,
    );
    // run.started produces no block, only a raw row
    s = applyEvent(
      s,
      ev(4, "run.started", {
        runId: "r2",
        trigger: "prompt",
        triggerMessageId: "mu",
      }),
      false,
    );
    expect(
      s.blocks.map((b) => (b.kind === "marker" ? b.text : b.kind)),
    ).toEqual([
      "model → pi/gpt-x",
      "terminal opened (bash)",
      "run failed at dispatch: E_DISPATCH",
    ]);
    expect(s.rawEvents).toHaveLength(4);
  });

  it("ignores duplicate/older seq", () => {
    const first = ev(1, "message.user.created", {
      messageId: "mu",
      content: [text("hi")],
    });
    const s = applyEvent(emptyTranscript("s1"), first, false);
    expect(applyEvent(s, first, false)).toBe(s);
  });

  it("ignores all frames until the sync marks the session live", () => {
    let s = applyEvent(emptyTranscript("s1"), started("ma"), false);
    expect(applyFrame(s, textDelta("ma", 0, "early"))).toBe(s);
    s = markSynced(s, 2);
    expect(s.live).toBe(true);
    s = applyFrame(s, textDelta("ma", 0, "now"));
    expect(s.inFlight?.blocks).toEqual([{ type: "text", text: "now" }]);
  });

  it("drops deltas with a mismatched messageId and unknown/invalid frames", () => {
    let s = markSynced(
      applyEvent(emptyTranscript("s1"), started("ma"), false),
      2,
    );
    expect(applyFrame(s, textDelta("other", 0, "IGNORED"))).toBe(s);
    const weird: AgenaFrame = {
      sessionId: "s1",
      branchId: "b1",
      afterSeq: 2,
      emittedAt: AT,
      type: "hologram.delta",
      payload: {},
    };
    expect(applyFrame(s, weird)).toBe(s);
    // sparse blockIndex gap-fills with empty text blocks
    s = applyFrame(s, textDelta("ma", 2, "tail"));
    expect(s.inFlight?.blocks).toEqual([
      { type: "text", text: "" },
      { type: "text", text: "" },
      { type: "text", text: "tail" },
    ]);
  });

  it("applySnapshot seeds the tail, merges tool output, and resets on null", () => {
    let s = markSynced(emptyTranscript("s1"), 0);
    s = applyEvent(
      s,
      ev(1, "tool.call.started", {
        toolCallId: "tc",
        messageId: "ma",
        runId: "r1",
        turnId: "t1",
        name: "bash",
        args: {},
      }),
      false,
    );
    const snap: InFlightSnapshot = {
      sessionId: "s1",
      branchId: "b1",
      afterSeq: 1,
      assistant: {
        messageId: "ma",
        model: MODEL,
        blocks: [text("partial"), { type: "thinking", text: "hmm" }],
      },
      toolCalls: [
        { toolCallId: "tc", name: "bash", args: {}, partialOutput: "out" },
      ],
      pendingApprovals: [],
      retry: null,
      queue: { steerCount: 1, followUpCount: 0 },
      status: { state: "retrying", detail: "attempt 2/3" },
    };
    s = applySnapshot(s, snap);
    expect(s.inFlight).toEqual({
      messageId: "ma",
      model: MODEL,
      blocks: [
        { type: "text", text: "partial" },
        { type: "thinking", text: "hmm" },
      ],
    });
    expect(s.blocks[0]).toMatchObject({ kind: "tool", liveOutput: "out" });
    expect(s.runtimeStatus).toEqual({
      state: "retrying",
      detail: "attempt 2/3",
    });
    expect(s.queue).toEqual({ steerCount: 1, followUpCount: 0 });

    s = applySnapshot(s, { ...snap, assistant: null });
    expect(s.inFlight).toBeNull();
  });

  it("prependOlderEvents re-bases indices and resolves in-page terminals", () => {
    let s = markSynced(emptyTranscript("s1"), 0);
    s = applyEvent(
      s,
      ev(10, "tool.call.started", {
        toolCallId: "tc2",
        messageId: "m2",
        runId: "r2",
        turnId: "t2",
        name: "edit",
        args: {},
      }),
      false,
    );
    const page = [
      ev(1, "message.user.created", { messageId: "mu", content: [text("hi")] }),
      ev(2, "tool.call.started", {
        toolCallId: "tc1",
        messageId: "m1",
        runId: "r1",
        turnId: "t1",
        name: "bash",
        args: {},
      }),
      ev(3, "tool.call.completed", {
        toolCallId: "tc1",
        result: [text("ok")],
        durationMs: 5,
      }),
      ev(4, "approval.requested", {
        approvalId: "ap",
        kind: "confirm",
        message: "?",
      }),
    ];
    s = prependOlderEvents(s, page);
    expect(s.blocks.map((b) => b.kind)).toEqual([
      "user",
      "tool",
      "approval",
      "tool",
    ]);
    expect(s.blocks[1]).toMatchObject({
      toolCallId: "tc1",
      status: "completed",
    });
    expect(s.toolIndex).toEqual({ tc1: 1, tc2: 3 });
    expect(s.approvalIndex).toEqual({ ap: 2 });
    expect(s.lastSeq).toBe(10); // prepending never moves the cursor
    expect(s.inFlight).toBeNull();
    expect(s.rawEvents.map((r) => r.seq)).toEqual([1, 2, 3, 4, 10]);
    // frames still hit the shifted running tool
    s = applyFrame(s, toolDelta("tc2", "chunk"));
    expect(s.blocks[3]).toMatchObject({
      toolCallId: "tc2",
      liveOutput: "chunk",
    });
  });
});
