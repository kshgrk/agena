// SessionOrchestrator (§4.1 sessions/) — the M1 per-session actor (§6.1):
// appends command-side durable events, dispatches to the runtime adapter, and
// consumes RuntimeSession.events() sequentially, fully processing one event
// (committing the append tx for durable ones) before pulling the next.
// ponytail: M4 brings the full command legality matrix (steer/followUp/abort/…)
// and deterministic per-session command serialization; M1 needs only
// reject-while-busy (§5.4 prompt → SESSION_BUSY). Dispatch-failure durable
// records (run.failed {phase:"dispatch"}) are M2 (§8.6).
import type {
  AgenaFrame,
  ContentBlock,
  ErrorCode,
  EventSource,
  InFlightSnapshot,
} from "@agena/protocol";
import { ulid } from "ulid";
import type {
  CreateSessionInput,
  EventStore,
  NewEvent,
  SessionRecord,
} from "../events/store.ts";
import type {
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeSession,
} from "../runtime/types.ts";

export class OrchestratorError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
  }
}

export interface SessionOrchestratorOptions {
  workspaceDir?: string; // default '/workspace' (§3.2)
  /** Ephemeral frame sink (P12) — the daemon points this at FanoutHub.publishFrame. */
  publishFrame?: (frame: AgenaFrame) => void;
}

interface SessionState {
  record: SessionRecord;
  lastSeq: number; // highest committed seq — stamped on frames as afterSeq
  busy: boolean; // single in-flight turn per session (§5.4)
  run: { runId: string; triggerMessageId: string } | null;
  runtime: RuntimeSession | null;
}

export class SessionOrchestrator {
  #store: EventStore;
  #adapter: RuntimeAdapter;
  #workspaceDir: string;
  #publishFrame: (frame: AgenaFrame) => void;
  #runtimeSource: EventSource;
  #sessions = new Map<string, SessionState>();

  constructor(
    store: EventStore,
    adapter: RuntimeAdapter,
    options: SessionOrchestratorOptions = {},
  ) {
    this.#store = store;
    this.#adapter = adapter;
    this.#workspaceDir = options.workspaceDir ?? "/workspace";
    this.#publishFrame = options.publishFrame ?? (() => {});
    // P3 provenance: runtime-derived events are stamped runtime:'pi'; the fake
    // adapter is not 'pi', so the optional field stays absent.
    this.#runtimeSource =
      adapter.id === "pi"
        ? { kind: "runtime", runtime: "pi" }
        : { kind: "runtime" };
  }

  createSession(input: CreateSessionInput): Promise<SessionRecord> {
    return this.#store.createSession(input); // store appends session.created (§7.4)
  }

