// Core-owned runtime ports (§8.2) — DEFINED here, implemented by
// @agena/runtime-pi and by the FakeRuntimeAdapter test double (P16).
// ponytail: M1 is prompt + text streaming + completion only. §8.2's full surface
// (openSession/capabilities, steer/followUp/abort/setModel/setThinkingLevel/compact/
// respondToApproval, tools/capture, the tool/approval/compaction/retry RuntimeEvent
// variants, toolCalls/retry/queue snapshot fields) lands with M3/M4.
import type { ContentBlock, ModelRef, UsageTotals } from "@agena/protocol";

export type RuntimeId = "pi" | "fake";
export type RunTrigger = "prompt" | "steer" | "followUp";
export type AssistantStopReason = "end_turn" | "tool_use" | "max_tokens";

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  readonly version: string; // the pinned Pi SDK version
  createSession(input: CreateRuntimeSessionInput): Promise<RuntimeSession>;
  dispose(): Promise<void>; // graceful-shutdown path
}

export interface CreateRuntimeSessionInput {
  sessionId: string; // Agena session ULID
  workspaceDir: string; // '/workspace'
  model?: ModelRef;
}

export interface RuntimeSession {
  readonly sessionId: string;
  readonly runtimeSessionRef: string; // Pi: absolute path to the session JSONL
  readonly state: "idle" | "running" | "errored" | "disposed";

  /** Single-consumer, ordered. Core's per-session actor is the only consumer;
      a second events() call throws. Pull-based — this IS the adapter's backpressure. */
  events(): AsyncIterable<RuntimeEvent>;

  /** Resolves when the run is ACCEPTED, not when it finishes; completion arrives
      as run-completed RuntimeEvents. */
  prompt(input: { messageId: string; text: string }): Promise<void>;

  /** Synchronous — served from adapter-local buffers, never awaits the runtime. */
  getInFlightSnapshot(): RuntimeInFlightSnapshot | null;
  dispose(): Promise<void>;
}

// Closed union, kebab-case (§8.2 / §4.3) — M1 subset.
export type RuntimeEvent =
  | {
      type: "run-started";
      runId: string;
      trigger: RunTrigger;
      triggerMessageId: string;
    }
  | { type: "run-completed"; runId: string; usage?: UsageTotals }
  | {
      type: "assistant-message-started";
      messageId: string;
      runId: string;
      turnId: string;
      model: ModelRef;
    }
  | {
      type: "assistant-text-delta";
      messageId: string;
      blockIndex: number;
      delta: string;
    }
  | {
      type: "assistant-message-completed";
      messageId: string;
      runId: string;
      turnId: string;
      model: ModelRef;
      blocks: ContentBlock[];
      usage?: UsageTotals;
      stopReason: AssistantStopReason;
    };

// Core-owned; distinct name from the wire InFlightSnapshot (§8.2).
export interface RuntimeInFlightSnapshot {
  sessionId: string;
  run: { runId: string; startedAt: string; trigger: RunTrigger } | null;
  assistantMessage: {
    messageId: string;
    model: ModelRef;
    blocks: Array<{ index: number; type: "text"; text: string }>;
  } | null;
}
