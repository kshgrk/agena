import {
  Bot,
  ChevronDown,
  MessageSquarePlus,
  Plus,
  Search,
} from "lucide-react";
import { useMemo, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import { formatBridgeError } from "../../lib/errors.ts";
import {
  ensureSubscribed,
  pushToast,
  useApprovals,
  useSessions,
  useTranscripts,
} from "../../store/index.ts";
import {
  Button,
  cx,
  EmptyState,
  Input,
  RelativeTime,
  Spinner,
} from "../../ui/index.ts";
import {
  nestedSessionRows,
  projectSidebarAgentTasks,
} from "../agents/tasks.ts";
import {
  createGlobalSessionInput,
  createProjectSessionInput,
  pathTail,
  splitSessionSections,
} from "./sections.ts";

async function refreshSessions(): Promise<void> {
  useSessions.getState().setAll(
    await getBridge().listSessionSummaries({
      allProjects: true,
      includeArchived: true,
    }),
  );
}

async function activate(sessionId: string): Promise<void> {
  useSessions.getState().setActive(sessionId);
  await ensureSubscribed(sessionId);
}

export function MobileSessions() {
  const byId = useSessions((s) => s.byId);
  const order = useSessions((s) => s.order);
  const loading = useSessions((s) => s.loading);
  const error = useSessions((s) => s.error);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const pending = useApprovals((s) => s.pending);
  const transcripts = useTranscripts((s) => s.bySession);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [collapsedAgentParents, setCollapsedAgentParents] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const sections = useMemo(
    () => splitSessionSections(byId, order, query),
    [byId, order, query],
  );
  const agentTasks = useMemo(
    () => projectSidebarAgentTasks(transcripts, byId),
    [byId, transcripts],
  );
  const agentChildren = useMemo(() => {
    const children = new Map<string, number>();
    for (const task of agentTasks) {
      children.set(
        task.parentSessionId,
        (children.get(task.parentSessionId) ?? 0) + 1,
      );
    }
    return children;
  }, [agentTasks]);

  const create = async (groupKey: string, seedId?: string) => {
    if (creating) return;
    setCreating(groupKey);
    try {
      const project = seedId ? byId[seedId] : undefined;
      const input = seedId
        ? project
          ? createProjectSessionInput(project)
          : null
        : createGlobalSessionInput();
      if (!input) throw new Error("Project metadata is incomplete");
      const sessionId = await getBridge().createSession(input);
      await refreshSessions();
      await activate(sessionId);
    } catch (err) {
      pushToast({
        kind: "err",
        title: "Could not create session",
        detail: formatBridgeError(err),
      });
    } finally {
      setCreating(null);
    }
  };

  const toggle = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isCollapsed = (key: string) => !query.trim() && collapsed.has(key);

  const toggleAgentChildren = (sessionId: string) => {
    setCollapsedAgentParents((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const agentChildrenCollapsed = (sessionId: string) =>
    !query.trim() && collapsedAgentParents.has(sessionId);

  const rows = (ids: readonly string[]) =>
    nestedSessionRows(ids, agentTasks)
      .filter(
        (row) =>
          row.depth === 0 ||
          !agentChildrenCollapsed(row.task?.parentSessionId ?? ""),
      )
      .map((row) => {
        const id = row.id;
        const session = byId[id];
        if (!session) return null;
        const childCount = agentChildren.get(id) ?? 0;
        const taskActive =
          row.task?.status === "created" || row.task?.status === "running";
        const pendingCount = Object.values(pending).filter(
          (approval) => approval.sessionId === id,
        ).length;
        const runtime =
          useTranscripts.getState().bySession[id]?.runtimeStatus?.state;
        return (
          <div
            key={id}
            className={cx(
              "flex min-w-0 items-center",
              row.depth === 1 && "ml-6 border-l border-border-subtle pl-1",
            )}
          >
            {childCount > 0 ? (
              <button
                type="button"
                aria-label={`${agentChildrenCollapsed(id) ? "Expand" : "Collapse"} ${childCount} subagent${childCount === 1 ? "" : "s"}`}
                aria-expanded={!agentChildrenCollapsed(id)}
                onClick={() => toggleAgentChildren(id)}
                className="flex size-11 shrink-0 items-center justify-center rounded-xl text-fg-muted active:bg-raised"
              >
                <ChevronDown
                  className={cx(
                    "size-4 transition-transform duration-100",
                    agentChildrenCollapsed(id) && "-rotate-90",
                  )}
                />
              </button>
            ) : row.task ? (
              <span className="flex size-8 shrink-0 items-center justify-center text-fg-faint">
                <Bot className="size-4" />
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => void activate(id)}
              className={cx(
                "flex min-h-13 min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-xl px-3 py-2 text-left active:bg-raised",
                activeSessionId === id && "bg-raised",
              )}
            >
              <span
                className={cx(
                  "size-2 shrink-0 rounded-full",
                  pendingCount > 0
                    ? "bg-warn"
                    : taskActive || (runtime && runtime !== "idle")
                      ? "bg-accent animate-pulse-soft"
                      : row.task?.status === "completed"
                        ? "bg-success"
                        : row.task?.status === "failed"
                          ? "bg-danger"
                          : "bg-fg-faint",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">
                  {session.title || row.task?.role || "Untitled session"}
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
                  <span className="truncate font-mono">
                    {row.task
                      ? `${row.task.role} agent`
                      : pathTail(session.cwd)}
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-fg-faint">
                    ·
                  </span>
                  {row.task ? (
                    <span className="shrink-0 capitalize">
                      {row.task.status}
                    </span>
                  ) : (
                    <RelativeTime
                      iso={session.updatedAt}
                      className="shrink-0"
                    />
                  )}
                </span>
              </span>
              {childCount > 0 ? (
                <span className="rounded-full bg-raised px-2 py-1 text-2xs tabular-nums text-fg-muted">
                  {childCount}
                </span>
              ) : null}
              {pendingCount > 0 ? (
                <span className="rounded-full bg-warn/15 px-2 py-1 text-2xs font-medium text-warn">
                  {pendingCount} approval{pendingCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </button>
          </div>
        );
      });

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-canvas">
      <div className="shrink-0 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted" />
          <Input
            value={query}
            aria-label="Search sessions"
            placeholder="Search projects and sessions"
            className="h-11 pl-9 text-base"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-fg-muted">
            <Spinner /> Loading sessions…
          </div>
        ) : error ? (
          <EmptyState
            icon={MessageSquarePlus}
            title="Could not load sessions"
            hint={error}
          />
        ) : sections.visibleCount === 0 ? (
          <EmptyState
            icon={MessageSquarePlus}
            title={query ? "No matching sessions" : "No sessions yet"}
            hint={
              query
                ? "Try a different search."
                : "Create a global session to start."
            }
            action={
              query ? undefined : (
                <Button variant="primary" onClick={() => void create("global")}>
                  New session
                </Button>
              )
            }
          />
        ) : (
          <div className="grid min-w-0 gap-5">
            {sections.projectGroups.map((group) => (
              <section key={group.key} className="min-w-0">
                <div className="flex min-h-11 items-center justify-between px-2">
                  <button
                    type="button"
                    aria-expanded={!isCollapsed(group.key)}
                    onClick={() => toggle(group.key)}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"
                  >
                    <ChevronDown
                      className={cx(
                        "size-4 shrink-0 transition-transform duration-100",
                        isCollapsed(group.key) && "-rotate-90",
                      )}
                    />
                    <span className="truncate">{group.label}</span>
                    <span className="shrink-0 font-normal text-fg-faint">
                      {group.ids.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`New session in ${group.label}`}
                    disabled={creating !== null}
                    onClick={() => void create(group.key, group.ids[0])}
                    className="flex size-11 items-center justify-center rounded-full text-accent active:bg-raised disabled:opacity-40"
                  >
                    <Plus className="size-5" />
                  </button>
                </div>
                {isCollapsed(group.key) ? null : (
                  <div className="grid min-w-0 gap-1">{rows(group.ids)}</div>
                )}
              </section>
            ))}
            {sections.globalIds.length > 0 ? (
              <section className="min-w-0">
                <div className="flex min-h-11 items-center justify-between px-2">
                  <button
                    type="button"
                    aria-expanded={!isCollapsed("global")}
                    onClick={() => toggle("global")}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"
                  >
                    <ChevronDown
                      className={cx(
                        "size-4 shrink-0 transition-transform duration-100",
                        isCollapsed("global") && "-rotate-90",
                      )}
                    />
                    <span>Global</span>
                    <span className="font-normal text-fg-faint">
                      {sections.globalIds.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label="New global session"
                    disabled={creating !== null}
                    onClick={() => void create("global")}
                    className="flex size-11 items-center justify-center rounded-full text-accent active:bg-raised disabled:opacity-40"
                  >
                    <Plus className="size-5" />
                  </button>
                </div>
                {isCollapsed("global") ? null : (
                  <div className="grid min-w-0 gap-1">
                    {rows(sections.globalIds)}
                  </div>
                )}
              </section>
            ) : null}
            {sections.archivedIds.length > 0 ? (
              <section className="min-w-0">
                <div className="flex min-h-11 items-center px-2">
                  <button
                    type="button"
                    aria-expanded={!isCollapsed("archived")}
                    onClick={() => toggle("archived")}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left text-xs font-semibold uppercase tracking-wider text-fg-muted"
                  >
                    <ChevronDown
                      className={cx(
                        "size-4 shrink-0 transition-transform duration-100",
                        isCollapsed("archived") && "-rotate-90",
                      )}
                    />
                    <span>Archived</span>
                    <span className="font-normal text-fg-faint">
                      {sections.archivedIds.length}
                    </span>
                  </button>
                </div>
                {isCollapsed("archived") ? null : (
                  <div className="grid min-w-0 gap-1 opacity-70">
                    {rows(sections.archivedIds)}
                  </div>
                )}
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
