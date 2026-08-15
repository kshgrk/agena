import "@git-diff-view/react/styles/diff-view.css";
import "../diff/diff.css";
import type {
  GitChangedFile,
  GitWorktreeChanges,
  SessionChangeDiffQuery,
  SessionChangeDiffResponse,
  SessionChangesResponse,
} from "@agena/protocol";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  FileDiff,
  GitCommitHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { getBridge } from "../../lib/bridge.ts";
import {
  resolveAppearance,
  useConnection,
  useTranscripts,
  useUi,
} from "../../store/index.ts";
import { cx, EmptyState, RelativeTime } from "../../ui/index.ts";
import { diffLangForPath } from "../diff/diff-store.ts";
import { buildUnifiedHunks, composeGitDiff } from "../diff/unified-diff.ts";

export const OPEN_SESSION_CHANGES_EVENT = "agena:open-session-changes";

export function openSessionChanges(sessionId: string): void {
  window.dispatchEvent(
    new CustomEvent(OPEN_SESSION_CHANGES_EVENT, { detail: { sessionId } }),
  );
}

type Group = {
  id: string;
  worktree: GitWorktreeChanges;
  label: string;
  detail: string;
  source: SessionChangeDiffQuery["source"];
  commit?: string;
  files: GitChangedFile[];
  additions: number;
  deletions: number;
  abandoned?: boolean;
  committedAt?: string;
};

function groupsFor(summary: SessionChangesResponse | null): Group[] {
  if (!summary) return [];
  const groups: Group[] = [];
  for (const worktree of summary.worktrees) {
    if (!worktree.available) continue;
    const current = [
      ["conflict", "Conflicts", worktree.current.conflicts],
      ["unstaged", "Uncommitted", worktree.current.unstaged],
      ["staged", "Staged", worktree.current.staged],
      ["untracked", "Untracked", worktree.current.untracked],
    ] as const;
    for (const [source, label, files] of current) {
      if (files.length === 0) continue;
      groups.push({
        id: `${worktree.worktreeId}:${source}`,
        worktree,
        label,
        detail: worktree.branch ?? worktree.root,
        source,
        files,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      });
    }
    for (const commit of [...worktree.commits].reverse()) {
      groups.push({
        id: `${worktree.worktreeId}:commit:${commit.oid}`,
        worktree,
        label: commit.title || commit.shortOid,
        detail: `${commit.shortOid} · ${commit.author}`,
        source: "commit",
        commit: commit.oid,
        files: commit.files,
        additions: commit.additions,
        deletions: commit.deletions,
        abandoned: commit.state === "abandoned",
        committedAt: commit.committedAt,
      });
    }
  }
  return groups;
}

type QueryState = {
  summary: SessionChangesResponse | null;
  loading: boolean;
  error: string | null;
};

const EMPTY_QUERY: QueryState = { summary: null, loading: false, error: null };
const summaryRequests = new Map<string, Promise<void>>();
const useChangesQueries = create<{ bySession: Record<string, QueryState> }>(
  () => ({ bySession: {} }),
);
const CHANGE_REFRESH_EVENTS = new Set([
  "git.baseline.recorded",
  "git.head.observed",
  "tool.call.completed",
  "tool.call.failed",
  "tool.call.aborted",
  "tool.call.denied",
  "run.completed",
  "run.failed",
  "run.aborted",
]);

function requestSummary(sessionId: string): Promise<void> {
  const existing = summaryRequests.get(sessionId);
  if (existing) return existing;
  const bridge = getBridge();
  if (!bridge) return Promise.resolve();
  const current = useChangesQueries.getState().bySession[sessionId];
  useChangesQueries.setState((state) => ({
    bySession: {
      ...state.bySession,
      [sessionId]: { ...(current ?? EMPTY_QUERY), loading: true },
    },
  }));
  const pending = bridge
    .getSessionChanges(sessionId)
    .then((summary) => {
      useChangesQueries.setState((state) => ({
        bySession: {
          ...state.bySession,
          [sessionId]: { summary, loading: false, error: null },
        },
      }));
    })
    .catch((cause: unknown) => {
      useChangesQueries.setState((state) => ({
        bySession: {
          ...state.bySession,
          [sessionId]: {
            ...(state.bySession[sessionId] ?? EMPTY_QUERY),
            loading: false,
            error:
              cause instanceof Error ? cause.message : "Changes unavailable",
          },
        },
      }));
    })
    .finally(() => summaryRequests.delete(sessionId));
  summaryRequests.set(sessionId, pending);
  return pending;
}

