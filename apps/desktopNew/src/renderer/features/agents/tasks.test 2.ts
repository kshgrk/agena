import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@agena/protocol";
import { emptyTranscript, type RawEventRow } from "../../store/types.ts";
import {
  nestedSessionRows,
  projectAgentTasks,
  projectAllAgentTasks,
  projectSidebarAgentTasks,
  tasksForParentToolCall,
} from "./tasks.ts";

const base = {
  taskId: "task-1",
  parentSessionId: "parent",
  childSessionId: "child",
  parentRunId: "run",
  parentMessageId: "message",
  parentToolCallId: "tool",
  role: "researcher",
  task: "Find the answer",
  execution: "background",
  context: "fresh",
  workspaceMode: "shared_readonly",
  resolvedModel: { provider: "openai", id: "gpt" },
} as const;

function row(seq: number, type: string, payload: unknown): RawEventRow {
  return {
    seq,
    type,
    payload,
    at: `2026-01-01T00:00:0${seq}Z`,
    source: { kind: "runtime", runtime: "pi" },
  };
}

test("projects agent task lifecycle and nests its child session", () => {
  const tasks = projectAgentTasks([
    row(1, "agent.task.created", base),
    row(2, "agent.task.started", {
      taskId: "task-1",
      startedAt: "2026-01-01T00:00:02Z",
    }),
    row(3, "agent.task.completed", {
      taskId: "task-1",
      resultMessageId: "result",
      summary: [],
    }),
  ]);
  assert.equal(tasks[0]?.status, "completed");
  assert.deepEqual(nestedSessionRows(["parent", "child", "other"], tasks), [
    { id: "parent", depth: 0 },
    {
      id: "child",
      depth: 1,
      task: {
        ...base,
        status: "completed",
        createdAt: "2026-01-01T00:00:01Z",
        startedAt: "2026-01-01T00:00:02Z",
        resultMessageId: "result",
        summary: [],
        finishedAt: "2026-01-01T00:00:03Z",
      },
    },
    { id: "other", depth: 0 },
  ]);
});

test("ignores malformed and orphan task events", () => {
  assert.deepEqual(
    projectAgentTasks([
      row(1, "agent.task.created", { taskId: "broken" }),
      row(2, "agent.task.failed", {
        taskId: "missing",
        error: { code: "x", message: "x" },
      }),
    ]),
    [],
  );
});

test("groups task receipts by the originating tool call", () => {
  const tasks = [
    row(1, "agent.task.created", base),
    row(2, "agent.task.created", {
      ...base,
      taskId: "task-2",
      childSessionId: "child-2",
      parentToolCallId: "other-tool",
    }),
  ];
  assert.deepEqual(
    tasksForParentToolCall(tasks, "tool").map((task) => task.taskId),
    ["task-1"],
  );
});

test("prefers the durable session summary task state", () => {
  const tasks = projectAllAgentTasks(
    {
      parent: {
        ...emptyTranscript("parent"),
        rawEvents: [row(1, "agent.task.created", base)],
      },
    },
    {
      child: {
        sessionId: "child",
        workspaceId: "workspace",
        rootBranchId: "branch",
        lastSeq: 1,
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:03Z",
        scope: "project",
        status: "idle",
        cwd: ".",
        subagent: {
          taskId: "task-1",
          role: "researcher",
          status: "completed",
          createdAt: "2026-01-01T00:00:01Z",
          finishedAt: "2026-01-01T00:00:03Z",
        },
      } satisfies SessionSummary,
    },
  );
  assert.equal(tasks[0]?.status, "completed");
  assert.equal(tasks[0]?.finishedAt, "2026-01-01T00:00:03Z");
});

test("restores sidebar children from durable summaries without transcripts", () => {
  const tasks = projectSidebarAgentTasks(
    {},
    {
      child: {
        sessionId: "child",
        parentSessionId: "parent",
        subagent: {
          taskId: "task-1",
          role: "researcher",
          status: "completed",
          createdAt: "2026-01-01T00:00:01Z",
        },
      } as SessionSummary,
    },
  );
  assert.deepEqual(nestedSessionRows(["parent", "child"], tasks), [
    { id: "parent", depth: 0 },
    {
      id: "child",
      depth: 1,
      task: {
        taskId: "task-1",
        parentSessionId: "parent",
        childSessionId: "child",
        role: "researcher",
        status: "completed",
        createdAt: "2026-01-01T00:00:01Z",
      },
    },
  ]);
});
