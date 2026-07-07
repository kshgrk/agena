// SessionOrchestrator (§4.1 sessions/) — the M1 per-session actor (§6.1):
// appends command-side durable events, dispatches to the runtime adapter, and
// consumes RuntimeSession.events() sequentially, fully processing one event
// (committing the append tx for durable ones) before pulling the next.
// ponytail: M4 brings the full command legality matrix (steer/followUp/abort/…)
// and deterministic per-session command serialization; M1 needs only
// reject-while-busy (§5.4 prompt → SESSION_BUSY). Dispatch-failure durable
// records (run.failed {phase:"dispatch"}) are M2 (§8.6).
import { resolve } from "node:path";
import type {
  AgenaFrame,
  ApprovalResponse,
  ContentBlock,
  ErrorCode,
  EventSource,
  InFlightSnapshot,
  ModelRef,
  ThinkingLevel,
} from "@agena/protocol";
import { ulid } from "ulid";
import type {
  CreateSessionInput,
  EventStore,
  NewEvent,
  SessionRecord,
} from "../events/store.ts";
import { pendingApprovalsFromEvents } from "../events/store.ts";
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
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  commandQueue: Promise<void>;
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
    const pendingApprovals = await this.#pendingApprovals(sessionId);
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
      pendingApprovals: pendingApprovals.map((a) => a.payload),
      retry: null,
      queue: { steerCount: 0, followUpCount: 0 },
      status: { state: s.busy ? "generating" : "idle" },
    };
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map(async (s) => {
        if (s.busy) await this.#terminalize(s, "daemon_shutdown");
        await s.runtime?.dispose();
        s.runtime = null;
      }),
    );
  }

  /** §5.4 prompt: ack is { messageId, seq }; completion arrives as events. */
  async handlePrompt(
    sessionId: string,
    content: ContentBlock[],
    clientId?: string,
  ): Promise<{ messageId: string; seq: number }> {
    const s = await this.#state(sessionId);
    return this.#serialize(s, () =>
      this.#submitText(s, "prompt", content, clientId),
    );
  }

  async handleSteer(
    sessionId: string,
    content: ContentBlock[],
    clientId?: string,
  ): Promise<{ messageId: string; seq: number }> {
    const s = await this.#state(sessionId);
    return this.#serialize(s, () =>
      this.#submitText(s, "steer", content, clientId),
    );
  }

  async handleFollowUp(
    sessionId: string,
    content: ContentBlock[],
    clientId?: string,
  ): Promise<{ messageId: string; seq: number }> {
    const s = await this.#state(sessionId);
    return this.#serialize(s, () =>
      this.#submitText(s, "followUp", content, clientId),
    );
  }

  async handleAbort(sessionId: string): Promise<Record<string, never>> {
    const s = await this.#state(sessionId);
    return this.#serialize(s, async () => {
      if (!s.busy || !s.run) {
        throw new OrchestratorError("TURN_NOT_ACTIVE", "no turn is active");
      }
      await this.#terminalize(s, "user_abort");
      await s.runtime?.abort();
      return {};
    });
  }

  async handleRuntimeInfo(sessionId: string) {
    const s = await this.#state(sessionId);
    return this.#serialize(s, async () => (await this.#runtime(s)).info());
  }

  async handleSetModel(
    sessionId: string,
    model: ModelRef,
  ): Promise<{ model: ModelRef }> {
    const s = await this.#state(sessionId);
    return this.#serialize(s, async () => {
      if (s.busy) {
        throw new OrchestratorError("SESSION_BUSY", "a turn is already active");
      }
      try {
        await (await this.#runtime(s)).setModel(model);
      } catch (err) {
        throw new OrchestratorError("MODEL_UNAVAILABLE", message(err));
      }
      await this.#append(s, [
        {
          type: "model.changed",
          v: 1,
          source: { kind: "user" },
          payload: {
            ...(s.model ? { from: s.model } : {}),
            to: model,
            reason: "user_selected",
          },
        },
      ]);
      s.model = model;
      return { model };
    });
  }

  async handleSetThinkingLevel(
    sessionId: string,
    thinkingLevel: ThinkingLevel,
  ): Promise<{ thinkingLevel: ThinkingLevel }> {
    const s = await this.#state(sessionId);
    return this.#serialize(s, async () => {
      if (s.busy) {
        throw new OrchestratorError("SESSION_BUSY", "a turn is already active");
      }
      try {
        await (await this.#runtime(s)).setThinkingLevel(thinkingLevel);
      } catch (err) {
        throw new OrchestratorError("RUNTIME_UNAVAILABLE", message(err));
      }
      await this.#append(s, [
        {
          type: "thinking.level.changed",
          v: 1,
          source: { kind: "user" },
          payload: { from: s.thinkingLevel, to: thinkingLevel },
        },
      ]);
      s.thinkingLevel = thinkingLevel;
      return { thinkingLevel };
    });
  }

  async handleCompact(sessionId: string): Promise<{ compactionSeq: number }> {
    const s = await this.#state(sessionId);
    return this.#serialize(s, async () => {
      if (s.busy) {
        throw new OrchestratorError("SESSION_BUSY", "a turn is already active");
      }
      const replacesUpToSeq = s.lastSeq;
      const compactionId = ulid();
      let result: {
        summary: string;
        tokensBefore?: number;
        tokensAfter?: number;
      };
      try {
        result = await (await this.#runtime(s)).compact();
      } catch (err) {
        throw new OrchestratorError("RUNTIME_UNAVAILABLE", message(err));
      }
      const { lastSeq } = await this.#append(s, [
        {
          type: "compaction.created",
          v: 1,
          source: { kind: "runtime" },
          payload: {
            compactionId,
            summary: [{ type: "text", text: result.summary }],
            replacesUpToSeq,
            ...(result.tokensBefore !== undefined
              ? { tokensBefore: result.tokensBefore }
              : {}),
            ...(result.tokensAfter !== undefined
              ? { tokensAfter: result.tokensAfter }
              : {}),
            trigger: "user",
          },
        },
      ]);
      return { compactionSeq: lastSeq };
    });
  }

  async handleRespondToApproval(
    sessionId: string,
    approvalId: string,
    response: ApprovalResponse,
    clientId?: string,
  ): Promise<{ approvalId: string }> {
    const s = await this.#state(sessionId);
    return this.#serialize(s, async () => {
      const pending = (await this.#pendingApprovals(sessionId)).find(
        (a) => a.approvalId === approvalId,
      );
      if (!pending) {
        throw new OrchestratorError(
          "APPROVAL_NOT_PENDING",
          `approval ${approvalId} is not pending`,
        );
      }
      await this.#append(s, [
        {
          type: "approval.responded",
          v: 1,
          source: clientId ? { kind: "user", clientId } : { kind: "user" },
          payload: {
            approvalId,
            response,
            respondedBy: clientId ?? "unknown",
          },
        },
      ]);
      await (await this.#runtime(s)).respondToApproval(approvalId, response);
      return { approvalId };
    });
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
      model: null,
      thinkingLevel: "off",
      commandQueue: Promise.resolve(),
    };
    this.#sessions.set(sessionId, state);
    return state;
  }

  async #runtime(s: SessionState): Promise<RuntimeSession> {
    if (s.runtime) return s.runtime;
    s.runtime = await this.#adapter.createSession({
      sessionId: s.record.sessionId,
      workspaceDir: this.#workspaceDir,
      cwd: resolve(this.#workspaceDir, s.record.cwd),
      ...(s.record.runtimeSessionRef
        ? { runtimeSessionRef: s.record.runtimeSessionRef }
        : {}),
    });
    if (
      s.runtime.runtimeSessionRef !== s.record.runtimeSessionRef &&
      this.#store.updateRuntimeSessionRef
    ) {
      s.record = await this.#store.updateRuntimeSessionRef(
        s.record.sessionId,
        s.runtime.runtimeSessionRef,
      );
    }
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
      case "assistant-message-aborted":
        await this.#appendRuntime(s, "message.assistant.aborted", {
          messageId: ev.messageId,
          partialContent: ev.partialContent,
          reason: ev.reason,
        });
        return;
      case "assistant-message-failed":
        await this.#appendRuntime(s, "message.assistant.failed", {
          messageId: ev.messageId,
          partialContent: ev.partialContent,
          error: ev.error,
        });
        return;
      case "tool-call-started":
        await this.#appendRuntime(s, "tool.call.started", {
          toolCallId: ev.toolCallId,
          messageId: ev.messageId,
          runId: ev.runId,
          turnId: ev.turnId,
          name: ev.name,
          args: ev.args,
          ...(ev.runtimeToolCallId
            ? { runtimeToolCallId: ev.runtimeToolCallId }
            : {}),
        });
        return;
      case "tool-output-delta":
        this.#publishFrame({
          type: "tool.call.output.delta",
          sessionId: s.record.sessionId,
          branchId: s.record.rootBranchId,
          afterSeq: s.lastSeq,
          payload: {
            toolCallId: ev.toolCallId,
            delta: ev.delta,
            ...(ev.reset ? { reset: ev.reset } : {}),
          },
          emittedAt: new Date().toISOString(),
        });
        return;
      case "tool-call-completed":
        await this.#appendRuntime(s, "tool.call.completed", {
          toolCallId: ev.toolCallId,
          result: ev.result,
          durationMs: ev.durationMs,
        });
        return;
      case "tool-call-failed":
        await this.#appendRuntime(s, "tool.call.failed", {
          toolCallId: ev.toolCallId,
          error: ev.error,
          ...(ev.partialOutput ? { partialOutput: ev.partialOutput } : {}),
          ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
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
      case "run-aborted":
        await this.#appendRuntime(s, "run.aborted", {
          runId: ev.runId,
          reason: ev.reason,
        });
        s.run = null;
        s.busy = false;
        return;
      case "run-failed":
        await this.#appendRuntime(s, "run.failed", {
          runId: ev.runId,
          phase: "runtime",
          error: ev.error,
        });
        s.run = null;
        s.busy = false;
        return;
      case "model-changed":
        await this.#appendRuntime(s, "model.changed", {
          ...(ev.from ? { from: ev.from } : {}),
          to: ev.to,
          reason: "auto",
        });
        s.model = ev.to;
        return;
      case "thinking-level-changed":
        await this.#appendRuntime(s, "thinking.level.changed", {
          from: ev.from,
          to: ev.to,
        });
        s.thinkingLevel = ev.to as ThinkingLevel;
        return;
      case "approval-requested":
        await this.#appendRuntime(s, "approval.requested", ev.approval);
        return;
    }
  }

  async #submitText(
    s: SessionState,
    trigger: "prompt" | "steer" | "followUp",
    content: ContentBlock[],
    clientId?: string,
  ): Promise<{ messageId: string; seq: number }> {
    if (trigger === "prompt" && s.busy) {
      throw new OrchestratorError("SESSION_BUSY", "a turn is already active");
    }
    if (trigger !== "prompt" && !s.busy) {
      throw new OrchestratorError("TURN_NOT_ACTIVE", "no turn is active");
    }
    if (trigger === "prompt") s.busy = true;
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
          payload: {
            messageId,
            content,
            ...(trigger === "prompt" ? {} : { queued: trigger }),
          },
        },
      ]);
      try {
        const runtime = await this.#runtime(s);
        const input = { messageId, text: textContent(content) };
        if (trigger === "prompt") await runtime.prompt(input);
        else if (trigger === "steer") await runtime.steer(input);
        else await runtime.followUp(input);
      } catch (err) {
        if (trigger === "prompt") {
          await this.#appendRuntime(s, "run.failed", {
            runId: ulid(),
            triggerMessageId: messageId,
            phase: "dispatch",
            error: { code: "runtime_error", message: message(err) },
          });
        }
        throw err;
      }
      return { messageId, seq: lastSeq };
    } catch (err) {
      if (trigger === "prompt") s.busy = false;
      throw err;
    }
  }

  #serialize<T>(s: SessionState, fn: () => Promise<T>): Promise<T> {
    const run = s.commandQueue.then(fn, fn);
    s.commandQueue = run.then(
      () => {},
      () => {},
    );
    return run;
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
    reason: "daemon_shutdown" | "runtime_error" | "user_abort",
    err?: unknown,
  ): Promise<void> {
    const runtime = s.runtime?.getInFlightSnapshot() ?? null;
    const events: NewEvent[] = [];
    const assistant = runtime?.assistantMessage;
    if (assistant) {
      events.push({
        type:
          reason !== "runtime_error"
            ? "message.assistant.aborted"
            : "message.assistant.failed",
        v: 1,
        source:
          reason === "daemon_shutdown"
            ? { kind: "daemon" }
            : this.#runtimeSource,
        payload:
          reason !== "runtime_error"
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
        type: reason !== "runtime_error" ? "run.aborted" : "run.failed",
        v: 1,
        source:
          reason !== "runtime_error" ? { kind: "daemon" } : this.#runtimeSource,
        payload:
          reason !== "runtime_error"
            ? { runId: s.run.runId, reason }
            : {
                runId: s.run.runId,
                phase: "runtime",
                error: { code: "runtime_error", message: message(err) },
              },
      });
    }
    const approvals = await this.#pendingApprovals(s.record.sessionId);
    for (const approval of approvals) {
      events.push({
        type: "approval.cancelled",
        v: 1,
        source: { kind: "daemon" },
        payload: {
          approvalId: approval.approvalId,
          reason: reason === "user_abort" ? "turn_aborted" : "daemon_shutdown",
        },
      });
    }
    if (events.length > 0) await this.#append(s, events);
    s.busy = false;
    s.run = null;
  }

  async #pendingApprovals(sessionId: string) {
    if (this.#store.listPendingApprovals) {
      return (
        await this.#store.listPendingApprovals({ allProjects: true })
      ).filter((a) => a.sessionId === sessionId);
    }
    const { events } = await this.#store.readEvents(sessionId, 0);
    return pendingApprovalsFromEvents(events);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function textContent(content: ContentBlock[]): string {
  return content.map((b) => (b.type === "text" ? b.text : "")).join("");
}
