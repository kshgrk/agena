import type {
  AgentTaskCreated,
  AgentTaskSummary,
  EventSource,
} from "@agena/protocol";
import { expect, test } from "vitest";
import { AgentOrchestrator } from "../src/agents/orchestrator.ts";
import type { AgentTaskStore } from "../src/events/store.ts";
import { InMemoryEventStore } from "../src/memory-store.ts";
import { SessionOrchestrator } from "../src/sessions/orchestrator.ts";
import { FakeRuntimeAdapter } from "../src/testing/index.ts";

test("delegation creates ordinary read-only child sessions and returns summaries", async () => {
  const store = new InMemoryEventStore() as InMemoryEventStore & AgentTaskStore;
  const tasks = new Map<string, AgentTaskSummary>();
  const parents = new Map<string, string>();
  const getSession = store.getSession.bind(store);
  store.getSession = async (sessionId) => {
    const session = await getSession(sessionId);
    const parentSessionId = parents.get(sessionId);
    return session && parentSessionId
      ? { ...session, parentSessionId }
      : session;
  };
  store.createSubagentSession = async (input: {
    parentSessionId: string;
    title?: string;
    source: EventSource;
    task: Omit<AgentTaskCreated, "parentSessionId" | "childSessionId">;
  }) => {
    const session = await store.createSession({
      workspaceId: "ws",
      ...(input.title ? { title: input.title } : {}),
    });
    const createdAt = new Date().toISOString();
    parents.set(session.sessionId, input.parentSessionId);
    const task: AgentTaskSummary = {
      ...input.task,
      parentSessionId: input.parentSessionId,
      childSessionId: session.sessionId,
      status: "created",
      createdAt,
    };
    tasks.set(task.taskId, task);
    await store.appendEvents({
      sessionId: input.parentSessionId,
      branchId:
        (await store.getSession(input.parentSessionId))?.rootBranchId ?? "",
      events: [
        {
          type: "agent.task.created",
          v: 1,
          source: input.source,
          payload: task,
        },
      ],
    });
    return {
      session: { ...session, parentSessionId: input.parentSessionId },
      task,
    };
  };
  store.getAgentTask = (taskId) => tasks.get(taskId) ?? null;
  store.listAgentTasks = () => [...tasks.values()];

  const adapter = new FakeRuntimeAdapter({
    delayMs: 5,
    script: () => ["checked"],
  });
  let agents: AgentOrchestrator;
  const sessions = new SessionOrchestrator(store, adapter, {
    subagents: { run: (input) => agents.run(input) },
  });
  agents = new AgentOrchestrator(store, sessions);
  const parent = await sessions.createSession({ workspaceId: "ws" });
  await store.appendEvents({
    sessionId: parent.sessionId,
    branchId: parent.rootBranchId,
    events: [
      {
        type: "tool.call.started",
        v: 1,
        source: { kind: "runtime" },
        payload: {
          toolCallId: "tool-1",
          messageId: "assistant-1",
          runId: "run-1",
          turnId: "turn-1",
          name: "subagent",
          args: {},
        },
      },
    ],
  });

  const result = await agents.run({
    parentSessionId: parent.sessionId,
    parentToolCallId: "tool-1",
    tasks: [{ role: "reviewer", task: "Check the implementation" }],
  });

  expect(result.tasks).toMatchObject([
    { role: "reviewer", status: "completed", summary: [{ text: "checked" }] },
  ]);
  expect(adapter.createInputs).toHaveLength(2);
  expect(adapter.createInputs[1]).toMatchObject({
    toolNames: ["read", "grep", "find", "ls"],
  });
  expect(adapter.createInputs[1]?.subagents).toBeUndefined();

  await store.appendEvents({
    sessionId: parent.sessionId,
    branchId: parent.rootBranchId,
    events: [
      {
        type: "tool.call.started",
        v: 1,
        source: { kind: "runtime" },
        payload: {
          toolCallId: "tool-2",
          messageId: "assistant-2",
          runId: "run-2",
          turnId: "turn-2",
          name: "subagent",
          args: {},
        },
      },
    ],
  });
  const abort = new AbortController();
  const cancelled = agents.run({
    parentSessionId: parent.sessionId,
    parentToolCallId: "tool-2",
    tasks: [{ role: "scout", task: "Keep looking" }],
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(), 1);

  await expect(cancelled).resolves.toMatchObject({
    tasks: [{ role: "scout", status: "cancelled" }],
  });
  expect(
    (await store.readEvents(parent.sessionId, 0, 100)).events.some(
      (event) => event.type === "agent.task.cancelled",
    ),
  ).toBe(true);
});
