import type {
  AgenaEvent,
  AgentTaskCreated,
  ContentBlock,
  ModelRef,
  UsageTotals,
} from "@agena/protocol";
import { ulid } from "ulid";
import type { AgentTaskStore, EventStore, NewEvent } from "../events/store.ts";
import type { SubagentController } from "../runtime/types.ts";
import type { SessionOrchestrator } from "../sessions/orchestrator.ts";

const MAX_TASKS = 4;
type CompletionWaiter = {
  promise: Promise<{ summary: ContentBlock[]; usage?: UsageTotals }>;
  cancel: () => void;
};

class SubagentCancelled extends Error {
  readonly reason: "user" | "parent_aborted";

  constructor(reason: "user" | "parent_aborted") {
    super("subagent cancelled");
    this.reason = reason;
  }
}

export class AgentOrchestrator implements SubagentController {
  readonly #store: EventStore & AgentTaskStore;
  readonly #sessions: SessionOrchestrator;

  constructor(
    store: EventStore & AgentTaskStore,
    sessions: SessionOrchestrator,
  ) {
    this.#store = store;
    this.#sessions = sessions;
  }

  async run(input: Parameters<SubagentController["run"]>[0]) {
    if (input.tasks.length < 1 || input.tasks.length > MAX_TASKS) {
      throw new Error(`subagent requires 1-${MAX_TASKS} tasks`);
    }
    const parent = await this.#store.getSession(input.parentSessionId);
    if (!parent)
      throw new Error(`unknown parent session ${input.parentSessionId}`);
    if (parent.parentSessionId)
      throw new Error("subagents cannot delegate recursively");
    const correlation = await this.#toolCorrelation(
      input.parentSessionId,
      input.parentToolCallId,
    );
    const parentInfo = await this.#sessions.handleRuntimeInfo(
      input.parentSessionId,
    );
    if (!parentInfo.model)
      throw new Error("parent session has no resolved model");
    const parentModel = parentInfo.model;

    const tasks = await Promise.all(
      input.tasks.map((task) =>
        this.#runOne({
          ...task,
          parent,
          parentRunId: correlation.runId,
          parentMessageId: correlation.messageId,
          parentToolCallId: input.parentToolCallId,
          resolvedModel: task.model ?? parentModel,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      ),
    );
    return { tasks };
  }

  async #runOne(input: {
    role: string;
    task: string;
    model?: ModelRef;
    parent: NonNullable<Awaited<ReturnType<EventStore["getSession"]>>>;
    parentRunId: string;
    parentMessageId: string;
    parentToolCallId: string;
    resolvedModel: ModelRef;
    signal?: AbortSignal;
  }) {
    if (input.signal?.aborted) throw new SubagentCancelled("parent_aborted");
    const taskId = ulid();
    const created: Omit<
      AgentTaskCreated,
      "parentSessionId" | "childSessionId"
    > = {
      taskId,
      parentRunId: input.parentRunId,
      parentMessageId: input.parentMessageId,
      parentToolCallId: input.parentToolCallId,
      role: input.role,
      task: input.task,
      execution: "foreground",
      context: "fresh",
      workspaceMode: "shared_readonly",
      ...(input.model ? { requestedModel: input.model } : {}),
      resolvedModel: input.resolvedModel,
    };
    const { session } = await this.#store.createSubagentSession({
      parentSessionId: input.parent.sessionId,
      title: input.role,
      source: { kind: "runtime" },
      task: created,
    });
    await this.#appendParent(input.parent, "agent.task.started", {
      taskId,
      startedAt: new Date().toISOString(),
    });

    let completion: CompletionWaiter | null = null;
    try {
      await this.#sessions.handleSetModel(
        session.sessionId,
        input.resolvedModel,
      );
      completion = this.#waitForCompletion(session.sessionId, input.signal);
      await this.#sessions.handlePrompt(session.sessionId, [
        {
          type: "text",
          text: `You are the ${input.role} subagent. Complete this bounded read-only task and return a concise result. Do not modify files and do not delegate.\n\n${input.task}`,
        },
      ]);
      const result = await completion.promise;
      const summary = boundSummary(result.summary);
      await this.#appendParent(input.parent, "agent.task.completed", {
        taskId,
        resultMessageId: `agent-result:${taskId}`,
        summary,
        ...(result.usage ? { usage: result.usage } : {}),
      });
      return {
        taskId,
        childSessionId: session.sessionId,
        role: input.role,
        status: "completed" as const,
        summary,
      };
    } catch (error) {
      completion?.cancel();
      await this.#sessions.handleAbort(session.sessionId).catch(() => {});
      if (error instanceof SubagentCancelled) {
        await this.#appendParent(input.parent, "agent.task.cancelled", {
          taskId,
          reason: error.reason,
        });
        return {
          taskId,
          childSessionId: session.sessionId,
          role: input.role,
          status: "cancelled" as const,
          summary: [{ type: "text" as const, text: "Cancelled" }],
        };
      }
      const summary = [{ type: "text" as const, text: message(error) }];
      await this.#appendParent(input.parent, "agent.task.failed", {
        taskId,
        error: { code: "subagent_failed", message: message(error) },
        summary,
      });
      return {
        taskId,
        childSessionId: session.sessionId,
        role: input.role,
        status: "failed" as const,
        summary,
      };
    }
  }

  async #toolCorrelation(parentSessionId: string, toolCallId: string) {
    const existing = await this.#findTool(parentSessionId, toolCallId);
    if (existing) return existing;
    return new Promise<{ runId: string; messageId: string }>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          unsubscribe();
          reject(new Error(`parent tool call ${toolCallId} was not persisted`));
        }, 5_000);
        const unsubscribe = this.#store.onCommitted((batch) => {
          if (batch.sessionId !== parentSessionId) return;
          const found = findTool(batch.events, toolCallId);
          if (!found) return;
          clearTimeout(timeout);
          unsubscribe();
          resolve(found);
        });
      },
    );
  }

  async #findTool(sessionId: string, toolCallId: string) {
    const { events } = await this.#store.readEvents(sessionId, 0, 10_000);
    return findTool(events, toolCallId);
  }

  #waitForCompletion(
    sessionId: string,
    parentSignal?: AbortSignal,
  ): CompletionWaiter {
    let cancel = () => {};
    const promise = new Promise<{
      summary: ContentBlock[];
      usage?: UsageTotals;
    }>((resolve, reject) => {
      let summary: ContentBlock[] = [];
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("subagent timed out after 10 minutes"));
      }, 10 * 60_000);
      const onParentAbort = () => {
        cleanup();
        reject(new SubagentCancelled("parent_aborted"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribe();
        parentSignal?.removeEventListener("abort", onParentAbort);
      };
      const unsubscribe = this.#store.onCommitted((batch) => {
        if (batch.sessionId !== sessionId) return;
        for (const event of batch.events) {
          if (event.type === "message.assistant.completed") {
            const payload = event.payload as { content?: ContentBlock[] };
            summary = payload.content ?? [];
          }
          if (event.type === "run.failed" || event.type === "run.aborted") {
            cleanup();
            reject(
              event.type === "run.aborted"
                ? new SubagentCancelled("user")
                : new Error(`subagent ${event.type}`),
            );
            return;
          }
          if (event.type === "run.completed") {
            cleanup();
            const payload = event.payload as { usage?: UsageTotals };
            resolve({
              summary,
              ...(payload.usage ? { usage: payload.usage } : {}),
            });
            return;
          }
        }
      });
      parentSignal?.addEventListener("abort", onParentAbort, { once: true });
      if (parentSignal?.aborted) onParentAbort();
      cancel = cleanup;
    });
    return { promise, cancel };
  }

  async #appendParent(
    parent: NonNullable<Awaited<ReturnType<EventStore["getSession"]>>>,
    type: string,
    payload: unknown,
  ) {
    const event: NewEvent = { type, v: 1, source: { kind: "daemon" }, payload };
    await this.#store.appendEvents({
      sessionId: parent.sessionId,
      branchId: parent.rootBranchId,
      events: [event],
    });
  }
}

function findTool(events: AgenaEvent[], toolCallId: string) {
  for (const event of events) {
    if (event.type !== "tool.call.started") continue;
    const payload = event.payload as {
      toolCallId?: string;
      runId?: string;
      messageId?: string;
    };
    if (
      payload.toolCallId === toolCallId &&
      payload.runId &&
      payload.messageId
    ) {
      return { runId: payload.runId, messageId: payload.messageId };
    }
  }
  return null;
}

function boundSummary(blocks: ContentBlock[]): ContentBlock[] {
  const text = blocks
    .map((block) => (block.type === "text" ? block.text : "[content]"))
    .join("\n")
    .slice(0, 20_000);
  return [{ type: "text", text }];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