  async inFlightSnapshot(
    sessionId: string,
    branchId: string,
    afterSeq: number,
  ): Promise<InFlightSnapshot> {
    const s = await this.#state(sessionId);
    const runtime = s.runtime?.getInFlightSnapshot() ?? null;
    const assistant = runtime?.assistantMessage
      ? {
          messageId: runtime.assistantMessage.messageId,
          model: runtime.assistantMessage.model,
          blocks: runtime.assistantMessage.blocks.map((b) => ({
            type: b.type,
            text: b.text,
          })),
        }
      : null;
    return {
      sessionId,
      branchId,
      afterSeq,
      assistant,
      toolCalls: [],
      pendingApprovals: [],
      retry: null,
      queue: { steerCount: 0, followUpCount: 0 },
      status: { state: s.busy ? "generating" : "idle" },
    };
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map((s) =>
        s.busy ? this.#terminalize(s, "daemon_shutdown") : Promise.resolve(),
      ),
    );
  }

  /** §5.4 prompt: ack is { messageId, seq }; completion arrives as events. */
  async handlePrompt(
    sessionId: string,
    content: ContentBlock[],
    clientId?: string,
  ): Promise<{ messageId: string; seq: number }> {
    const s = await this.#state(sessionId);
    if (s.busy) {
      throw new OrchestratorError("SESSION_BUSY", "a turn is already active");
    }
    s.busy = true; // set before any await so check-and-set is atomic
    try {
      const messageId = ulid();
      const source: EventSource = clientId
        ? { kind: "user", clientId }
        : { kind: "user" };
      const { lastSeq } = await this.#append(s, [
        {
          type: "message.user.created",
          v: 1,
          source,
          payload: { messageId, content },
        },
      ]);
      try {
        const runtime = await this.#runtime(s);
        // §5.4: v1 prompt content is text blocks only; core concatenates them.
        await runtime.prompt({
          messageId,
          text: content.map((b) => (b.type === "text" ? b.text : "")).join(""),
        });
      } catch (err) {
        await this.#appendRuntime(s, "run.failed", {
          runId: ulid(),
          triggerMessageId: messageId,
          phase: "dispatch",
          error: { code: "runtime_error", message: message(err) },
        });
        throw err;
      }
      return { messageId, seq: lastSeq };
    } catch (err) {
      s.busy = false;
      throw err;
    }
  }

  async #state(sessionId: string): Promise<SessionState> {
    const cached = this.#sessions.get(sessionId);
    if (cached) return cached;
    const record = await this.#store.getSession(sessionId);
    if (!record) {
      throw new OrchestratorError(
        "SESSION_NOT_FOUND",
        `unknown session ${sessionId}`,
      );
    }
    // re-check after the await — a concurrent call may have won
    const raced = this.#sessions.get(sessionId);
    if (raced) return raced;
    const state: SessionState = {
      record,
      lastSeq: record.lastSeq,
      busy: false,
      run: null,
      runtime: null,
    };
    this.#sessions.set(sessionId, state);
    return state;
  }

  async #runtime(s: SessionState): Promise<RuntimeSession> {
    if (s.runtime) return s.runtime;
    s.runtime = await this.#adapter.createSession({
      sessionId: s.record.sessionId,
      workspaceDir: this.#workspaceDir,
    });
    void this.#pump(s, s.runtime);
    return s.runtime;
  }

  async #pump(s: SessionState, runtime: RuntimeSession): Promise<void> {
    try {
      for await (const ev of runtime.events()) {
        await this.#apply(s, ev);
      }
    } catch (err) {
      await this.#terminalize(s, "runtime_error", err).catch((inner) => {
        console.error(
          `[agena-core] runtime terminalization failed for session ${s.record.sessionId}:`,
          inner,
        );
      });
      console.error(
        `[agena-core] runtime pump failed for session ${s.record.sessionId}:`,
        err,
      );
    }
  }

  async #apply(s: SessionState, ev: RuntimeEvent): Promise<void> {
    switch (ev.type) {
      case "run-started":
        s.run = { runId: ev.runId, triggerMessageId: ev.triggerMessageId };
        await this.#appendRuntime(s, "run.started", {
          runId: ev.runId,
          trigger: ev.trigger,
          triggerMessageId: ev.triggerMessageId,
        });
        return;
      case "assistant-message-started": {
        if (!s.run)
          throw new Error("assistant-message-started before run-started");
        await this.#appendRuntime(s, "message.assistant.started", {
          messageId: ev.messageId,
          runId: ev.runId,
          turnId: ev.turnId,
          model: ev.model,
          inResponseTo: s.run.triggerMessageId,
        });
        return;
      }
      case "assistant-text-delta":
        this.#publishFrame({
          type: "message.assistant.text.delta",
          sessionId: s.record.sessionId,
          branchId: s.record.rootBranchId,
          afterSeq: s.lastSeq,
          payload: {
            messageId: ev.messageId,
            blockIndex: ev.blockIndex,
            delta: ev.delta,
          },
          emittedAt: new Date().toISOString(),
        });
        return;
      case "assistant-message-completed":
        await this.#appendRuntime(s, "message.assistant.completed", {
          messageId: ev.messageId,
          content: ev.blocks,
          model: ev.model,
          stopReason: ev.stopReason,
          ...(ev.usage ? { usage: ev.usage } : {}),
        });
        return;
      case "run-completed":
        await this.#appendRuntime(s, "run.completed", {
          runId: ev.runId,
          ...(ev.usage ? { usage: ev.usage } : {}),
        });
        s.run = null;
        s.busy = false;
        return;
    }
  }

  #appendRuntime(s: SessionState, type: string, payload: unknown) {
    return this.#append(s, [
      { type, v: 1, source: this.#runtimeSource, payload },
    ]);
  }

  async #append(s: SessionState, events: NewEvent[]) {
    const result = await this.#store.appendEvents({
      sessionId: s.record.sessionId,
      branchId: s.record.rootBranchId,
      events,
    });
    s.lastSeq = result.lastSeq;
    return result;
  }

  async #terminalize(
    s: SessionState,
    reason: "daemon_shutdown" | "runtime_error",
    err?: unknown,
  ): Promise<void> {
    const runtime = s.runtime?.getInFlightSnapshot() ?? null;
    const events: NewEvent[] = [];
    const assistant = runtime?.assistantMessage;
    if (assistant) {
      events.push({
        type:
          reason === "daemon_shutdown"
            ? "message.assistant.aborted"
            : "message.assistant.failed",
        v: 1,
        source:
          reason === "daemon_shutdown"
            ? { kind: "daemon" }
            : this.#runtimeSource,
        payload:
          reason === "daemon_shutdown"
            ? {
                messageId: assistant.messageId,
                partialContent: assistant.blocks.map((b) => ({
                  type: b.type,
                  text: b.text,
                })),
                reason,
              }
            : {
                messageId: assistant.messageId,
                partialContent: assistant.blocks.map((b) => ({
                  type: b.type,
                  text: b.text,
                })),
                error: { code: "runtime_error", message: message(err) },
              },
      });
    }
    if (s.run) {
      events.push({
        type: reason === "daemon_shutdown" ? "run.aborted" : "run.failed",
        v: 1,
        source:
          reason === "daemon_shutdown"
            ? { kind: "daemon" }
            : this.#runtimeSource,
        payload:
          reason === "daemon_shutdown"
            ? { runId: s.run.runId, reason }
            : {
                runId: s.run.runId,
                phase: "runtime",
                error: { code: "runtime_error", message: message(err) },
              },
      });
    }
    if (events.length > 0) await this.#append(s, events);
    s.busy = false;
    s.run = null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