function useSessionChanges(sessionId: string, pollMs = 0) {
  const connected = useConnection((state) => state.state === "connected");
  const refreshSeq = useTranscripts((state) => {
    const events = state.bySession[sessionId]?.rawEvents;
    if (!events) return 0;
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (event && CHANGE_REFRESH_EVENTS.has(event.type)) return event.seq;
    }
    return 0;
  });
  const query = useChangesQueries(
    (state) => state.bySession[sessionId] ?? EMPTY_QUERY,
  );
  const refresh = useCallback(() => {
    if (!connected) return Promise.resolve();
    return requestSummary(sessionId);
  }, [connected, sessionId]);
  // Relevant durable events intentionally trigger a refresh without entering the callback body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshSeq is the event signal
  useEffect(() => {
    void refresh();
  }, [refresh, refreshSeq]);
  useEffect(() => {
    if (!pollMs) return;
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, refresh]);
  return { ...query, refresh };
}

function Stats({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span className="shrink-0 text-xs tabular-nums">
      <span className="text-diff-add-fg">+{additions}</span>{" "}
      <span className="text-diff-del-fg">−{deletions}</span>
    </span>
  );
}

export function SessionChangesPill({ sessionId }: { sessionId: string }) {
  const { summary, error } = useSessionChanges(sessionId);
  if (!summary || error || summary.totals.files === 0) return null;
  return (
    <button
      type="button"
      onClick={() => openSessionChanges(sessionId)}
      aria-label={`Review ${summary.totals.files} changed files`}
      className="absolute bottom-3 left-1/2 z-20 flex min-h-9 -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface px-3 text-xs font-medium text-fg-secondary shadow-lg transition-colors hover:bg-raised hover:text-fg active:scale-[0.98]"
    >
      <FileDiff className="size-3.5 text-accent" />
      <span className="tabular-nums">
        {summary.totals.files} {summary.totals.files === 1 ? "file" : "files"}
      </span>
      <span aria-hidden="true" className="h-3 w-px bg-border" />
      <Stats
        additions={summary.totals.additions}
        deletions={summary.totals.deletions}
      />
      {summary.totals.conflicts > 0 ? (
        <AlertTriangle className="size-3.5 text-warn" />
      ) : null}
      <ChevronRight className="size-3.5 text-fg-faint" />
    </button>
  );
}

function ChangeDiff({
  value,
  loading = false,
}: {
  value: SessionChangeDiffResponse | null;
  loading?: boolean;
}) {
  const theme = useUi((state) => state.theme);
  const resolvedTheme = resolveAppearance(theme.appearance);
  const data = useMemo(() => {
    if (value?.kind !== "text") return null;
    const { hunks } = buildUnifiedHunks(value.oldText, value.newText);
    return {
      oldFile: {
        fileName: value.path,
        fileLang: diffLangForPath(value.path),
        content: value.oldText,
      },
      newFile: {
        fileName: value.path,
        fileLang: diffLangForPath(value.path),
        content: value.newText,
      },
      hunks: composeGitDiff(value.path, hunks),
    };
  }, [value]);
  if (loading)
    return (
      <EmptyState
        icon={RefreshCw}
        title="Loading diff…"
        hint="Reading this revision from Git."
      />
    );
  if (!value)
    return (
      <EmptyState
        icon={FileDiff}
        title="Choose a file"
        hint="Select a change to review its exact contents."
      />
    );
  if (value.kind !== "text")
    return (
      <EmptyState
        icon={FileDiff}
        title="Preview unavailable"
        hint={value.message}
      />
    );
  if (!data?.hunks.length)
    return <EmptyState icon={FileDiff} title="No text changes" />;
  return (
    <DiffView
      key={`${value.path}:${value.oldText.length}:${value.newText.length}`}
      data={data}
      diffViewMode={DiffModeEnum.Unified}
      diffViewTheme={resolvedTheme}
      diffViewHighlight
      diffViewFontSize={13}
    />
  );
}

