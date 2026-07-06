// FakeRuntimeAdapter (P16, §8.8) — implements the core-owned runtime ports with
// zero Pi imports so daemon/client/TUI tests run with zero model calls.
// Exported via the @agena/core/testing subpath.
// ponytail: §8.8's scriptSession/step builders, failNextPrompt and crashMidMessage
// arrive with the M2+ features that assert those paths (dispatch failure, boot sweep).
import type {
  ApprovalRequested,
  ApprovalResponse,
  ModelRef,
  RuntimeInfoAck,
  ThinkingLevel,
} from "@agena/protocol";
import { ulid } from "ulid";
import type {
  CreateRuntimeSessionInput,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeInFlightSnapshot,
  RuntimeSession,
} from "../runtime/types.ts";

export interface FakeRuntimeOptions {
  /** Prompt text → text deltas. Default: ["echo: ", <text>]. */
  script?: (promptText: string) => string[];
  /** Pause before each emitted event (default 0 — deterministic and fast). */
  delayMs?: number;
  model?: ModelRef;
}

const DEFAULT_MODEL: ModelRef = { provider: "fake", id: "fake-1" };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FakeRuntimeAdapter implements RuntimeAdapter {
  readonly id = "fake" as const;
  readonly version = "0.0.0";
  readonly createInputs: CreateRuntimeSessionInput[] = [];
  #options: FakeRuntimeOptions;

  constructor(options: FakeRuntimeOptions = {}) {
    this.#options = options;
  }

  async createSession(
    input: CreateRuntimeSessionInput,
  ): Promise<RuntimeSession> {
    this.createInputs.push(input);
    return new FakeRuntimeSession(input.sessionId, this.#options);
  }

  async dispose(): Promise<void> {}
}

class FakeRuntimeSession implements RuntimeSession {
  readonly sessionId: string;
  readonly runtimeSessionRef: string;
  state: "idle" | "running" | "errored" | "disposed" = "idle";

  #options: FakeRuntimeOptions;
  #queue: RuntimeEvent[] = [];
  #wake: (() => void) | null = null;
  #consuming = false;
  #snapshot: RuntimeInFlightSnapshot | null = null;
  #model: ModelRef;
  #thinkingLevel: ThinkingLevel = "off";
  #pendingApproval: {
    approvalId: string;
    resolve: (response: ApprovalResponse) => void;
  } | null = null;

  constructor(sessionId: string, options: FakeRuntimeOptions) {
    this.sessionId = sessionId;
    this.runtimeSessionRef = `fake:${sessionId}`;
    this.#options = options;
    this.#model = options.model ?? DEFAULT_MODEL;
  }

  events(): AsyncIterable<RuntimeEvent> {
    if (this.#consuming) {
      throw new Error(
        "events() already has a consumer (single-consumer contract, §8.2)",
      );
    }
    this.#consuming = true;
    return this.#iterate();
  }

  async prompt(input: { messageId: string; text: string }): Promise<void> {
    await this.#accept("prompt", input);
  }

  async steer(_input: { messageId: string; text: string }): Promise<void> {
    if (this.state !== "running") {
      throw new Error(`fake runtime: steer while ${this.state}`);
    }
  }

  async followUp(_input: { messageId: string; text: string }): Promise<void> {
    if (this.state !== "running") {
      throw new Error(`fake runtime: followUp while ${this.state}`);
    }
  }

  async abort(): Promise<void> {
    this.state = "idle";
    this.#snapshot = null;
    this.#resolvePendingApproval({ kind: "deny" });
  }

  async info(): Promise<RuntimeInfoAck> {
    return {
      model: this.#model,
      thinkingLevel: this.#thinkingLevel,
      availableModels: [this.#model],
      availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
      slashCommands: [],
    };
  }

  async setModel(model: ModelRef): Promise<void> {
    this.#model = model;
  }

  async setThinkingLevel(thinkingLevel: ThinkingLevel): Promise<void> {
    this.#thinkingLevel = thinkingLevel;
  }

  async compact(): Promise<{ summary: string }> {
    return {
      summary: `Fake runtime compacted context at thinking=${this.#thinkingLevel}.`,
    };
  }

  async respondToApproval(
    approvalId: string,
    response: ApprovalResponse,
  ): Promise<void> {
    if (this.#pendingApproval?.approvalId !== approvalId) return;
    this.#resolvePendingApproval(response);
  }

  async #accept(
    trigger: "prompt" | "steer" | "followUp",
    input: { messageId: string; text: string },
  ): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`fake runtime: ${trigger} while ${this.state}`);
    }
    this.state = "running";
    // resolves on ACCEPT; the scripted run streams via events()
    void this.#run(trigger, input.messageId, input.text).catch((err) => {
      this.state = "errored";
      console.error("[agena-core] fake runtime run failed:", err);
    });
  }

  getInFlightSnapshot(): RuntimeInFlightSnapshot | null {
    return this.#snapshot;
  }

  async dispose(): Promise<void> {
    this.state = "disposed";
    this.#resolvePendingApproval({ kind: "deny" });
    this.#wake?.();
    this.#wake = null;
  }

  async *#iterate(): AsyncGenerator<RuntimeEvent> {
    while (this.state !== "disposed") {
      const ev = this.#queue.shift();
      if (ev) {
        yield ev;
        continue;
      }
      await new Promise<void>((r) => {
        this.#wake = r;
      });
    }
  }

  #push(ev: RuntimeEvent): void {
    this.#queue.push(ev);
    this.#wake?.();
    this.#wake = null;
  }

  async #run(
    trigger: "prompt" | "steer" | "followUp",
    triggerMessageId: string,
    text: string,
  ): Promise<void> {
    const { script, delayMs = 0 } = this.#options;
    const model = this.#model;
    let deltas = script ? script(text) : ["echo: ", text];
    const emit = async (ev: RuntimeEvent) => {
      if (delayMs > 0) await sleep(delayMs);
      this.#push(ev);
    };

    const runId = ulid();
    const turnId = ulid();
    const messageId = ulid();
    const block = { index: 0, type: "text" as const, text: "" };
    this.#snapshot = {
      sessionId: this.sessionId,
      run: { runId, startedAt: new Date().toISOString(), trigger },
      assistantMessage: null,
    };
    await emit({
      type: "run-started",
      runId,
      trigger,
      triggerMessageId,
    });
    if (this.state !== "running") return;

    const approval = manualApproval(text);
    if (approval) {
      const response = this.#waitForApproval(approval.approvalId);
      await emit({ type: "approval-requested", approval });
      if (this.state !== "running") return;
      deltas = [`approval response: ${approvalResponseText(await response)}`];
      if (this.state !== "running") return;
    }

    this.#snapshot.assistantMessage = { messageId, model, blocks: [block] };
    await emit({
      type: "assistant-message-started",
      messageId,
      runId,
      turnId,
      model,
    });
    if (this.state !== "running") return;
    for (const delta of deltas) {
      if (this.state !== "running") return;
      block.text += delta;
      await emit({
        type: "assistant-text-delta",
        messageId,
        blockIndex: 0,
        delta,
      });
    }
    if (this.state !== "running") return;
    const usage = { inputTokens: text.length, outputTokens: block.text.length };
    await emit({
      type: "assistant-message-completed",
      messageId,
      runId,
      turnId,
      model,
      blocks: [{ type: "text", text: block.text }],
      usage,
      stopReason: "end_turn",
    });

    this.#snapshot = null;
    await emit({ type: "run-completed", runId, usage });
    if (this.state === "running") this.state = "idle";
  }

  #waitForApproval(approvalId: string): Promise<ApprovalResponse> {
    return new Promise((resolve) => {
      this.#pendingApproval = { approvalId, resolve };
    });
  }

  #resolvePendingApproval(response: ApprovalResponse): void {
    const pending = this.#pendingApproval;
    this.#pendingApproval = null;
    pending?.resolve(response);
  }
}

function manualApproval(text: string): ApprovalRequested | null {
  const [command, kind = "confirm"] = text.trim().toLowerCase().split(/\s+/);
  if (command !== "approval") return null;
  const approvalId = ulid();
  if (kind === "select") {
    return {
      approvalId,
      kind,
      title: "Manual approval test",
      message: "Choose one option to continue the fake runtime turn.",
      options: [
        { id: "one", label: "Option one" },
        { id: "two", label: "Option two" },
        { id: "three", label: "Option three" },
      ],
    };
  }
  if (kind === "input" || kind === "editor") {
    return {
      approvalId,
      kind,
      title: "Manual approval test",
      message: `Enter ${kind} text to continue the fake runtime turn.`,
      defaultValue: kind === "input" ? "approved" : undefined,
    };
  }
  return {
    approvalId,
    kind: "confirm",
    title: "Manual approval test",
    message: "Approve or deny to continue the fake runtime turn.",
  };
}

function approvalResponseText(response: ApprovalResponse): string {
  switch (response.kind) {
    case "confirm":
      return response.accepted ? "confirmed" : "rejected";
    case "select":
      return `selected ${response.optionId}`;
    case "input":
    case "editor":
      return response.text;
    case "deny":
      return "denied";
  }
}
