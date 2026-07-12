import type { AgentTaskSummary, ContentBlock } from "@agena/protocol";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  Square,
} from "lucide-react";
import { useMemo, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import {
  ensureSubscribed,
  pushToast,
  useApprovals,
  useSessions,
  useTranscripts,
} from "../../store/index.ts";
import { Badge, Button, cx } from "../../ui/index.ts";
import {
  projectAgentTasks,
  projectAllAgentTasks,
  tasksForParentToolCall,
} from "./tasks.ts";

const ACTIVE = new Set<AgentTaskSummary["status"]>(["created", "running"]);

function summaryText(blocks: readonly ContentBlock[] | undefined): string {
  return (blocks ?? [])
    .flatMap((block) =>
      "text" in block && typeof block.text === "string" ? [block.text] : [],
    )
    .join(" ")
    .trim();
}

function elapsed(task: AgentTaskSummary): string | null {
  const start = Date.parse(task.startedAt ?? task.createdAt);
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

async function openChild(sessionId: string): Promise<void> {
  useSessions.getState().setActive(sessionId);
  try {
    await ensureSubscribed(sessionId);
  } catch (error) {
    pushToast({
      kind: "err",
      title: "Could not open agent",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function stopChild(task: AgentTaskSummary): Promise<void> {
  try {
    await getBridge().abort(task.childSessionId, "user");
  } catch (error) {
    pushToast({
      kind: "err",
      title: "Could not stop agent",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function TaskRow({
  task,
  compact = false,
  detail = true,
}: {
  task: AgentTaskSummary;
  compact?: boolean;
  detail?: boolean;
}) {
  const active = ACTIVE.has(task.status);
  const approvals = useApprovals(
    (state) =>
      Object.values(state.pending).filter(
        (approval) => approval.sessionId === task.childSessionId,
      ).length,
  );
  const model = `${task.resolvedModel.provider}/${task.resolvedModel.id}`;
  const summary = summaryText(task.summary);
  return (
    <div
      className={cx(
        "flex items-start gap-2",
        compact
          ? "py-1"
          : "border-t border-border-subtle px-3 py-2 first:border-t-0",
      )}
    >
      <span
        className={cx(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          active
            ? "bg-accent animate-pulse-soft"
            : task.status === "completed"
              ? "bg-success"
              : task.status === "failed"
                ? "bg-danger"
                : "bg-fg-faint",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium text-fg">
            {task.role}
          </span>
          <Badge
            tone={
              task.status === "failed" ? "danger" : active ? "info" : "neutral"
            }
          >
            {task.status}
          </Badge>
          {approvals > 0 ? <Badge tone="warn">approval needed</Badge> : null}
          <span className="truncate font-mono text-2xs text-fg-faint">
            {model}
          </span>
          <span className="ml-auto text-2xs tabular-nums text-fg-faint">
            {task.usage?.costUsd !== undefined
              ? `$${task.usage.costUsd.toFixed(3)} · `
              : ""}
            {elapsed(task)}
          </span>
        </div>
        {detail ? (
          <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">
            {task.error?.message ?? (summary || task.task)}
          </p>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon={<ExternalLink />}
        onClick={() => void openChild(task.childSessionId)}
      >
        Open
      </Button>
      {active ? (
        <Button
          size="sm"
          variant="danger-ghost"
          icon={<Square />}
          onClick={() => void stopChild(task)}
        >
          Stop
        </Button>
      ) : null}
    </div>
  );
}

export function SubagentReceipt({
  parentSessionId,
  parentToolCallId,
  running,
}: {
  parentSessionId: string;
  parentToolCallId: string;
  running: boolean;
}) {
  const events = useTranscripts(
    (state) => state.bySession[parentSessionId]?.rawEvents,
  );
  const tasks = useMemo(
    () => tasksForParentToolCall(events ?? [], parentToolCallId),
    [events, parentToolCallId],
  );
  const [expanded, setExpanded] = useState(false);
  const totalCost = tasks.reduce(
    (sum, task) => sum + (task.usage?.costUsd ?? 0),
    0,
  );
  const active = tasks.filter((task) => ACTIVE.has(task.status)).length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const duration =
    tasks.reduce(
      (max, task) =>
        Math.max(max, Date.parse(task.finishedAt ?? task.createdAt)),
      0,
    ) -
    tasks.reduce(
      (min, task) => Math.min(min, Date.parse(task.createdAt)),
      Number.POSITIVE_INFINITY,
    );
  const label =
    tasks.length === 0
      ? "Delegating agents"
      : active > 0 || running
        ? `Delegated to ${tasks.length} ${tasks.length === 1 ? "agent" : "agents"}`
        : failed > 0
          ? `${failed} agent${failed === 1 ? "" : "s"} failed`
          : `${completed} agent${completed === 1 ? "" : "s"} completed`;
  return (
    <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex h-9 w-full items-center gap-2 px-3 text-left transition-colors duration-100 hover:bg-raised/60"
      >
        {active > 0 || running ? (
          <LoaderCircle className="size-3.5 animate-spin text-accent" />
        ) : (
          <Bot className="size-3.5 text-fg-muted" />
        )}
        <span className="text-xs font-medium text-fg">{label}</span>
        {active > 0 ? <Badge tone="info">{active} active</Badge> : null}
        <span className="flex-1" />
        {tasks.length > 0 && duration > 0 ? (
          <span className="text-2xs tabular-nums text-fg-faint">
            {Math.round(duration / 1000)}s
            {totalCost > 0 ? ` · $${totalCost.toFixed(3)}` : ""}
          </span>
        ) : null}
        {expanded ? (
          <ChevronDown className="size-4 text-fg-muted" />
        ) : (
          <ChevronRight className="size-4 text-fg-muted" />
        )}
      </button>
      {expanded ? (
        <div className="max-h-64 overflow-y-auto border-t border-border-subtle">
          {tasks.length > 0 ? (
            tasks.map((task) => <TaskRow key={task.taskId} task={task} />)
          ) : (
            <div className="px-3 py-2 text-xs text-fg-muted">
              Preparing isolated task sessions…
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ActiveAgents({ parentSessionId }: { parentSessionId: string }) {
  const events = useTranscripts(
    (state) => state.bySession[parentSessionId]?.rawEvents,
  );
  const tasks = useMemo(
    () =>
      projectAgentTasks(events ?? []).filter((task) => ACTIVE.has(task.status)),
    [events],
  );
  if (tasks.length === 0) return null;
  const visible = tasks.slice(0, 3);
  return (
    <div className="mx-auto mb-2 w-full max-w-[760px] border-y border-border-subtle bg-surface/70 px-3 py-1.5">
      <div className="flex items-center gap-2 py-0.5 text-2xs font-medium uppercase tracking-wider text-fg-muted">
        <span className="size-1.5 animate-pulse-soft rounded-full bg-accent" />
        {tasks.length} active {tasks.length === 1 ? "agent" : "agents"}
      </div>
      {visible.map((task) => (
        <TaskRow key={task.taskId} task={task} compact detail={false} />
      ))}
      {tasks.length > visible.length ? (
        <div className="py-0.5 pl-3 text-2xs text-fg-muted">
          +{tasks.length - visible.length} more running
        </div>
      ) : null}
    </div>
  );
}

export function ChildSessionBanner({ sessionId }: { sessionId: string }) {
  const transcripts = useTranscripts((state) => state.bySession);
  const task = useMemo(
    () =>
      projectAllAgentTasks(transcripts).find(
        (item) => item.childSessionId === sessionId,
      ),
    [sessionId, transcripts],
  );
  if (!task) return null;
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-3 text-xs text-fg-muted">
      <Bot className="size-3.5" />
      <span>
        Subagent: <strong className="font-medium text-fg">{task.role}</strong>
      </span>
      <span className="truncate">{task.task}</span>
      <span className="hidden text-fg-faint lg:inline">
        Continue this chat with read-only tools.
      </span>
      <span className="flex-1" />
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void openChild(task.parentSessionId)}
      >
        Back to parent
      </Button>
      {ACTIVE.has(task.status) ? (
        <Button
          size="sm"
          variant="danger-ghost"
          onClick={() => void stopChild(task)}
        >
          Stop
        </Button>
      ) : null}
    </div>
  );
}
