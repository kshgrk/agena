// FakeRuntimeAdapter (P16, §8.8) — implements the core-owned runtime ports with
// zero Pi imports so daemon/client/TUI tests run with zero model calls.
// Exported via the @agena/core/testing subpath.
// ponytail: §8.8's scriptSession/step builders, failNextPrompt and crashMidMessage
// arrive with the M2+ features that assert those paths (dispatch failure, boot sweep).
import type { ModelRef } from "@agena/protocol";
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
  #options: FakeRuntimeOptions;

  constructor(options: FakeRuntimeOptions = {}) {
    this.#options = options;
  }

  async createSession(
    input: CreateRuntimeSessionInput,
  ): Promise<RuntimeSession> {
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

  constructor(sessionId: string, options: FakeRuntimeOptions) {
    this.sessionId = sessionId;
    this.runtimeSessionRef = `fake:${sessionId}`;
    this.#options = options;
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
    if (this.state !== "idle") {
      throw new Error(`fake runtime: prompt while ${this.state}`);
    }
    this.state = "running";
    // resolves on ACCEPT; the scripted run streams via events()
    void this.#run(input.messageId, input.text).catch((err) => {
      this.state = "errored";
      console.error("[agena-core] fake runtime run failed:", err);
    });
  }

  getInFlightSnapshot(): RuntimeInFlightSnapshot | null {
    return this.#snapshot;
  }

  async dispose(): Promise<void> {
    this.state = "disposed";
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

  async #run(triggerMessageId: string, text: string): Promise<void> {
    const { script, delayMs = 0, model = DEFAULT_MODEL } = this.#options;
    const deltas = script ? script(text) : ["echo: ", text];
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
      run: { runId, startedAt: new Date().toISOString(), trigger: "prompt" },
      assistantMessage: null,
    };
    await emit({
      type: "run-started",
      runId,
      trigger: "prompt",
      triggerMessageId,
    });

    this.#snapshot.assistantMessage = { messageId, model, blocks: [block] };
    await emit({
      type: "assistant-message-started",
      messageId,
      runId,
      turnId,
      model,
    });
    for (const delta of deltas) {
      block.text += delta;
      await emit({
        type: "assistant-text-delta",
        messageId,
        blockIndex: 0,
        delta,
      });
    }
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
}
