// The M1 mapper (§8.4): Pi AgentSessionEvent → RuntimeEvent, text streaming
// only — run started/completed, assistant started / text delta / completed.
// Pure apart from id minting through state.mintId and warn-once logging, so
// fixture tests fold it over recorded event arrays (P16, §8.8).
// ponytail: tool/thinking/compaction/retry/approval mappings land with the
// M2–M4 RuntimeEvent variants that carry them; here they are log-and-drop
// per the plan's unknown-event stance.
import { randomUUID } from "node:crypto";
import type { AssistantStopReason, RuntimeEvent } from "@agena/core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface MapperState {
  mintId: () => string;
  now: () => number;
  /** Set by prompt() before Pi emits agent_start (§8.5 echo/correlation). */
  triggerMessageId: string | null;
  runId: string | null;
  turnId: string | null;
  messageId: string | null;
  lastAssistantMessageId: string | null;
  failure: { code: string; message: string } | null;
  toolOutputs: Map<string, string>;
  toolStartedAt: Map<string, number>;
  warned: Set<string>;
}

// ponytail: randomUUID over ulid — this package has no ulid dep and M1 ids
// only need uniqueness; revisit with M2 storage if sortable ids matter here.
export function createMapperState(
  mintId: () => string = randomUUID,
  now: () => number = Date.now,
): MapperState {
  return {
    mintId,
    now,
    triggerMessageId: null,
    runId: null,
    turnId: null,
    messageId: null,
    lastAssistantMessageId: null,
    failure: null,
    toolOutputs: new Map(),
    toolStartedAt: new Map(),
    warned: new Set(),
  };
}

function drop(state: MapperState, key: string): RuntimeEvent[] {
  if (!state.warned.has(key)) {
    state.warned.add(key);
    console.warn(
      `[agena-runtime-pi] ignoring Pi event "${key}" (unmapped in M1)`,
    );
  }
  return [];
}

function mapStopReason(reason: string): AssistantStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "toolUse":
      return "tool_use";
    // ponytail: M2 adds assistant-message-aborted/failed; until then these
    // provider terminal reasons must still close the M1 in-flight message.
    case "aborted":
    case "error":
      return "end_turn";
    default:
      return "end_turn";
  }
}

