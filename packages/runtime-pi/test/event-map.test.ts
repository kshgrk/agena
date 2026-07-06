// Suite-2 seed (§13): a hand-written Pi-shaped fixture folded through the pure
// mapper, asserting the exact M1 RuntimeEvent stream. No live-API calls; the
// recorded-capture pipeline replaces hand fixtures in M2 (§8.8).
import type { RuntimeEvent } from "@agena/core";
import type {
  AssistantMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createMapperState, mapPiEvent } from "../src/event-map.ts";

const usage: Usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: {
    input: 0.0005,
    output: 0.0005,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.001,
  },
};

function assistant(text: string): AssistantMessage {
  return assistantWithStop(text, "stop");
}

function assistantWithStop(
  text: string,
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test-1",
    usage,
    stopReason,
    timestamp: 0,
  };
}

const user: UserMessage = { role: "user", content: "hi", timestamp: 0 };
const final = assistant("Hello");

const fixture: AgentSessionEvent[] = [
  { type: "agent_start" },
  { type: "message_start", message: user }, // echo of our own prompt — suppressed (§8.4)
  { type: "message_end", message: user },
  { type: "turn_start" },
  { type: "message_start", message: assistant("") },
  {
    type: "message_update",
    message: assistant(""),
    assistantMessageEvent: {
      type: "text_start",
      contentIndex: 0,
      partial: assistant(""),
    },
  },
  {
    type: "message_update",
    message: assistant("Hel"),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "Hel",
      partial: assistant("Hel"),
    },
  },
  {
    type: "message_update",
    message: assistant("Hello"),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "lo",
      partial: assistant("Hello"),
    },
  },
  {
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "bash",
    args: {},
  }, // M1: log-and-drop
  {
    type: "message_update",
    message: final,
    assistantMessageEvent: {
      type: "text_end",
      contentIndex: 0,
      content: "Hello",
      partial: final,
    },
  },
  { type: "message_end", message: final },
  { type: "turn_end", message: final, toolResults: [] },
  { type: "agent_end", messages: [final], willRetry: false },
];

it("maps the M1 text-streaming fixture to the exact RuntimeEvent stream", () => {
  let n = 0;
  const state = createMapperState(() => `id-${++n}`);
  state.triggerMessageId = "m-user"; // what prompt() registers (§8.5)
  const out = fixture.flatMap((ev) => mapPiEvent(state, ev));
  expect(out).toEqual([
    {
      type: "run-started",
      runId: "id-1",
      trigger: "prompt",
      triggerMessageId: "m-user",
    },
    {
      type: "assistant-message-started",
      messageId: "id-3",
      runId: "id-1",
      turnId: "id-2",
      model: { provider: "anthropic", id: "claude-test-1" },
    },
    {
      type: "assistant-text-delta",
      messageId: "id-3",
      blockIndex: 0,
      delta: "Hel",
    },
    {
      type: "assistant-text-delta",
      messageId: "id-3",
      blockIndex: 0,
      delta: "lo",
    },
    {
      type: "assistant-message-completed",
      messageId: "id-3",
      runId: "id-1",
      turnId: "id-2",
      model: { provider: "anthropic", id: "claude-test-1" },
      blocks: [{ type: "text", text: "Hello" }],
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      stopReason: "end_turn",
    },
    { type: "run-completed", runId: "id-1" },
  ] satisfies RuntimeEvent[]);
});

it("normalizes Pi stop reasons to protocol stop reasons", () => {
  const cases = [
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["toolUse", "tool_use"],
    ["aborted", "end_turn"],
    ["error", "end_turn"],
  ] as const;

  for (const [piStopReason, stopReason] of cases) {
    const state = createMapperState(() => "id-1");
    state.runId = "run-1";
    state.turnId = "turn-1";
    state.messageId = "message-1";
    expect(
      mapPiEvent(state, {
        type: "message_end",
        message: assistantWithStop("Hello", piStopReason),
      }),
    ).toEqual([
      {
        type: "assistant-message-completed",
        messageId: "message-1",
        runId: "run-1",
        turnId: "turn-1",
        model: { provider: "anthropic", id: "claude-test-1" },
        blocks: [{ type: "text", text: "Hello" }],
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        stopReason,
      },
    ] satisfies RuntimeEvent[]);
  }
});

it("keeps the run open across agent_end with willRetry", () => {
  const state = createMapperState(() => "r1");
  expect(mapPiEvent(state, { type: "agent_start" })).toHaveLength(1);
  expect(
    mapPiEvent(state, { type: "agent_end", messages: [], willRetry: true }),
  ).toEqual([]);
  expect(
    mapPiEvent(state, { type: "agent_end", messages: [], willRetry: false }),
  ).toEqual([{ type: "run-completed", runId: "r1" }]);
});