function History({
  groups,
  selected,
  onSelect,
}: {
  groups: Group[];
  selected: string | null;
  onSelect: (group: Group) => void;
}) {
  return (
    <div className="h-full overflow-auto p-2">
      <div className="px-2 pb-2 pt-1 text-2xs font-semibold uppercase tracking-wider text-fg-muted">
        Session history
      </div>
      {groups.map((group) => (
        <button
          key={group.id}
          type="button"
          onClick={() => onSelect(group)}
          className={cx(
            "mb-1 flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left",
            selected === group.id
              ? "bg-raised text-fg"
              : "text-fg-secondary hover:bg-raised/60",
          )}
        >
          {group.source === "commit" ? (
            <GitCommitHorizontal className="mt-0.5 size-4 shrink-0" />
          ) : (
            <CircleDot className="mt-0.5 size-4 shrink-0 text-accent" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {group.label}
            </span>
            <span className="block truncate text-2xs text-fg-muted">
              {group.detail}
            </span>
          </span>
          <span className="text-2xs text-fg-faint">{group.files.length}</span>
        </button>
      ))}
    </div>
  );
}

function Files({
  group,
  selected,
  onSelect,
}: {
  group: Group;
  selected: string | null;
  onSelect: (file: GitChangedFile) => void;
}) {
  return (
    <div className="h-full overflow-auto p-2">
      <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
        <span className="truncate text-xs font-semibold text-fg-secondary">
          {group.label}
        </span>
        <Stats additions={group.additions} deletions={group.deletions} />
      </div>
      {group.abandoned ? (
        <div className="mx-2 mb-2 rounded-md border border-warn/30 bg-warn/10 px-2 py-1.5 text-xs text-warn">
          This commit is no longer on the current branch.
        </div>
      ) : null}
      {group.files.map((file) => (
        <button
          key={`${file.previousPath ?? ""}:${file.path}`}
          type="button"
          onClick={() => onSelect(file)}
          className={cx(
            "flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left",
            selected === file.path ? "bg-raised" : "hover:bg-raised/60",
          )}
        >
          <span
            className={cx(
              "w-4 shrink-0 text-center font-mono text-2xs font-semibold uppercase",
              file.status === "deleted"
                ? "text-diff-del-fg"
                : file.status === "conflict"
                  ? "text-warn"
                  : "text-diff-add-fg",
            )}
          >
            {file.status[0]}
          </span>
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-fg-secondary"
            title={file.path}
          >
            {file.path}
          </span>
          <Stats additions={file.additions} deletions={file.deletions} />
        </button>
      ))}
    </div>
  );
}

function ChangeTree({
  groups,
  totals,
  selectedGroup,
  selectedPath,
  onSelect,
}: {
  groups: Group[];
  totals: SessionChangesResponse["totals"];
  selectedGroup: string | null;
  selectedPath: string | null;
  onSelect: (group: Group, file: GitChangedFile) => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          files:
            needle && !group.label.toLowerCase().includes(needle)
              ? group.files.filter((file) =>
                  file.path.toLowerCase().includes(needle),
                )
              : group.files,
        }))
        .filter((group) => group.files.length > 0),
    [groups, needle],
  );
  useEffect(() => {
    if (!selectedGroup) return;
    setCollapsed((current) => {
      if (!current.has(selectedGroup)) return current;
      const next = new Set(current);
      next.delete(selectedGroup);
      return next;
    });
  }, [selectedGroup]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <span className="text-xs font-semibold text-fg">Changes</span>
        <span className="text-2xs tabular-nums text-fg-muted">
          {totals.files} {totals.files === 1 ? "file" : "files"}
        </span>
        <span className="ml-auto">
          <Stats additions={totals.additions} deletions={totals.deletions} />
        </span>
      </div>
      <div className="shrink-0 border-b border-border-subtle p-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-border-subtle bg-inset px-2 text-fg-muted focus-within:border-border-strong focus-within:text-fg-secondary">
          <Search className="size-3.5 shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Filter files or commits"
            aria-label="Filter changed files and commits"
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-faint"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {visible.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-fg-muted">
            No matching changes
          </div>
        ) : null}
        {visible.map((group) => {
          const isCollapsed = collapsed.has(group.id);
          return (
            <div key={group.id} className="mb-1">
              <button
                type="button"
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    next.has(group.id)
                      ? next.delete(group.id)
                      : next.add(group.id);
                    return next;
                  })
                }
                className={cx(
                  "flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-raised/60",
                  selectedGroup === group.id && "bg-raised/70",
                )}
              >
                <ChevronDown
                  className={cx(
                    "mt-0.5 size-3.5 shrink-0 text-fg-faint transition-transform",
                    isCollapsed && "-rotate-90",
                  )}
                />
                {group.source === "commit" ? (
                  <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                ) : (
                  <CircleDot className="mt-0.5 size-4 shrink-0 text-accent" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-fg">
                    {group.label}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-2xs text-fg-muted">
                    <span className="truncate">{group.detail}</span>
                    {group.committedAt ? (
                      <RelativeTime
                        iso={group.committedAt}
                        className="shrink-0"
                      />
                    ) : null}
                  </span>
                </span>
                <span className="shrink-0 text-2xs text-fg-faint">
                  {group.files.length}
                </span>
              </button>
              {!isCollapsed ? (
                <div className="ml-[22px] border-l border-border-subtle pl-1">
                  {group.abandoned ? (
                    <div className="mx-1 my-1 rounded-md bg-warn/10 px-2 py-1.5 text-2xs text-warn">
                      No longer on the current branch
                    </div>
                  ) : null}
                  {group.files.map((file) => (
                    <button
                      key={`${file.previousPath ?? ""}:${file.path}`}
                      type="button"
                      onClick={() => onSelect(group, file)}
                      className={cx(
                        "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left",
                        selectedGroup === group.id && selectedPath === file.path
                          ? "bg-raised text-fg"
                          : "text-fg-secondary hover:bg-raised/50",
                      )}
                    >
                      <span
                        className={cx(
                          "w-3 shrink-0 text-center font-mono text-2xs font-semibold uppercase",
                          file.status === "deleted"
                            ? "text-diff-del-fg"
                            : file.status === "conflict"
                              ? "text-warn"
                              : "text-diff-add-fg",
                        )}
                      >
                        {file.status[0]}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-2xs"
                        title={file.path}
                      >
                        {file.path}
                      </span>
                      <Stats
                        additions={file.additions}
                        deletions={file.deletions}
                      />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const diffCache = new Map<string, SessionChangeDiffResponse>();

function rememberDiff(key: string, value: SessionChangeDiffResponse): void {
  diffCache.delete(key);
  diffCache.set(key, value);
  if (diffCache.size > 100) {
    const oldest = diffCache.keys().next().value;
    if (oldest) diffCache.delete(oldest);
  }
}

export function SessionChangesWorkspace({
  sessionId,
  mobile = false,
}: {
  sessionId: string;
  mobile?: boolean;
}) {
  const { summary, loading, error, refresh } = useSessionChanges(
    sessionId,
    30_000,
  );
  const groups = useMemo(() => groupsFor(summary), [summary]);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [diff, setDiff] = useState<SessionChangeDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileStep, setMobileStep] = useState<"history" | "files" | "diff">(
    "history",
  );
  const group = groups.find((item) => item.id === groupId) ?? groups[0] ?? null;
  const file =
    group?.files.find((item) => item.path === filePath) ??
    group?.files[0] ??
    null;
  const items = useMemo(
    () =>
      groups.flatMap((item) =>
        item.files.map((changedFile) => ({ group: item, file: changedFile })),
      ),
    [groups],
  );
  const selectedIndex = items.findIndex(
    (item) => item.group.id === group?.id && item.file.path === file?.path,
  );
  const diffKey =
    group && file
      ? [
          sessionId,
          group.id,
          file.path,
          group.commit ?? summary?.observedAt ?? "current",
        ].join("\0")
      : null;

  useEffect(() => {
    if (!group || !file || !diffKey) {
      setDiff(null);
      setDiffLoading(false);
      return;
    }
    const cached = diffCache.get(diffKey);
    if (cached) {
      setDiff(cached);
      setDiffLoading(false);
      return;
    }
    let live = true;
    setDiff(null);
    setDiffLoading(true);
    const input: SessionChangeDiffQuery = {
      worktreeId: group.worktree.worktreeId,
      source: group.source,
      path: file.path,
      ...(group.commit ? { commit: group.commit } : {}),
    };
    const bridge = getBridge();
    if (!bridge) {
      setDiffLoading(false);
      return;
    }
    bridge
      .getSessionChangeDiff(sessionId, input)
      .then((value) => {
        rememberDiff(diffKey, value);
        if (live) {
          setDiff(value);
          setDiffLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (live) {
          setDiff({
            kind: "unavailable",
            path: file.path,
            message:
              cause instanceof Error ? cause.message : "Diff unavailable",
          });
          setDiffLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [diffKey, file, group, sessionId]);

  const selectGroup = (next: Group) => {
    setGroupId(next.id);
    setFilePath(next.files[0]?.path ?? null);
    if (mobile) setMobileStep("files");
  };
  const selectFile = (next: GitChangedFile) => {
    setFilePath(next.path);
    if (mobile) setMobileStep("diff");
  };
  const selectItem = (nextGroup: Group, nextFile: GitChangedFile) => {
    setGroupId(nextGroup.id);
    setFilePath(nextFile.path);
  };
  const moveSelection = (offset: number) => {
    const next = items[selectedIndex + offset];
    if (next) selectItem(next.group, next.file);
  };

  if (error && !summary)
    return (
      <EmptyState icon={FileDiff} title="Changes unavailable" hint={error} />
    );
  if (!summary || (loading && groups.length === 0))
    return <EmptyState icon={RefreshCw} title="Reading Git changes…" />;
  if (groups.length === 0)
    return (
      <EmptyState
        icon={FileDiff}
        title="No session changes"
        hint="Commits and working-tree edits observed during this session will appear here."
      />
    );

  if (mobile) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface">
        <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border-subtle px-1">
          {mobileStep !== "history" ? (
            <button
              type="button"
              aria-label="Back"
              onClick={() =>
                setMobileStep(mobileStep === "diff" ? "files" : "history")
              }
              className="flex size-11 items-center justify-center rounded-lg active:bg-raised"
            >
              <ChevronLeft className="size-5" />
            </button>
          ) : null}
          <span className="min-w-0 flex-1 truncate px-2 text-sm font-semibold">
            {mobileStep === "history"
              ? "Session changes"
              : mobileStep === "files"
                ? group?.label
                : file?.path}
          </span>
          <button
            type="button"
            aria-label="Refresh changes"
            onClick={() => void refresh()}
            className="flex size-11 items-center justify-center rounded-lg text-fg-muted active:bg-raised"
          >
            <RefreshCw className={cx("size-4", loading && "animate-spin")} />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {mobileStep === "history" ? (
            <History
              groups={groups}
              selected={group?.id ?? null}
              onSelect={selectGroup}
            />
          ) : null}
          {mobileStep === "files" && group ? (
            <Files
              group={group}
              selected={file?.path ?? null}
              onSelect={selectFile}
            />
          ) : null}
          {mobileStep === "diff" ? (
            <div className="h-full overflow-auto bg-inset">
              <ChangeDiff value={diff} loading={diffLoading} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cx(
        "grid h-full min-h-0 bg-surface",
        sidebarOpen
          ? "grid-cols-[minmax(260px,34%)_minmax(0,1fr)]"
          : "grid-cols-[0_minmax(0,1fr)]",
      )}
    >
      <section
        className={cx(
          "min-h-0 overflow-hidden border-r border-border-subtle",
          !sidebarOpen && "border-r-0",
        )}
      >
        <ChangeTree
          groups={groups}
          totals={summary.totals}
          selectedGroup={group?.id ?? null}
          selectedPath={file?.path ?? null}
          onSelect={selectItem}
        />
      </section>
      <section className="flex min-h-0 min-w-0 flex-col bg-inset">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle bg-surface px-2">
          <button
            type="button"
            aria-label={sidebarOpen ? "Hide changes list" : "Show changes list"}
            onClick={() => setSidebarOpen((open) => !open)}
            className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-raised hover:text-fg"
          >
            {sidebarOpen ? (
              <PanelLeftClose className="size-3.5" />
            ) : (
              <PanelLeftOpen className="size-3.5" />
            )}
          </button>
          <span className="min-w-0 truncate font-mono text-xs text-fg-secondary">
            {file?.path ?? "Diff"}
          </span>
          <span className="ml-auto shrink-0 text-2xs tabular-nums text-fg-faint">
            {selectedIndex >= 0 ? `${selectedIndex + 1} / ${items.length}` : ""}
          </span>
          <button
            type="button"
            aria-label="Previous changed file"
            disabled={selectedIndex <= 0}
            onClick={() => moveSelection(-1)}
            className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-30"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Next changed file"
            disabled={selectedIndex < 0 || selectedIndex >= items.length - 1}
            onClick={() => moveSelection(1)}
            className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-30"
          >
            <ChevronRight className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Refresh changes"
            onClick={() => void refresh()}
            className="flex size-7 items-center justify-center rounded-md text-fg-muted hover:bg-raised hover:text-fg"
          >
            <RefreshCw className={cx("size-3.5", loading && "animate-spin")} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <ChangeDiff value={diff} loading={diffLoading} />
        </div>
      </section>
    </div>
  );
}
