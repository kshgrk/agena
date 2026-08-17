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
  FastModeState,
  InFlightSnapshot,
  ModelRef,
  SideChatAccess,
  ThinkingLevel,
} from "@agena/protocol";
import { ulid } from "ulid";
import type {
  ApprovalQueryStore,
  CreateDerivedSessionInput,
  CreateSessionInput,
  EventStore,
  NewEvent,
  RuntimeSessionRefStore,
  SessionRecord,
} from "../events/store.ts";
import { pendingApprovalsFromEvents } from "../events/store.ts";
import { materializeRuntimeContent } from "../runtime/media.ts";
import type {
  CreateRuntimeSessionInput,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeSession,
  SubagentController,
  VisibleBrowserController,
} from "../runtime/types.ts";
import { fallbackSessionTitle } from "./title.ts";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const SIDE_CHAT_PROMPTS: Record<SideChatAccess, string> = {
  read_only:
    "You are an Agena read-only side chat associated with a main conversation. You inherited your source conversation only through its latest completed assistant message when this side chat was created. The source conversation continues independently, so you cannot see later or in-progress activity. You share its live workspace but may only inspect it using read, grep, find, and ls. You cannot execute commands or modify files.",
  full: "You are an Agena full-access side chat associated with a main conversation. You inherited your source conversation only through its latest completed assistant message when this side chat was created. The source conversation continues independently, so you cannot see later or in-progress activity. You share the same live workspace and have the same available tools and approval policy as a normal main chat. Your changes and processes can affect the main chat's workspace.",
};

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
  visibleBrowser?: VisibleBrowserController;
  subagents?: SubagentController;
}

interface SessionState {
  record: SessionRecord;
  lastSeq: number; // highest committed seq — stamped on frames as afterSeq
  busy: boolean; // single in-flight turn per session (§5.4)
  run: { runId: string; triggerMessageId: string } | null;
  compaction: { id: string; replacesUpToSeq: number } | null;
  retry: {
    attempt: number;
    maxAttempts: number;
    nextAttemptAt: string;
  } | null;
  status: { state: string; detail?: string };
  runtime: RuntimeSession | null;
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  pendingEditFromMessageId: string | null;
  commandQueue: Promise<void>;
}

export class SessionOrchestrator {
  #store: EventStore;
  #adapter: RuntimeAdapter;
  #workspaceDir: string;
  #publishFrame: (frame: AgenaFrame) => void;
  #visibleBrowser: VisibleBrowserController | undefined;
  #subagents: SubagentController | undefined;
  #runtimeSource: EventSource;
  #sessions = new Map<string, SessionState>();
  #quickChatCreations = new Map<string, Promise<SessionRecord>>();
  // ponytail: one personal-workspace queue keeps ordinal titles unique; split
  // by root only if side-chat creation throughput ever matters.
  #quickChatCreationQueue: Promise<void> = Promise.resolve();

