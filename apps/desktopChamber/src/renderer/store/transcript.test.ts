// node --experimental-strip-types --test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AgenaEvent,
  AgenaFrame,
  InFlightSnapshot,
  ModelRef,
} from "@agena/protocol";
import {
  activeBranchBlocks,
  applyEvent,
  applyFrame,
  applySnapshot,
  applyToolCallDetail,
  markSynced,
  mergeCompactTranscript,
  needsRecentHistory,
  prependOlderEvents,
  useTranscripts,
} from "./transcript.ts";
import { emptyTranscript } from "./types.ts";

const MODEL: ModelRef = { provider: "pi", id: "gpt-x" };
const AT = "2026-07-06T00:00:00.000Z";

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
  it("renders only the active Pi edit branch", () => {
    let state = markSynced(emptyTranscript("s1"), 0);
    const events = [
      ev(1, "message.user.created", { messageId: "a", content: [text("a")] }),
      ev(2, "message.assistant.started", {
        messageId: "ra",
        runId: "r1",
        turnId: "t1",
        model: MODEL,
        inResponseTo: "a",
      }),
      ev(3, "message.assistant.completed", {
        messageId: "ra",
        content: [text("ra")],
        model: MODEL,
        stopReason: "end_turn",
      }),
      ev(4, "message.user.created", { messageId: "b", content: [text("b")] }),
      ev(5, "message.assistant.started", {
        messageId: "rb",
        runId: "r2",
        turnId: "t2",
        model: MODEL,
        inResponseTo: "b",
      }),
      ev(6, "message.assistant.completed", {
        messageId: "rb",
        content: [text("rb")],
        model: MODEL,
        stopReason: "end_turn",
      }),
      ev(7, "message.user.created", {
        messageId: "a2",
        content: [text("a edited")],
        editedFromMessageId: "a",
      }),
      ev(8, "message.assistant.started", {
        messageId: "ra2",
        runId: "r3",
        turnId: "t3",
        model: MODEL,
        inResponseTo: "a2",
      }),
      ev(9, "message.assistant.completed", {
        messageId: "ra2",
        content: [text("ra2")],
        model: MODEL,
        stopReason: "end_turn",
      }),
    ];
    for (const event of events) state = applyEvent(state, event, false);

    assert.deepEqual(
      activeBranchBlocks(state.rawEvents, state.blocks).map((block) =>
        block.kind === "user"
          ? block.messageId
          : block.kind === "assistant"
            ? block.messageId
            : block.kind,
      ),
      ["a2", "ra2"],
    );

    let secondState = markSynced(emptyTranscript("s1"), 0);
    const secondEvents = [
      ev(1, "message.user.created", { messageId: "a", content: [text("a")] }),
      ev(2, "message.user.created", { messageId: "b", content: [text("b")] }),
      ev(3, "message.user.created", { messageId: "c", content: [text("c")] }),
      ev(4, "message.user.created", {
        messageId: "b2",
        content: [text("b edited")],
        editedFromMessageId: "b",
      }),
      ev(5, "message.user.created", { messageId: "d", content: [text("d")] }),
    ];
    for (const event of secondEvents) {
      secondState = applyEvent(secondState, event, false);
    }
    assert.deepEqual(
      activeBranchBlocks(secondState.rawEvents, secondState.blocks)
        .filter((block) => block.kind === "user")
        .map((block) => block.messageId),
      ["a", "b2", "d"],
    );
  });

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
    matchObject(s.blocks[0], { kind: "user", messageId: "mu" });

    s = applyEvent(s, started("ma"), false);
    matchObject(s.inFlight, { messageId: "ma", blocks: [] });

    // delta coalescing: consecutive deltas concatenate per (messageId, blockIndex)
    s = applyFrame(s, textDelta("ma", 0, "Hel"));
    s = applyFrame(s, textDelta("ma", 0, "lo"));
    assert.deepEqual(s.inFlight?.blocks, [{ type: "text", text: "Hello" }]);

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
    assert.deepEqual(s.toolIndex, { tc: 1 });
    s = applyFrame(s, toolDelta("tc", "/work"));
    s = applyFrame(s, toolDelta("tc", "space"));
    matchObject(s.blocks[1], {
      kind: "tool",
      status: "running",
      liveOutput: "/workspace",
    });
    // reset semantics: a reset delta REPLACES the accumulation
    s = applyFrame(s, toolDelta("tc", "/tmp", true));
    matchObject(s.blocks[1], { liveOutput: "/tmp" });

    s = applyEvent(
      s,
      ev(4, "tool.call.completed", {
        toolCallId: "tc",
        result: [text("/workspace")],
        durationMs: 12,
      }),
      false,
    );
    matchObject(s.blocks[1], {
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
    assert.equal(s.inFlight, null);
    matchObject(s.blocks[2], {
      kind: "assistant",
      status: "completed",
      content: [text("Hello, world!")], // authoritative, not "Hello"
      stopReason: "end_turn",
    });
    assert.equal(s.lastSeq, 5);
    assert.deepEqual(
      s.rawEvents.map((r) => r.seq),
      [1, 2, 3, 4, 5],
    );
    assert.equal(s.branchId, "b1");
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
    assert.equal(s.inFlight, null);
    matchObject(s.blocks[0], {
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
    assert.equal(s.inFlight, null);
    matchObject(s.blocks[0], {
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
    assert.equal(s.inFlight, null);
    assert.deepEqual(s.runtimeStatus, { state: "generating" });

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
    assert.deepEqual(s.runtimeStatus, { state: "generating" });

    s = applyEvent(s, ev(5, "run.completed", { runId: "r1" }), false);
    assert.deepEqual(s.runtimeStatus, { state: "idle" });
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
    assert.deepEqual(s.approvalIndex, { ap: 0 });
    matchObject(s.blocks[0], { kind: "approval", state: "pending" });
    s = applyEvent(
      s,
      ev(2, "approval.responded", {
        approvalId: "ap",
        response: { kind: "confirm", accepted: true },
        respondedBy: "client-1",
      }),
      false,
    );
    assert.equal(s.blocks.length, 1);
    matchObject(s.blocks[0], {
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
    matchObject(s.blocks[0], {
      kind: "marker",
      markerKind: "unknown",
      text: "event wormhole.opened (seq 1)",
    });
    assert.equal(s.rawEvents.length, 1);
    assert.equal(s.lastSeq, 1);
  });

  it("renders malformed known payloads as malformed markers", () => {
    const s = applyEvent(
      emptyTranscript("s1"),
      ev(1, "message.user.created", { nope: true }),
      false,
    );
    matchObject(s.blocks[0], {
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
    assert.deepEqual(
      s.blocks.map((b) => (b.kind === "marker" ? b.text : b.kind)),
      [
        "model → pi/gpt-x",
        "terminal opened (bash)",
        "run failed at dispatch: E_DISPATCH",
      ],
    );
    assert.equal(s.rawEvents.length, 4);
  });

  it("ignores duplicate/older seq (identity-stable)", () => {
    const first = ev(1, "message.user.created", {
      messageId: "mu",
      content: [text("hi")],
    });
    const s = applyEvent(emptyTranscript("s1"), first, false);
    assert.equal(applyEvent(s, first, false), s);
    // an OLDER seq is dropped too, not just the same one
    const older = ev(1, "message.user.created", {
      messageId: "mu2",
      content: [text("stale")],
    });
    const s2 = applyEvent({ ...s, lastSeq: 5 }, older, false);
    assert.equal(s2.blocks.length, s.blocks.length);
  });

  it("ignores all frames until the sync marks the session live", () => {
    let s = applyEvent(emptyTranscript("s1"), started("ma"), false);
    assert.equal(applyFrame(s, textDelta("ma", 0, "early")), s);
    s = markSynced(s, 2);
    assert.equal(s.live, true);
    s = applyFrame(s, textDelta("ma", 0, "now"));
    assert.deepEqual(s.inFlight?.blocks, [{ type: "text", text: "now" }]);
  });

  it("markSynced never regresses lastSeq", () => {
    const s = markSynced({ ...emptyTranscript("s1"), lastSeq: 9 }, 4);
    assert.equal(s.lastSeq, 9);
    assert.equal(s.live, true);
  });

  it("loads recent history when one event replayed after a saved cursor", () => {
    const oneReplayed = markSynced(
      applyEvent(
        emptyTranscript("s1"),
        ev(923, "terminal.session.ended", {
          terminalId: "term-1",
          exitCode: 0,
          reason: "exit",
        }),
        true,
      ),
      923,
    );
    assert.equal(needsRecentHistory(oneReplayed), true);
    const first = oneReplayed.rawEvents[0];
    assert.ok(first);
    assert.equal(
      needsRecentHistory({
        ...oneReplayed,
        rawEvents: [{ ...first, seq: 724 }],
      }),
      false,
    );
  });

  it("drops deltas with a mismatched messageId and unknown/invalid frames", () => {
    let s = markSynced(
      applyEvent(emptyTranscript("s1"), started("ma"), false),
      2,
    );
    assert.equal(applyFrame(s, textDelta("other", 0, "IGNORED")), s);
    const weird: AgenaFrame = {
      sessionId: "s1",
      branchId: "b1",
      afterSeq: 2,
      emittedAt: AT,
      type: "hologram.delta",
      payload: {},
    };
    assert.equal(applyFrame(s, weird), s);
    // sparse blockIndex gap-fills with empty text blocks
    s = applyFrame(s, textDelta("ma", 2, "tail"));
    assert.deepEqual(s.inFlight?.blocks, [
      { type: "text", text: "" },
      { type: "text", text: "" },
      { type: "text", text: "tail" },
    ]);
  });

  it("drops tool output deltas for unindexed tool calls", () => {
    const s = markSynced(emptyTranscript("s1"), 0);
    assert.equal(applyFrame(s, toolDelta("ghost", "boo")), s);
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
    assert.deepEqual(s.inFlight, {
      messageId: "ma",
      model: MODEL,
      blocks: [
        { type: "text", text: "partial" },
        { type: "thinking", text: "hmm" },
      ],
    });
    matchObject(s.blocks[0], { kind: "tool", liveOutput: "out" });
    assert.deepEqual(s.runtimeStatus, {
      state: "retrying",
      detail: "attempt 2/3",
    });
    assert.deepEqual(s.queue, { steerCount: 1, followUpCount: 0 });

    s = applySnapshot(s, { ...snap, assistant: null });
    assert.equal(s.inFlight, null);
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
    assert.deepEqual(
      s.blocks.map((b) => b.kind),
      ["user", "tool", "approval", "tool"],
    );
    matchObject(s.blocks[1], { toolCallId: "tc1", status: "completed" });
    assert.deepEqual(s.toolIndex, { tc1: 1, tc2: 3 });
    assert.deepEqual(s.approvalIndex, { ap: 2 });
    assert.equal(s.lastSeq, 10); // prepending never moves the cursor
    assert.equal(s.inFlight, null);
    assert.deepEqual(
      s.rawEvents.map((r) => r.seq),
      [1, 2, 3, 4, 10],
    );
    // frames still hit the shifted running tool
    s = applyFrame(s, toolDelta("tc2", "chunk"));
    matchObject(s.blocks[3], { toolCallId: "tc2", liveOutput: "chunk" });
  });

  it("prependOlderEvents is a no-op on an empty page and preserves live/queue", () => {
    const s = markSynced(emptyTranscript("s1"), 7);
    assert.equal(prependOlderEvents(s, []), s);
    const withQueue = { ...s, queue: { steerCount: 2, followUpCount: 1 } };
    const out = prependOlderEvents(withQueue, [
      ev(1, "message.user.created", { messageId: "mu", content: [text("x")] }),
    ]);
    assert.equal(out.live, true);
    assert.equal(out.lastSeq, 7);
    assert.deepEqual(out.queue, { steerCount: 2, followUpCount: 1 });
  });

  it("revealSeq loads contiguous older pages through the target", async () => {
    const calls: number[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        agena: {
          readEvents: async (_sessionId: string, opts: { fromSeq: number }) => {
            calls.push(opts.fromSeq);
            const end = Math.min(opts.fromSeq + 1_000, 2_500);
            return {
              events: Array.from({ length: end - opts.fromSeq }, (_, index) =>
                ev(opts.fromSeq + index + 1, "test.marker", {}),
              ),
              nextFromSeq: null,
            };
          },
        },
      },
    });
    const latest = markSynced(
      applyEvent(emptyTranscript("s1"), ev(2_501, "test.marker", {}), false),
      2_501,
    );
    useTranscripts.setState({
      bySession: { s1: latest },
      loadingOlder: {},
    });

    await useTranscripts.getState().revealSeq("s1", 2);

    assert.deepEqual(calls, [1_500, 500, 0]);
    const events = useTranscripts.getState().bySession.s1?.rawEvents;
    assert.equal(events?.[0]?.seq, 1);
    assert.equal(events?.at(-1)?.seq, 2_501);
    Reflect.deleteProperty(globalThis, "window");
  });

  it("materializes compact turns without heavyweight tool output", () => {
    const compact = mergeCompactTranscript(
      emptyTranscript("s1"),
      {
        sessionId: "s1",
        branchId: "b1",
        upToSeq: 4_373,
        hasOlder: true,
        hasNewer: false,
        turns: [
          {
            user: {
              kind: "user",
              seq: 4_000,
              at: AT,
              source: { kind: "user", clientId: "desktop" },
              messageId: "u1",
              content: [text("question")],
            },
            entries: [
              {
                kind: "tool",
                seq: 4_002,
                at: AT,
                source: { kind: "runtime", runtime: "pi" },
                toolCallId: "tc1",
                messageId: "a1",
                name: "bash",
                argsPreview: "pnpm test",
                status: "completed",
                durationMs: 25,
                media: [
                  {
                    type: "image",
                    ref: {
                      blob: `sha256:${"a".repeat(64)}`,
                      sizeBytes: 42,
                      mimeType: "image/png",
                    },
                  },
                ],
                hasDetails: true,
              },
            ],
          },
        ],
      },
      "replace",
    );
    assert.equal(compact.lastSeq, 4_373);
    assert.equal(compact.historyInitialized, true);
    assert.equal(compact.hasOlderHistory, true);
    matchObject(compact.blocks[1], {
      kind: "tool",
      args: "pnpm test",
      detailsState: "summary",
      result: [
        {
          type: "image",
          ref: {
            blob: `sha256:${"a".repeat(64)}`,
            sizeBytes: 42,
            mimeType: "image/png",
          },
        },
      ],
    });
  });

  it("hydrates one compact tool card from lazy projected detail", () => {
    const initial = mergeCompactTranscript(
      emptyTranscript("s1"),
      {
        sessionId: "s1",
        branchId: "b1",
        upToSeq: 5,
        hasOlder: false,
        hasNewer: false,
        turns: [
          {
            user: {
              kind: "user",
              seq: 1,
              at: AT,
              source: { kind: "user", clientId: "desktop" },
              messageId: "u1",
              content: [text("go")],
            },
            entries: [
              {
                kind: "tool",
                seq: 3,
                at: AT,
                source: { kind: "runtime", runtime: "pi" },
                toolCallId: "tc1",
                messageId: "a1",
                name: "bash",
                argsPreview: "pnpm test",
                status: "completed",
                hasDetails: true,
              },
            ],
          },
        ],
      },
      "replace",
    );
    const hydrated = applyToolCallDetail(initial, {
      toolCallId: "tc1",
      sessionId: "s1",
      branchId: "b1",
      messageId: "a1",
      name: "bash",
      args: { command: "pnpm test" },
      result: [text("85 tests passed")],
      status: "ok",
      startedSeq: 3,
      endedSeq: 4,
      createdAt: AT,
    });
    matchObject(hydrated.blocks[1], {
      detailsState: "loaded",
      args: { command: "pnpm test" },
      result: [text("85 tests passed")],
    });
  });
});