export function mapPiEvent(
  state: MapperState,
  ev: AgentSessionEvent,
): RuntimeEvent[] {
  switch (ev.type) {
    case "agent_start": {
      if (state.runId) {
        state.failure = null;
        return [];
      }
      if (!state.triggerMessageId) {
        return drop(state, "agent_start_without_trigger");
      }
      state.runId = state.mintId();
      return [
        {
          type: "run-started",
          runId: state.runId,
          trigger: "prompt", // M1: prompt is the only trigger (steer/followUp are M4)
          triggerMessageId: state.triggerMessageId,
        },
      ];
    }
    case "agent_end": {
      if (ev.willRetry) {
        state.failure = null;
        return [];
      }
      if (!state.runId) return [];
      const runId = state.runId;
      const failure = state.failure;
      state.runId = null;
      state.triggerMessageId = null;
      state.failure = null;
      return failure
        ? [{ type: "run-failed", runId, error: failure }]
        : [{ type: "run-completed", runId }];
    }
    case "turn_start":
      state.turnId = state.mintId(); // turn events themselves are M2 frames
      return [];
    case "turn_end":
      state.turnId = null;
      return [];
    case "message_start": {
      // UserMessage echo of our own prompt and runtime message types are
      // suppressed per the §8.4 mapping table.
      if (ev.message.role !== "assistant") return [];
      state.messageId = state.mintId();
      state.lastAssistantMessageId = state.messageId;
      return [
        {
          type: "assistant-message-started",
          messageId: state.messageId,
          runId: state.runId ?? "",
          turnId: state.turnId ?? "",
          model: { provider: ev.message.provider, id: ev.message.model },
        },
      ];
    }
    case "message_update": {
      const sub = ev.assistantMessageEvent;
      // thinking/toolcall deltas and block start/end markers: known, deliberately
      // skipped in M1 (the block/thinking RuntimeEvent variants are M2+).
      if (sub.type !== "text_delta" || state.messageId === null) return [];
      return [
        {
          type: "assistant-text-delta",
          messageId: state.messageId,
          blockIndex: sub.contentIndex,
          delta: sub.delta,
        },
      ];
    }
    case "message_end": {
      if (ev.message.role !== "assistant") return [];
      const m = ev.message;
      const messageId = state.messageId ?? state.mintId();
      const runId = state.runId ?? "";
      const turnId = state.turnId ?? "";
      state.messageId = null;
      state.lastAssistantMessageId = messageId;
      if (m.stopReason === "error" || m.stopReason === "aborted") {
        const message = m.errorMessage ?? `Pi stopped with ${m.stopReason}`;
        state.failure = { code: m.stopReason, message };
        return [
          {
            type: "assistant-message-failed",
            messageId,
            partialContent: m.content.flatMap((b) =>
              b.type === "text"
                ? [{ type: "text" as const, text: b.text }]
                : [],
            ),
            error: { code: m.stopReason, message },
          },
        ];
      }
      state.failure = null;
      return [
        {
          type: "assistant-message-completed",
          messageId,
          runId,
          turnId,
          model: { provider: m.provider, id: m.model },
          blocks: m.content.flatMap((b) =>
            b.type === "text" && b.text !== ""
              ? [{ type: "text" as const, text: b.text }]
              : [],
          ),
          usage: {
            inputTokens: m.usage.input,
            outputTokens: m.usage.output,
            costUsd: m.usage.cost.total,
          },
          stopReason: mapStopReason(m.stopReason),
        },
      ];
    }
    case "tool_execution_start":
      state.toolStartedAt.set(ev.toolCallId, state.now());
      return [
        {
          type: "tool-call-started",
          toolCallId: ev.toolCallId,
          runtimeToolCallId: ev.toolCallId,
          messageId: state.lastAssistantMessageId ?? state.messageId ?? "",
          runId: state.runId ?? "",
          turnId: state.turnId ?? "",
          name: ev.toolName,
          args: ev.args,
        },
      ];
    case "tool_execution_update":
      return toolOutputDelta(state, ev.toolCallId, ev.partialResult);
    case "tool_execution_end": {
      state.toolOutputs.delete(ev.toolCallId);
      const startedAt = state.toolStartedAt.get(ev.toolCallId);
      state.toolStartedAt.delete(ev.toolCallId);
      const durationMs =
        startedAt === undefined
          ? 0
          : Math.max(0, Math.round(state.now() - startedAt));
      if (ev.isError) {
        return [
          {
            type: "tool-call-failed",
            toolCallId: ev.toolCallId,
            error: {
              code: "tool_error",
              message: stringifyToolResult(ev.result),
            },
            partialOutput: toolResultBlocks(ev.result),
            durationMs,
          },
        ];
      }
      return [
        {
          type: "tool-call-completed",
          toolCallId: ev.toolCallId,
          result: toolResultBlocks(ev.result),
          durationMs,
        },
      ];
    }
    case "session_info_changed": {
      const title = normalizeTitle(ev.name);
      return title ? [{ type: "session-title-changed", title }] : [];
    }
    case "auto_retry_start":
      return state.runId
        ? [
            {
              type: "retry-started",
              runId: state.runId,
              attempt: ev.attempt,
              maxAttempts: ev.maxAttempts,
              delayMs: ev.delayMs,
              errorSummary: ev.errorMessage,
            },
          ]
        : [];
    case "auto_retry_end":
      return state.runId
        ? [
            {
              type: "retry-ended",
              runId: state.runId,
              outcome: ev.success ? "recovered" : "exhausted",
            },
          ]
        : [];
    case "compaction_start":
      // Manual compaction is already finalized by handleCompact; automatic
      // compaction only exists on this event stream.
      return ev.reason === "manual"
        ? []
        : [{ type: "compaction-started", trigger: "auto" }];
    case "compaction_end":
      if (ev.reason === "manual") return [];
      if (!ev.result) {
        return [
          {
            type: "compaction-failed",
            error: {
              code: ev.aborted ? "aborted" : "compaction_error",
              message:
                ev.errorMessage ??
                (ev.aborted ? "Compaction was aborted" : "Compaction failed"),
            },
          },
        ];
      }
      return [
        {
          type: "compaction-completed",
          summary: ev.result.summary,
          tokensBefore: ev.result.tokensBefore,
          tokensAfter: ev.result.estimatedTokensAfter ?? ev.result.tokensBefore,
          trigger: "auto",
        },
      ];
    default:
      return drop(state, ev.type);
  }
}

function normalizeTitle(title: string | undefined): string {
  return (title ?? "")
    .replace(/^["'`]+|["'`.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function toolResultBlocks(result: unknown): { type: "text"; text: string }[] {
  return [{ type: "text", text: stringifyToolResult(result) }];
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2) ?? "";
}

function toolOutputDelta(
  state: MapperState,
  toolCallId: string,
  partialResult: unknown,
): RuntimeEvent[] {
  const next = stringifyToolResult(partialResult);
  const prev = state.toolOutputs.get(toolCallId) ?? "";
  if (next === prev) return [];
  state.toolOutputs.set(toolCallId, next);
  if (next.startsWith(prev)) {
    return [
      { type: "tool-output-delta", toolCallId, delta: next.slice(prev.length) },
    ];
  }
  return [{ type: "tool-output-delta", toolCallId, delta: next, reset: true }];
}
