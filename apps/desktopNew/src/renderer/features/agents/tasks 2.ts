import {
  type AgentTaskSummary,
  agentTaskCancelledSchema,
  agentTaskCompletedSchema,
  agentTaskCreatedSchema,
  agentTaskFailedSchema,
  agentTaskStartedSchema,
  type SessionSummary,
} from "@agena/protocol";
import type { RawEventRow, TranscriptState } from "../../store/types.ts";

export function projectAgentTasks(
  events: readonly RawEventRow[],
): AgentTaskSummary[] {
  const tasks = new Map<string, AgentTaskSummary>();
  for (const event of events) {
    if (event.type === "agent.task.created") {
      const parsed = agentTaskCreatedSchema.safeParse(event.payload);
      if (parsed.success) {
        tasks.set(parsed.data.taskId, {
          ...parsed.data,
          status: "created",
          createdAt: event.at,
        });
      }
      continue;
    }
    const taskId =
      typeof event.payload === "object" && event.payload !== null
        ? (event.payload as { taskId?: unknown }).taskId
        : undefined;
    if (typeof taskId !== "string") continue;
    const task = tasks.get(taskId);
    if (!task) continue;
    if (event.type === "agent.task.started") {
      const parsed = agentTaskStartedSchema.safeParse(event.payload);
      if (parsed.success) {
        tasks.set(taskId, {
          ...task,
          status: "running",
          startedAt: parsed.data.startedAt,
        });
      }
    } else if (event.type === "agent.task.completed") {
      const parsed = agentTaskCompletedSchema.safeParse(event.payload);
      if (parsed.success) {
        tasks.set(taskId, {
          ...task,
          ...parsed.data,
          status: "completed",
          finishedAt: event.at,
        });
      }
    } else if (event.type === "agent.task.failed") {
      const parsed = agentTaskFailedSchema.safeParse(event.payload);
      if (parsed.success) {
        tasks.set(taskId, {
          ...task,
          ...parsed.data,
          status: "failed",
          finishedAt: event.at,
        });
      }
    } else if (event.type === "agent.task.cancelled") {
      const parsed = agentTaskCancelledSchema.safeParse(event.payload);
      if (parsed.success) {
        tasks.set(taskId, {
          ...task,
          status: "cancelled",
          finishedAt: event.at,
        });
      }
    }
  }
  return [...tasks.values()];
}

export function projectAllAgentTasks(
  transcripts: Readonly<Record<string, TranscriptState>>,
  sessions?: Readonly<Record<string, SessionSummary>>,
): AgentTaskSummary[] {
  const tasks = Object.values(transcripts).flatMap((transcript) =>
    projectAgentTasks(transcript.rawEvents),
  );
  if (!sessions) return tasks;
  return tasks.map((task) => {
    const current = sessions[task.childSessionId]?.subagent;
    return current?.taskId === task.taskId ? { ...task, ...current } : task;
  });
}

/** The session list is sufficient to restore the sidebar after a reload. */
export type SidebarAgentTask = Pick<
  AgentTaskSummary,
  | "taskId"
  | "parentSessionId"
  | "childSessionId"
  | "role"
  | "status"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
>;

export function projectSidebarAgentTasks(
  transcripts: Readonly<Record<string, TranscriptState>>,
  sessions: Readonly<Record<string, SessionSummary>>,
): SidebarAgentTask[] {
  const tasks = new Map<string, SidebarAgentTask>();
  for (const task of projectAllAgentTasks(transcripts, sessions)) {
    tasks.set(task.taskId, task);
  }
  for (const session of Object.values(sessions)) {
    const task = session.subagent;
    if (!task || !session.parentSessionId) continue;
    tasks.set(task.taskId, {
      ...task,
      parentSessionId: session.parentSessionId,
      childSessionId: session.sessionId,
    });
  }
  return [...tasks.values()];
}

export function tasksForParentToolCall(
  events: readonly RawEventRow[],
  parentToolCallId: string,
): AgentTaskSummary[] {
  return projectAgentTasks(events).filter(
    (task) => task.parentToolCallId === parentToolCallId,
  );
}

export type NestedSessionRow = {
  id: string;
  depth: 0 | 1;
  task?: SidebarAgentTask;
};

export function nestedSessionRows(
  ids: readonly string[],
  tasks: readonly SidebarAgentTask[],
): NestedSessionRow[] {
  const child = new Map(tasks.map((task) => [task.childSessionId, task]));
  const children = new Map<string, SidebarAgentTask[]>();
  for (const task of tasks) {
    const rows = children.get(task.parentSessionId) ?? [];
    rows.push(task);
    children.set(task.parentSessionId, rows);
  }
  const present = new Set(ids);
  const out: NestedSessionRow[] = [];
  for (const id of ids) {
    if (child.has(id) && present.has(child.get(id)?.parentSessionId ?? "")) {
      continue;
    }
    out.push({ id, depth: 0 });
    for (const task of children.get(id) ?? []) {
      if (present.has(task.childSessionId)) {
        out.push({ id: task.childSessionId, depth: 1, task });
      }
    }
  }
  return out;
}
