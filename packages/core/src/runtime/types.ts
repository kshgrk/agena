// Core-owned runtime ports (§8.2) — DEFINED here, implemented by
// @agena/runtime-pi and by the FakeRuntimeAdapter test double (P16).
// ponytail: M1 is prompt + text streaming + completion only. §8.2's full surface
// (openSession/capabilities, steer/followUp/abort/setModel/setThinkingLevel/compact/
// respondToApproval, tools/capture, the tool/approval/compaction/retry RuntimeEvent
// variants, toolCalls/retry/queue snapshot fields) lands with M3/M4.
import type {
  ApprovalRequested,
  ApprovalResponse,
  ContentBlock,
  ModelRef,
  RuntimeInfoAck,
  ThinkingLevel,
  UsageTotals,
  VisibleBrowserAction,
  VisibleBrowserResult,
} from "@agena/protocol";

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
  cwd: string; // absolute runtime cwd inside workspace/project scope
  runtimeSessionRef?: string; // Pi JSONL path when rehydrating
  model?: ModelRef;
  visibleBrowser?: VisibleBrowserController;
}

export interface VisibleBrowserController {
  request(action: VisibleBrowserAction): Promise<VisibleBrowserResult>;
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
  steer(input: { messageId: string; text: string }): Promise<void>;
  followUp(input: { messageId: string; text: string }): Promise<void>;
  abort(): Promise<void>;
  info(): Promise<RuntimeInfoAck>;
  setModel(model: ModelRef): Promise<void>;
  setThinkingLevel(thinkingLevel: ThinkingLevel): Promise<void>;
  compact(): Promise<{
    summary: string;
    tokensBefore?: number;
    tokensAfter?: number;
  }>;
  respondToApproval(
    approvalId: string,
    response: ApprovalResponse,
  ): Promise<void>;

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
    }
  | {
      type: "assistant-message-aborted";
      messageId: string;
      partialContent: ContentBlock[];
      reason: "user_abort" | "daemon_shutdown";
    }
  | {
      type: "assistant-message-failed";
      messageId: string;
      partialContent: ContentBlock[];
      error: { code: string; message: string };
    }
  | {
      type: "tool-call-started";
      toolCallId: string;
      messageId: string;
      runId: string;
      turnId: string;
      name: string;
      args: unknown;
      runtimeToolCallId?: string;
    }
  | {
      type: "tool-output-delta";
      toolCallId: string;
      delta: string;
      reset?: boolean;
    }
  | {
      type: "tool-call-completed";
      toolCallId: string;
      result: ContentBlock[];
      durationMs: number;
    }
  | {
      type: "tool-call-failed";
      toolCallId: string;
      error: { code: string; message: string };
      partialOutput?: ContentBlock[];
      durationMs?: number;
    }
  | {
      type: "run-aborted";
      runId: string;
      reason: "user_abort" | "daemon_shutdown";
    }
  | {
      type: "run-failed";
      runId: string;
      error: { code: string; message: string };
    }
  | { type: "model-changed"; from?: ModelRef; to: ModelRef }
  | { type: "thinking-level-changed"; from: string; to: string }
  | { type: "session-title-changed"; title: string }
  | {
      type: "approval-requested";
      approval: ApprovalRequested;
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