  constructor(
    store: EventStore,
    adapter: RuntimeAdapter,
    options: SessionOrchestratorOptions = {},
  ) {
    this.#store = store;
    this.#adapter = adapter;
    this.#workspaceDir = options.workspaceDir ?? "/workspace";
    this.#publishFrame = options.publishFrame ?? (() => {});
    this.#visibleBrowser = options.visibleBrowser;
    this.#subagents = options.subagents;
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

  async createQuickChat(
    parentSessionId: string,
    sideChatAccess: SideChatAccess = "read_only",
  ): Promise<SessionRecord> {
    const parent = await this.#state(parentSessionId);
    const creationKey = `${parentSessionId}:${sideChatAccess}`;
    const inFlight = this.#quickChatCreations.get(creationKey);
    if (inFlight) return inFlight;
    const creation = this.#quickChatCreationQueue.then(() =>
      this.#createQuickChat(parent, sideChatAccess),
    );
    this.#quickChatCreationQueue = creation.then(
      () => undefined,
      () => undefined,
    );
    this.#quickChatCreations.set(creationKey, creation);
    try {
      return await creation;
    } finally {
      this.#quickChatCreations.delete(creationKey);
    }
  }

  async #createQuickChat(
    parent: SessionState,
    sideChatAccess: SideChatAccess,
  ): Promise<SessionRecord> {
    const parentSessionId = parent.record.sessionId;
    const sessions = await this.#store.listSessions({
      allProjects: true,
      includeArchived: true,
    });
    const byId = new Map(
      sessions.map((session) => [session.sessionId, session]),
    );
    const rootSessionId = quickChatRootSessionId(parent.record, byId);
    const number =
      sessions.filter(
        (session) =>
          session.purpose === "quick_chat" &&
          quickChatRootSessionId(session, byId) === rootSessionId,
      ).length + 1;
    if (!this.#adapter.createForkSession) {
      throw new OrchestratorError(
        "INVALID_PAYLOAD",
        "runtime does not support session forks",
      );
    }
    const cutoff =
      await this.#store.getLatestCompletedAssistant(parentSessionId);
    if (cutoff && !cutoff.runtimeEntryId) {
      throw new OrchestratorError(
        "NOT_READY",
        "the latest completed turn is not ready to inherit",
      );
    }
    if (cutoff && !parent.record.runtimeSessionRef) {
      throw new OrchestratorError(
        "NOT_READY",
        "the parent runtime is not ready to inherit",
      );
    }
    const sessionId = ulid();
    const common = {
      sessionId,
      workspaceDir: this.#workspaceDir,
      cwd: resolve(this.#workspaceDir, parent.record.cwd),
      ...this.#runtimeCapabilities({
        sessionKind: "primary",
        purpose: "quick_chat",
        sideChatAccess,
      }),
    };
    const runtime = cutoff
      ? await this.#adapter.createForkSession({
          ...common,
          sourceRuntimeSessionRef: parent.record.runtimeSessionRef as string,
          runtimeEntryId: cutoff.runtimeEntryId as string,
          position: "at",
        })
      : await this.#adapter.createSession(common);
    try {
      const child = await this.#store.createDerivedSession({
        sessionId,
        parentSessionId,
        mode: "fork",
        purpose: "quick_chat",
        sideChatAccess,
        runtimeSessionRef: runtime.runtimeSessionRef,
        ...(cutoff ? { sourceMessageId: cutoff.messageId } : {}),
        title: `Quick Chat ${number}`,
      });
      const state = await this.#state(child.sessionId);
      state.runtime = runtime;
      void this.#pump(state, runtime);
      return child;
    } catch (error) {
      await runtime.dispose().catch(() => {});
      throw error;
    }
  }

  async forkSession(input: CreateDerivedSessionInput): Promise<SessionRecord> {
    const parent = await this.#state(input.parentSessionId);
    return this.#serialize(parent, async () => {
      if (parent.busy) {
        throw new OrchestratorError(
          "SESSION_BUSY",
          "cannot fork a running session",
        );
      }
      if (!this.#adapter.createForkSession) {
        throw new OrchestratorError(
          "INVALID_PAYLOAD",
          "runtime does not support session forks",
        );
      }
      if (input.mode === "fork" && !input.sourceMessageId) {
        throw new OrchestratorError(
          "INVALID_PAYLOAD",
          "sourceMessageId is required for fork",
        );
      }
      const runtimeEntryId = input.sourceMessageId
        ? await this.#store.getRuntimeMessageRef(
            input.parentSessionId,
            input.sourceMessageId,
          )
        : undefined;
      if (input.mode === "fork" && !runtimeEntryId) {
        throw new OrchestratorError(
          "INVALID_PAYLOAD",
          "the selected message is not available in the runtime session",
        );
      }
      const parentRuntime = await this.#runtime(parent);
      const child = await this.#store.createDerivedSession(input);
      const runtime = await this.#adapter.createForkSession({
        sessionId: child.sessionId,
        workspaceDir: this.#workspaceDir,
        cwd: resolve(this.#workspaceDir, child.cwd),
        sourceRuntimeSessionRef: parentRuntime.runtimeSessionRef,
        ...(runtimeEntryId ? { runtimeEntryId } : {}),
        position: input.mode === "fork" ? "before" : "at",
        ...this.#runtimeCapabilities(child),
      });
      const runtimeRefs = runtimeSessionRefs(this.#store);
      return runtimeRefs
        ? runtimeRefs.updateRuntimeSessionRef(
            child.sessionId,
            runtime.runtimeSessionRef,
          )
        : child;
    });
  }

  async navigateToMessage(
    sessionId: string,
    sourceMessageId: string,
  ): Promise<{ editorText: string }> {
    const s = await this.#state(sessionId);
    return this.#serialize(s, async () => {
      if (s.busy) {
        throw new OrchestratorError(
          "SESSION_BUSY",
          "cannot edit a message while the session is running",
        );
      }
      const runtimeEntryId = await this.#store.getRuntimeMessageRef(
        sessionId,
        sourceMessageId,
      );
      if (!runtimeEntryId) {
        throw new OrchestratorError(
          "INVALID_PAYLOAD",
          "the selected message is not available in the runtime session",
        );
      }
      const { editorText } = await (await this.#runtime(s)).navigateTree(
        runtimeEntryId,
      );
      s.pendingEditFromMessageId = sourceMessageId;
      return { editorText: editorText ?? "" };
    });
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
      retry: s.retry,
      queue: { steerCount: 0, followUpCount: 0 },
      status: s.status,
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

  /** Tear down live state for sessions being deleted (project removal). */
  async evictSessions(sessionIds: string[]): Promise<void> {
    await Promise.all(
      sessionIds.map(async (id) => {
        const s = this.#sessions.get(id);
        if (!s) return;
        if (s.busy) await this.#terminalize(s, "user_abort");
        await s.runtime?.dispose();
        this.#sessions.delete(id);
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

  async handleSetFastMode(
    sessionId: string,
    enabled: boolean,
  ): Promise<FastModeState> {
    const s = await this.#state(sessionId);
    return this.#serialize(s, async () => {
      let state: FastModeState;
      try {
        state = await (await this.#runtime(s)).setFastMode(enabled);
      } catch (err) {
        throw new OrchestratorError("RUNTIME_UNAVAILABLE", message(err));
      }
      await this.#append(s, [
        {
          type: "fast.mode.changed",
          v: 1,
          source: { kind: "user" },
          payload: { enabled: state.enabled },
        },
      ]);
      return state;
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
      s.busy = true;
      this.#frame(s, "compaction.started", { trigger: "user" });
      this.#status(s, "compacting");
      let result: {
        summary: string;
        tokensBefore?: number;
        tokensAfter?: number;
      };
      try {
        result = await (await this.#runtime(s)).compact();
      } catch (err) {
        s.busy = false;
        this.#status(s, "idle");
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
      s.busy = false;
      this.#status(s, "idle");
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
      compaction: null,
      retry: null,
      status: { state: "idle" },
      runtime: null,
      model: null,
      thinkingLevel: "off",
      pendingEditFromMessageId: null,
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
      ...this.#runtimeCapabilities(s.record),
    });
    const runtimeRefs = runtimeSessionRefs(this.#store);
    if (
      s.runtime.runtimeSessionRef !== s.record.runtimeSessionRef &&
      runtimeRefs
    ) {
      s.record = await runtimeRefs.updateRuntimeSessionRef(
        s.record.sessionId,
        s.runtime.runtimeSessionRef,
      );
    }
    void this.#pump(s, s.runtime);
    return s.runtime;
  }

  #runtimeCapabilities(
    session: Pick<SessionRecord, "sessionKind" | "purpose" | "sideChatAccess">,
  ): Partial<CreateRuntimeSessionInput> {
    const sideChatAccess =
      session.purpose === "quick_chat"
        ? (session.sideChatAccess ?? "read_only")
        : undefined;
    const readOnly =
      session.sessionKind === "subagent" || sideChatAccess === "read_only";
    return {
      ...(!readOnly && this.#visibleBrowser
        ? { visibleBrowser: this.#visibleBrowser }
        : {}),
      ...(!readOnly && session.sessionKind !== "subagent" && this.#subagents
        ? { subagents: this.#subagents }
        : {}),
      ...(readOnly ? { toolNames: READ_ONLY_TOOLS } : {}),
      ...(sideChatAccess
        ? { systemPromptAppendix: SIDE_CHAT_PROMPTS[sideChatAccess] }
        : {}),
    };
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
      if (s.runtime === runtime) s.runtime = null;
      await runtime.dispose().catch((inner) => {
        console.error(
          `[agena-core] failed to dispose broken runtime for session ${s.record.sessionId}:`,
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
      case "message-runtime-ref":
        await this.#appendRuntime(s, "message.runtime.ref", {
          messageId: ev.messageId,
          runtimeEntryId: ev.runtimeEntryId,
        });
        return;
      case "run-started":
        s.run = { runId: ev.runId, triggerMessageId: ev.triggerMessageId };
        s.status = { state: "generating" };
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
        this.#frame(s, "message.assistant.text.delta", {
          messageId: ev.messageId,
          blockIndex: ev.blockIndex,
          delta: ev.delta,
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
        this.#frame(s, "tool.call.output.delta", {
          toolCallId: ev.toolCallId,
          delta: ev.delta,
          ...(ev.reset ? { reset: ev.reset } : {}),
        });
        return;
      case "tool-call-completed":
        await this.#appendRuntime(s, "tool.call.completed", {
          toolCallId: ev.toolCallId,
          result: await materializeRuntimeContent(
            ev.result,
            (bytes, mimeType) => this.#store.putBlob(bytes, mimeType),
          ),
          durationMs: ev.durationMs,
        });
        return;
      case "tool-call-failed": {
        const partialOutput = ev.partialOutput
          ? await materializeRuntimeContent(
              ev.partialOutput,
              (bytes, mimeType) => this.#store.putBlob(bytes, mimeType),
            )
          : undefined;
        await this.#appendRuntime(s, "tool.call.failed", {
          toolCallId: ev.toolCallId,
          error: ev.error,
          ...(partialOutput ? { partialOutput } : {}),
          ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
        });
        return;
      }
      case "run-completed":
        await this.#appendRuntime(s, "run.completed", {
          runId: ev.runId,
          ...(ev.usage ? { usage: ev.usage } : {}),
        });
        s.run = null;
        s.busy = false;
        s.retry = null;
        s.status = { state: "idle" };
        return;
      case "run-aborted":
        await this.#appendRuntime(s, "run.aborted", {
          runId: ev.runId,
          reason: ev.reason,
        });
        s.run = null;
        s.busy = false;
        s.retry = null;
        s.status = { state: "idle" };
        return;
      case "run-failed":
        await this.#appendRuntime(s, "run.failed", {
          runId: ev.runId,
          phase: "runtime",
          error: ev.error,
        });
        s.run = null;
        s.busy = s.compaction !== null;
        s.retry = null;
        s.status = { state: s.busy ? "compacting" : "idle" };
        return;
      case "retry-started":
        s.busy = true;
        s.retry = {
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          nextAttemptAt: new Date(Date.now() + ev.delayMs).toISOString(),
        };
        this.#frame(s, "run.retry.started", {
          runId: ev.runId,
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
          errorSummary: ev.errorSummary,
        });
        this.#status(
          s,
          "retrying",
          `attempt ${ev.attempt}/${ev.maxAttempts} in ${Math.ceil(ev.delayMs / 1000)}s`,
        );
        return;
      case "retry-ended":
        s.retry = null;
        this.#frame(s, "run.retry.ended", {
          runId: ev.runId,
          outcome: ev.outcome,
        });
        this.#status(
          s,
          ev.outcome === "recovered" ? "generating" : "retrying",
          ev.outcome === "exhausted" ? "retries exhausted" : undefined,
        );
        return;
      case "compaction-started":
        s.busy = true;
        s.retry = null;
        s.compaction = { id: ulid(), replacesUpToSeq: s.lastSeq };
        this.#frame(s, "compaction.started", { trigger: ev.trigger });
        this.#status(s, "compacting", "reducing task context");
        return;
      case "compaction-completed": {
        const compaction = s.compaction ?? {
          id: ulid(),
          replacesUpToSeq: s.lastSeq,
        };
        await this.#appendRuntime(s, "compaction.created", {
          compactionId: compaction.id,
          summary: [{ type: "text", text: ev.summary }],
          replacesUpToSeq: compaction.replacesUpToSeq,
          tokensBefore: ev.tokensBefore,
          tokensAfter: ev.tokensAfter,
          trigger: ev.trigger,
        });
        s.compaction = null;
        s.busy = s.run !== null;
        this.#status(s, s.busy ? "generating" : "idle");
        return;
      }
      case "compaction-failed": {
        const compactionId = s.compaction?.id ?? ulid();
        await this.#appendRuntime(s, "compaction.failed", {
          compactionId,
          error: ev.error,
        });
        s.compaction = null;
        s.busy = s.run !== null;
        this.#status(s, s.busy ? "generating" : "idle");
        return;
      }
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
      case "session-title-changed":
        await this.#appendRuntime(s, "session.title.changed", {
          title: ev.title,
        });
        return;
      case "approval-requested":
        await this.#appendRuntime(s, "approval.requested", ev.approval);
        return;
    }
  }

  #frame(s: SessionState, type: string, payload: unknown): void {
    this.#publishFrame({
      type,
      sessionId: s.record.sessionId,
      branchId: s.record.rootBranchId,
      afterSeq: s.lastSeq,
      payload,
      emittedAt: new Date().toISOString(),
    });
  }

  #status(s: SessionState, state: string, detail?: string): void {
    const status = {
      state,
      ...(detail ? { detail } : {}),
    };
    s.status = status;
    this.#frame(s, "session.status.updated", status);
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
    const images = await Promise.all(
      content
        .filter((block) => block.type === "image")
        .map(async (block) => {
          const stored = await this.#store.readBlob(block.ref.blob);
          if (!stored) {
            throw new OrchestratorError(
              "INVALID_PAYLOAD",
              `image blob is unavailable: ${block.ref.blob}`,
            );
          }
          return {
            data: stored.bytes,
            mimeType:
              stored.mimeType ??
              block.ref.mimeType ??
              "application/octet-stream",
          };
        }),
    );
    const files = await Promise.all(
      content
        .filter((block) => block.type === "file")
        .map(async (block) => {
          const stored = await this.#store.readBlob(block.ref.blob);
          if (!stored) {
            throw new OrchestratorError(
              "INVALID_PAYLOAD",
              `attachment blob is unavailable: ${block.ref.blob}`,
            );
          }
          return {
            data: stored.bytes,
            blob: block.ref.blob,
            name: block.path ?? "attachment",
            mimeType:
              stored.mimeType ??
              block.ref.mimeType ??
              "application/octet-stream",
          };
        }),
    );
    if (trigger === "prompt") s.busy = true;
    try {
      const messageId = ulid();
      const editedFromMessageId =
        trigger === "prompt" ? s.pendingEditFromMessageId : null;
      const source: EventSource = clientId
        ? { kind: "user", clientId }
        : { kind: "user" };
      const events: NewEvent[] = [
        {
          type: "message.user.created",
          v: 1,
          source,
          payload: {
            messageId,
            content,
            ...(trigger === "prompt" ? {} : { queued: trigger }),
            ...(editedFromMessageId ? { editedFromMessageId } : {}),
          },
        },
      ];
      if (trigger === "prompt" && !s.record.title && s.lastSeq === 1) {
        events.push({
          type: "session.title.changed",
          v: 1,
          source,
          payload: { title: fallbackSessionTitle(content) },
        });
      }
      const appended = await this.#append(s, events);
      if (trigger === "prompt") s.pendingEditFromMessageId = null;
      const messageSeq =
        appended.events.find(
          (event) =>
            event.type === "message.user.created" &&
            (event.payload as { messageId?: unknown }).messageId === messageId,
        )?.seq ?? appended.lastSeq;
      try {
        const runtime = await this.#runtime(s);
        const input = {
          messageId,
          text: textContent(content),
          images,
          ...(files.length > 0 ? { files } : {}),
        };
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
      return { messageId, seq: messageSeq };
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
    s.lastSeq = Math.max(s.lastSeq, result.lastSeq);
    for (const event of result.events) {
      if (event.type === "session.title.changed") {
        const title = (event.payload as { title?: unknown }).title;
        if (typeof title === "string") {
          s.record = { ...s.record, title, updatedAt: event.createdAt };
        }
      }
    }
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
    const approvals = approvalQueries(this.#store);
    if (approvals) {
      return (
        await approvals.listPendingApprovals({ allProjects: true })
      ).filter((a) => a.sessionId === sessionId);
    }
    const { events } = await this.#store.readEvents(sessionId, 0);
    return pendingApprovalsFromEvents(events);
  }
}

function quickChatRootSessionId(
  session: SessionRecord,
  byId: ReadonlyMap<string, SessionRecord>,
): string {
  let current = session;
  const seen = new Set<string>();
  while (current.purpose === "quick_chat" && current.parentSessionId) {
    if (seen.has(current.sessionId)) return session.sessionId;
    seen.add(current.sessionId);
    const parent = byId.get(current.parentSessionId);
    if (!parent) return current.parentSessionId;
    current = parent;
  }
  return current.sessionId;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function textContent(content: ContentBlock[]): string {
  return content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

function runtimeSessionRefs(store: EventStore): RuntimeSessionRefStore | null {
  return "updateRuntimeSessionRef" in store
    ? (store as EventStore & RuntimeSessionRefStore)
    : null;
}

function approvalQueries(store: EventStore): ApprovalQueryStore | null {
  return "listPendingApprovals" in store
    ? (store as EventStore & ApprovalQueryStore)
    : null;
}
