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
  /** Set by prompt() before Pi emits agent_start (§8.5 echo/correlation). */
  triggerMessageId: string | null;
  runId: string | null;
  turnId: string | null;
  messageId: string | null;
  warned: Set<string>;
}

// ponytail: randomUUID over ulid — this package has no ulid dep and M1 ids
// only need uniqueness; revisit with M2 storage if sortable ids matter here.
export function createMapperState(
  mintId: () => string = randomUUID,
): MapperState {
  return {
    mintId,
    triggerMessageId: null,
    runId: null,
    turnId: null,
    messageId: null,
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
      state.runId = state.mintId();
      return [
        {
          type: "run-started",
          runId: state.runId,
          trigger: "prompt", // M1: prompt is the only trigger (steer/followUp are M4)
          triggerMessageId: state.triggerMessageId ?? "",
        },
      ];
    }
    case "agent_end": {
      if (ev.willRetry) return []; // Pi retries this run after backoff — not terminal
      const runId = state.runId ?? "";
      state.runId = null;
      state.triggerMessageId = null;
      return [{ type: "run-completed", runId }];
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
      state.messageId = null;
      return [
        {
          type: "assistant-message-completed",
          messageId,
          runId: state.runId ?? "",
          turnId: state.turnId ?? "",
          model: { provider: m.provider, id: m.model },
          blocks: m.content.flatMap((b) =>
            b.type === "text" ? [{ type: "text" as const, text: b.text }] : [],
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
    default:
      return drop(state, ev.type);
  }
}
