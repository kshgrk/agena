import type { AgenaEvent, AgenaFrame } from "@agena/protocol";
import { describe, expect, it } from "vitest";
import { applyEvent, applyFrame, initialState } from "../src/store.ts";

function ev(seq: number, type: string, payload: unknown): AgenaEvent {
  return {
    sessionId: "s1",
    branchId: "b1",
    seq,
    type,
    v: 1,
    createdAt: "2026-07-06T00:00:00.000Z",
    source: { kind: "runtime", runtime: "pi" },
    payload,
  };
}

function delta(messageId: string, text: string): AgenaFrame {
  return {
    sessionId: "s1",
    branchId: "b1",
    afterSeq: 2,
    emittedAt: "2026-07-06T00:00:00.000Z",
    type: "message.assistant.text.delta",
    payload: { messageId, blockIndex: 0, delta: text },
  };
}

function toolDelta(
  toolCallId: string,
  text: string,
  reset?: boolean,
): AgenaFrame {
  return {
    sessionId: "s1",
    branchId: "b1",
    afterSeq: 2,
    emittedAt: "2026-07-06T00:00:00.000Z",
    type: "tool.call.output.delta",
    payload: { toolCallId, delta: text, ...(reset ? { reset } : {}) },
  };
}

describe("transcript reducer", () => {
  it("streams deltas into the in-flight tail and finalizes from the event", () => {
    let s = initialState;
    s = applyEvent(
      s,
      ev(1, "message.user.created", {
        messageId: "mu",
        content: [{ type: "text", text: "hi" }],
      }),
    );
    expect(s.blocks).toEqual([{ kind: "user", text: "hi" }]);

    s = applyEvent(
      s,
      ev(2, "message.assistant.started", {
        messageId: "ma",
        runId: "r1",
        turnId: "t1",
        model: { provider: "anthropic", id: "m" },
        inResponseTo: "mu",
      }),
    );
    s = applyFrame(s, delta("ma", "Hel"));
    s = applyFrame(s, delta("ma", "lo"));
    s = applyFrame(s, delta("other", "IGNORED")); // mistargeted delta dropped
    expect(s.inFlight).toEqual({ messageId: "ma", text: "Hello" });
    expect(s.blocks).toHaveLength(1); // frames never touch finalized blocks

    // authoritative completed content wins over the accumulated buffer
    s = applyEvent(
      s,
      ev(3, "message.assistant.completed", {
        messageId: "ma",
        content: [{ type: "text", text: "Hello, world!" }],
        model: { provider: "anthropic", id: "m" },
        stopReason: "end_turn",
      }),
    );
    expect(s.inFlight).toBeNull();
    expect(s.blocks.at(-1)).toEqual({
      kind: "assistant",
      text: "Hello, world!",
    });

    // late frame after finalize is dropped
    expect(applyFrame(s, delta("ma", "zombie"))).toEqual(s);
  });

  it("turns a malformed known event into a marker row instead of crashing", () => {
    const s = applyEvent(
      initialState,
      ev(1, "message.user.created", { nope: true }),
    );
    expect(s.blocks).toEqual([
      { kind: "marker", text: "malformed event message.user.created (seq 1)" },
    ]);
    // unknown future types are ignored
    expect(applyEvent(s, ev(2, "wormhole.opened", {}))).toEqual(s);
  });

  it("renders tool lifecycle events as transcript tool rows", () => {
    let s = applyEvent(
      initialState,
      ev(1, "tool.call.started", {
        toolCallId: "tc",
        messageId: "ma",
        runId: "r",
        turnId: "t",
        name: "bash",
        args: { command: "pwd" },
      }),
    );
    s = applyFrame(s, toolDelta("tc", "/work"));
    expect(s.blocks).toEqual([
      { kind: "tool", toolCallId: "tc", text: "tool bash started\n/work" },
    ]);
    s = applyFrame(s, toolDelta("tc", "space"));
    expect(s.blocks).toEqual([
      {
        kind: "tool",
        toolCallId: "tc",
        text: "tool bash started\n/workspace",
      },
    ]);
    s = applyFrame(s, toolDelta("tc", "/tmp", true));
    expect(s.blocks).toEqual([
      { kind: "tool", toolCallId: "tc", text: "tool bash started\n/tmp" },
    ]);
    s = applyEvent(
      s,
      ev(2, "tool.call.completed", {
        toolCallId: "tc",
        result: [{ type: "text", text: "/workspace" }],
        durationMs: 0,
      }),
    );
    expect(s.blocks).toEqual([
      { kind: "tool", toolCallId: "tc", text: "tool completed\n/workspace" },
    ]);
  });
});
