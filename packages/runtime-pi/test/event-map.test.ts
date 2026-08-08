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

it("maps Pi tool execution into runtime tool events", () => {
  let n = 0;
  const state = createMapperState(() => `id-${++n}`);
  state.triggerMessageId = "m-user";
  const out = [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: assistant("") },
    { type: "message_end", message: assistantWithStop("", "toolUse") },
    {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "pwd" },
    },
    {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "pwd" },
      partialResult: "o",
    },
    {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "pwd" },
      partialResult: "ok",
    },
    {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: "ok",
      isError: false,
    },
  ].flatMap((ev) => mapPiEvent(state, ev as AgentSessionEvent));

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
      type: "assistant-message-completed",
      messageId: "id-3",
      runId: "id-1",
      turnId: "id-2",
      model: { provider: "anthropic", id: "claude-test-1" },
      blocks: [],
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
      stopReason: "tool_use",
    },
    {
      type: "tool-call-started",
      toolCallId: "t1",
      runtimeToolCallId: "t1",
      messageId: "id-3",
      runId: "id-1",
      turnId: "id-2",
      name: "bash",
      args: { command: "pwd" },
    },
    {
      type: "tool-output-delta",
      toolCallId: "t1",
      delta: "o",
    },
    {
      type: "tool-output-delta",
      toolCallId: "t1",
      delta: "k",
    },
    {
      type: "tool-call-completed",
      toolCallId: "t1",
      result: [{ type: "text", text: "ok" }],
      durationMs: 0,
    },
  ] satisfies RuntimeEvent[]);
});

it("maps rewritten Pi tool updates as reset deltas", () => {
  const state = createMapperState(() => "id");
  expect(
    mapPiEvent(state, {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
      partialResult: "abc",
    }),
  ).toEqual([
    { type: "tool-output-delta", toolCallId: "t1", delta: "abc" },
  ] satisfies RuntimeEvent[]);
  expect(
    mapPiEvent(state, {
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
      partialResult: "xy",
    }),
  ).toEqual([
    {
      type: "tool-output-delta",
      toolCallId: "t1",
      delta: "xy",
      reset: true,
    },
  ] satisfies RuntimeEvent[]);
});

it("normalizes Pi stop reasons to protocol stop reasons", () => {
  const cases = [
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["toolUse", "tool_use"],
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

it("maps Pi error stops to failed events, not empty completions", () => {
  const state = createMapperState(() => "id-1");
  state.runId = "run-1";
  state.turnId = "turn-1";
  state.messageId = "message-1";
  const failed = assistantWithStop("", "error");
  failed.errorMessage = "Cannot read properties of undefined";

  expect(
    mapPiEvent(state, {
      type: "message_end",
      message: failed,
    }),
  ).toEqual([
    {
      type: "assistant-message-failed",
      messageId: "message-1",
      partialContent: [{ type: "text", text: "" }],
      error: {
        code: "error",
        message: "Cannot read properties of undefined",
      },
    },
  ] satisfies RuntimeEvent[]);
  expect(
    mapPiEvent(state, { type: "agent_end", messages: [], willRetry: false }),
  ).toEqual([
    {
      type: "run-failed",
      runId: "run-1",
      error: {
        code: "error",
        message: "Cannot read properties of undefined",
      },
    },
  ] satisfies RuntimeEvent[]);
});

it("keeps the run open across agent_end with willRetry", () => {
  const state = createMapperState(() => "r1");
  state.triggerMessageId = "m1";
  expect(mapPiEvent(state, { type: "agent_start" })).toHaveLength(1);
  expect(
    mapPiEvent(state, { type: "agent_end", messages: [], willRetry: true }),
  ).toEqual([]);
  expect(mapPiEvent(state, { type: "agent_start" })).toEqual([]);
  expect(
    mapPiEvent(state, { type: "agent_end", messages: [], willRetry: false }),
  ).toEqual([{ type: "run-completed", runId: "r1" }]);
});

it("surfaces automatic retry and compaction lifecycle events", () => {
  const state = createMapperState(() => "id");
  state.runId = "run-1";

  const out = [
    {
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 4,
      delayMs: 4_000,
      errorMessage: "provider unavailable",
    },
    { type: "auto_retry_end", success: false, attempt: 4 },
    { type: "compaction_start", reason: "overflow" },
    {
      type: "compaction_end",
      reason: "overflow",
      result: {
        summary: "Earlier work was preserved.",
        firstKeptEntryId: "entry-1",
        tokensBefore: 200_000,
        estimatedTokensAfter: 40_000,
        details: {},
      },
      aborted: false,
      willRetry: true,
    },
  ].flatMap((ev) => mapPiEvent(state, ev as AgentSessionEvent));

  expect(out).toEqual([
    {
      type: "retry-started",
      runId: "run-1",
      attempt: 2,
      maxAttempts: 4,
      delayMs: 4_000,
      errorSummary: "provider unavailable",
    },
    { type: "retry-ended", runId: "run-1", outcome: "exhausted" },
    { type: "compaction-started", trigger: "auto" },
    {
      type: "compaction-completed",
      summary: "Earlier work was preserved.",
      tokensBefore: 200_000,
      tokensAfter: 40_000,
      trigger: "auto",
    },
  ] satisfies RuntimeEvent[]);
});

it("drops an uncorrelated agent_start instead of emitting an invalid run", () => {
  const state = createMapperState(() => "r1");
  expect(mapPiEvent(state, { type: "agent_start" })).toEqual([]);
});

it("maps Pi session name changes into runtime title events", () => {
  const state = createMapperState(() => "id");

  expect(
    mapPiEvent(state, {
      type: "session_info_changed",
      name: "  Fix Auth Flow  ",
    }),
  ).toEqual([
    { type: "session-title-changed", title: "Fix Auth Flow" },
  ] satisfies RuntimeEvent[]);

  expect(
    mapPiEvent(state, { type: "session_info_changed", name: "   " }),
  ).toEqual([]);

  expect(
    mapPiEvent(state, {
      type: "session_info_changed",
      name: "This is a very long generated session title that should never be allowed to crash the runtime pump",
    }),
  ).toEqual([
    {
      type: "session-title-changed",
      title: "This is a very long generated session title that should neve",
    },
  ] satisfies RuntimeEvent[]);
});
