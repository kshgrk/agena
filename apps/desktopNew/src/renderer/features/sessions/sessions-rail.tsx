// Left rail — project-grouped session list with filter-as-you-type, live
// status dots (running / pending approval), context menus, the new-session
// flow (project pick/create/copy-folder + optional first prompt handed to the
// composer), and delete-project with typed confirm. Ported and reworked from
// apps/desktop sessions-rail.tsx per design.md §5.
import type {
  CreateSessionRequest,
  SessionStatus,
  SessionSummary,
} from "@agena/protocol";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  Inbox,
  MessageSquarePlus,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import { formatBridgeError, isDesktopOnlyError } from "../../lib/errors.ts";
import {
  ensureSubscribed,
  pushToast,
  registerCommands,
  useApprovals,
  useSessions,
  useTranscripts,
  useUi,
} from "../../store/index.ts";
import {
  Badge,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cx,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  IconButton,
  Input,
  Segmented,
  Select,
  Textarea,
} from "../../ui/index.ts";
import {
  createGlobalSessionInput,
  createProjectSessionInput,
  cycleOrder,
  type ProjectGroup,
  splitSessionSections,
} from "./sections.ts";

// ---- store-level flows (module scope: no component identity churn) -----------

function errToast(title: string, err: unknown): void {
  pushToast({ kind: "err", title, detail: formatBridgeError(err) });
}

async function refresh(): Promise<void> {
  const sessions = useSessions.getState();
  sessions.setLoading(true);
  try {
    sessions.setAll(
      await getBridge().listSessionSummaries({
        allProjects: true,
        includeArchived: true,
      }),
    );
  } catch (err) {
    sessions.setError(formatBridgeError(err));
  }
}

/** Select a session: active highlight + subscribe (store owns the cursor). */
function activate(sessionId: string): void {
  useSessions.getState().setActive(sessionId);
  ensureSubscribed(sessionId).catch((err: unknown) =>
    errToast("Failed to subscribe to session", err),
  );
}

async function setSessionStatus(
  sessionId: string,
  status: SessionStatus,
): Promise<void> {
  try {
    await getBridge().updateSessionStatus(sessionId, status);
    useSessions.getState().setStatus(sessionId, status);
  } catch (err) {
    errToast("Failed to update session", err);
  }
}

/** Create + subscribe(0) + refresh + activate + hand `firstPrompt` to the
 * composer (the cross-pane insert also focuses it — "" = just focus). */
async function openNewSession(
  input: Partial<CreateSessionRequest>,
  firstPrompt = "",
): Promise<void> {
  const id = await getBridge().createSession(input);
  await ensureSubscribed(id, 0);
  await refresh();
  useSessions.getState().setActive(id);
  useUi.getState().requestComposerInsert(firstPrompt);
}

function copyText(text: string, what: string): void {
  void navigator.clipboard.writeText(text);
  pushToast({ kind: "ok", title: `${what} copied` });
}

/**
 * D-INV-3: radix menus don't bump the overlay counter themselves, and radix
 * never fires onOpenChange(false) on unmount — so the counter is driven by an
 * effect WITH CLEANUP. A row unmounting while its menu is open (session
 * archived/removed by another client mid-right-click) must not leak
 * overlayCount, which would hide the native browser view forever.
 */
function CountedContextMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    useUi.getState().enterOverlay();
    return () => useUi.getState().exitOverlay();
  }, [open]);
  return <ContextMenu onOpenChange={setOpen}>{children}</ContextMenu>;
}

// ---- rows --------------------------------------------------------------------

// memo: sessions.bump replaces byId on every durable event of ANY session but
// keeps unchanged summary refs — memo skips re-rendering the whole rail's rows
// (each row carries a radix ContextMenu tree) per event batch.
const SessionRow = memo(function SessionRow({
  session,
  active,
}: {
  session: SessionSummary;
  active: boolean;
}) {
  // features.md §5.1: origin badge for imported sessions, read from the loaded
  // transcript's session.created row (present once history is paged to seq 1).
  const importOrigin = useTranscripts((s) => {
    const first = s.bySession[session.sessionId]?.rawEvents[0];
    const origin =
      first?.type === "session.created"
        ? (first.payload as { origin?: unknown } | null)?.origin
        : undefined;
    return typeof origin === "string" && origin.startsWith("import.")
      ? origin.slice("import.".length)
      : null;
  });
  const pendingCount = useApprovals((s) => {
    let n = 0;
    for (const a of Object.values(s.pending)) {
      if (a.sessionId === session.sessionId) n++;
    }
    return n;
  });
  const archived = session.status === "archived";
  const activity = useTranscripts((s) => {
    const state = s.bySession[session.sessionId]?.runtimeStatus?.state;
    return state && state !== "idle" ? state : null;
  });

  return (
    <CountedContextMenu>
      <ContextMenuTrigger>
        <button
          type="button"
          onClick={() => activate(session.sessionId)}
          className={cx(
            "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors",
            active ? "bg-raised" : "hover:bg-raised/60",
            archived && "opacity-60",
          )}
        >
          <span
            title={pendingCount > 0 ? "Approval needed" : (activity ?? "Idle")}
            className={cx(
              "size-1.5 shrink-0 rounded-full",
              pendingCount > 0
                ? "bg-warn"
                : activity
                  ? "bg-accent animate-pulse-soft"
                  : "bg-fg-faint",
            )}
          />
          <span
            className={cx(
              "min-w-0 flex-1 truncate text-sm",
              active ? "font-medium text-fg" : "text-fg-secondary",
              !session.title && "text-fg-muted",
            )}
          >
            {session.title || "untitled"}
          </span>
          {importOrigin ? <Badge>{importOrigin}</Badge> : null}
          {pendingCount > 0 ? <Badge tone="warn">{pendingCount}</Badge> : null}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => activate(session.sessionId)}>
          <Play />
          Resume session
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void setSessionStatus(
              session.sessionId,
              archived ? "idle" : "archived",
            )
          }
        >
          {archived ? <ArchiveRestore /> : <Archive />}
          {archived ? "Unarchive" : "Archive"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => copyText(session.sessionId, "Session id")}
        >
          <Copy />
          Copy session id
        </ContextMenuItem>
      </ContextMenuContent>
    </CountedContextMenu>
  );
});

// ---- the rail -----------------------------------------------------------------

export function SessionsRail() {
  const byId = useSessions((s) => s.byId);
  const order = useSessions((s) => s.order);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const loading = useSessions((s) => s.loading);
  const error = useSessions((s) => s.error);

  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"projects" | "tasks">("projects");
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    projectId: string;
    label: string;
    ids: string[];
  } | null>(null);

  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    void refresh();
  }, []);

  // D-INV-3: the delete dialog is an overlay (radix doesn't bump the counter).
  const deleting = deleteTarget !== null;
  useEffect(() => {
    if (!deleting) return;
    useUi.getState().enterOverlay();
    return () => useUi.getState().exitOverlay();
  }, [deleting]);

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const createGlobalSession = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await openNewSession(createGlobalSessionInput());
    } catch (err) {
      errToast("Failed to create session", err);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const createProjectSession = useCallback(
    async (seed: SessionSummary | undefined) => {
      if (busy) return;
      const input = seed && createProjectSessionInput(seed);
      if (!input) {
        pushToast({ kind: "err", title: "Project metadata is missing" });
        return;
      }
      setBusy(true);
      try {
        await openNewSession(input);
      } catch (err) {
        errToast("Failed to create session", err);
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const deleteProject = useCallback(async () => {
    if (!deleteTarget || busy) return;
    setBusy(true);
    try {
      const res = await getBridge().deleteProject(deleteTarget.projectId);
      const s = useSessions.getState();
      if (s.activeSessionId && deleteTarget.ids.includes(s.activeSessionId)) {
        s.setActive(null);
      }
      setDeleteTarget(null);
      pushToast({
        kind: "ok",
        title: `Deleted ${deleteTarget.label}`,
        detail: `${res.deletedSessions} session${res.deletedSessions === 1 ? "" : "s"} removed`,
      });
      await refresh();
    } catch (err) {
      errToast("Failed to delete project", err);
    } finally {
      setBusy(false);
    }
  }, [busy, deleteTarget]);

  // session.* commands (palette + shortcuts; ARCHITECTURE contract 2)
  useEffect(() => {
    const cycle = (dir: 1 | -1) => {
      const s = useSessions.getState();
      const ids = cycleOrder(
        splitSessionSections(s.byId, s.order, queryRef.current),
      );
      if (ids.length === 0) return;
      const i = s.activeSessionId ? ids.indexOf(s.activeSessionId) : -1;
      const next =
        ids[
          i === -1
            ? dir === 1
              ? 0
              : ids.length - 1
            : (i + dir + ids.length) % ids.length
        ];
      if (next) activate(next);
    };
    return registerCommands([
      {
        id: "session.new",
        title: "New session…",
        group: "Session",
        shortcut: "mod+n",
        run: () => setNewOpen(true),
      },
      {
        id: "project.open",
        title: "New project…",
        group: "Session",
        shortcut: "mod+o",
        keywords: ["open", "folder", "import"],
        run: () => setNewOpen(true),
      },
      {
        id: "session.next",
        title: "Next session",
        group: "Session",
        shortcut: "mod+alt+arrowdown",
        run: () => cycle(1),
      },
      {
        id: "session.prev",
        title: "Previous session",
        group: "Session",
        shortcut: "mod+alt+arrowup",
        run: () => cycle(-1),
      },
    ]);
  }, []);

  const sections = useMemo(
    () => splitSessionSections(byId, order, query),
    [byId, order, query],
  );
  const dialogGroups = useMemo(
    () => splitSessionSections(byId, order).projectGroups,
    [byId, order],
  );
  const filtered = query.trim().length > 0;
  const tabVisibleCount =
    tab === "projects"
      ? sections.projectGroups.reduce(
          (count, group) => count + group.ids.length,
          0,
        )
      : sections.globalIds.length;
  const nothingVisible = tabVisibleCount === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle pl-3 pr-1.5">
        <span className="text-sm font-medium text-fg-secondary">Sessions</span>
        <span className="flex items-center">
          <IconButton
            label="Reload sessions"
            size="sm"
            onClick={() => void refresh()}
          >
            <RefreshCw />
          </IconButton>
          <IconButton
            label="New session"
            size="sm"
            onClick={() => setNewOpen(true)}
          >
            <Plus />
          </IconButton>
        </span>
      </div>

      <div className="shrink-0 p-2">
        <Segmented
          ariaLabel="Session scope"
          value={tab}
          onValueChange={setTab}
          className="mb-2 grid w-full grid-cols-2 [&>button]:justify-center"
          options={[
            { value: "projects", label: "Projects" },
            { value: "tasks", label: "Tasks" },
          ]}
        />
        <Input
          fieldSize="md"
          value={query}
          placeholder="Filter sessions…"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter sessions"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {error && order.length > 0 ? (
          <div className="mb-1 flex items-center justify-between gap-2 rounded-md border border-danger/35 bg-danger/10 px-2 py-1 text-xs text-danger">
            <span className="truncate">{error}</span>
            <button
              type="button"
              className="shrink-0 underline"
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </div>
        ) : null}

        {loading && order.length === 0 ? (
          <div className="space-y-1 pt-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-11 animate-pulse-soft rounded-md bg-raised"
                style={{ opacity: 1 - i * 0.15 }}
              />
            ))}
          </div>
        ) : error && order.length === 0 ? (
          <EmptyState
            title="Couldn't load sessions"
            hint={error}
            action={
              <Button size="sm" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          />
        ) : nothingVisible ? (
          <EmptyState
            icon={Inbox}
            title={filtered ? "No matches" : "No sessions yet"}
            hint={
              filtered
                ? "No session matches the filter."
                : tab === "projects"
                  ? "Create or import a project to get started."
                  : "Create a global task to get started."
            }
            action={
              filtered ? (
                <Button size="sm" onClick={() => setQuery("")}>
                  Clear filter
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Plus />}
                  onClick={() => setNewOpen(true)}
                >
                  New session
                </Button>
              )
            }
          />
        ) : (
          <>
            {tab === "projects"
              ? sections.projectGroups.map((group) => {
                  const seed = group.ids
                    .map((id) => byId[id])
                    .find((s) => s !== undefined);
                  const groupCollapsed = collapsed.has(group.key);
                  const allVisible = showAll.has(group.key);
                  const visibleIds = allVisible
                    ? group.ids
                    : group.ids.slice(0, 5);
                  const FolderIcon = groupCollapsed ? Folder : FolderOpen;
                  const header = (
                    <div className="flex h-8 items-center pr-1">
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.key)}
                        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm text-fg-secondary hover:bg-raised/60 hover:text-fg"
                      >
                        <FolderIcon className="size-4 shrink-0 text-fg-muted" />
                        <span className="min-w-0 flex-1 truncate">
                          {group.label}
                        </span>
                        <span className="text-2xs tabular-nums text-fg-faint">
                          {group.ids.length}
                        </span>
                      </button>
                      <IconButton
                        label={`New session in ${group.label}`}
                        size="sm"
                        onClick={() => void createProjectSession(seed)}
                      >
                        <Plus />
                      </IconButton>
                    </div>
                  );
                  return (
                    <div key={group.key}>
                      {group.projectId ? (
                        <CountedContextMenu>
                          <ContextMenuTrigger>
                            <div>{header}</div>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem
                              onSelect={() => void createProjectSession(seed)}
                            >
                              <MessageSquarePlus />
                              New session
                            </ContextMenuItem>
                            <ContextMenuItem
                              onSelect={() =>
                                copyText(group.projectId ?? "", "Project id")
                              }
                            >
                              <Copy />
                              Copy project id
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              danger
                              onSelect={() =>
                                setDeleteTarget({
                                  projectId: group.projectId ?? "",
                                  label: group.label,
                                  ids: projectSessionIds(byId, order, group),
                                })
                              }
                            >
                              <Trash2 />
                              Delete project…
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </CountedContextMenu>
                      ) : (
                        header
                      )}
                      {groupCollapsed ? null : (
                        <div className="space-y-0.5 pl-5">
                          {visibleIds.map((id) => {
                            const s = byId[id];
                            return s ? (
                              <SessionRow
                                key={id}
                                session={s}
                                active={id === activeSessionId}
                              />
                            ) : null;
                          })}
                          {group.ids.length > 5 ? (
                            <button
                              type="button"
                              className="h-8 w-full rounded-md px-2 text-left text-xs text-fg-muted hover:bg-raised/60 hover:text-fg-secondary"
                              onClick={() =>
                                setShowAll((previous) => {
                                  const next = new Set(previous);
                                  if (next.has(group.key))
                                    next.delete(group.key);
                                  else next.add(group.key);
                                  return next;
                                })
                              }
                            >
                              {allVisible
                                ? "Show less"
                                : `Show ${group.ids.length - 5} more`}
                            </button>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })
              : null}

            {tab === "tasks" && sections.globalIds.length > 0 ? (
              <div className="space-y-0.5">
                {sections.globalIds.map((id) => {
                  const s = byId[id];
                  return s ? (
                    <SessionRow
                      key={id}
                      session={s}
                      active={id === activeSessionId}
                    />
                  ) : null;
                })}
                <button
                  type="button"
                  className="mt-1 flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-fg-muted hover:bg-raised/60 hover:text-fg-secondary"
                  onClick={() => void createGlobalSession()}
                >
                  <Plus className="size-4" />
                  New task
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {sections.archivedIds.length > 0 ? (
        <div className="shrink-0 border-t border-border-subtle bg-surface">
          {archivedOpen ? (
            <div className="max-h-48 space-y-0.5 overflow-y-auto px-1.5 py-1">
              {sections.archivedIds.map((id) => {
                const session = byId[id];
                return session ? (
                  <SessionRow
                    key={id}
                    session={session}
                    active={id === activeSessionId}
                  />
                ) : null;
              })}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setArchivedOpen((open) => !open)}
            className="flex h-8 w-full items-center gap-2 px-3 text-xs text-fg-muted hover:bg-raised/60 hover:text-fg-secondary"
          >
            <Archive className="size-3.5" />
            <span className="flex-1 text-left">Archived</span>
            <span className="tabular-nums text-fg-faint">
              {sections.archivedIds.length}
            </span>
            {archivedOpen ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        </div>
      ) : null}

      <NewSessionDialog
        open={newOpen}
        busy={busy}
        setBusy={setBusy}
        onOpenChange={(open) => {
          if (!busy) setNewOpen(open);
        }}
        groups={dialogGroups}
        byId={byId}
      />

      {deleteTarget ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!busy && !open) setDeleteTarget(null);
          }}
          size="sm"
        >
          <DeleteProjectBody
            target={deleteTarget}
            busy={busy}
            onDelete={() => void deleteProject()}
          />
        </Dialog>
      ) : null}
    </div>
  );
}

/** Every session of a project (incl. archived — the visible group excludes them). */
function projectSessionIds(
  byId: Readonly<Record<string, SessionSummary>>,
  order: readonly string[],
  group: ProjectGroup,
): string[] {
  return order.filter((id) => byId[id]?.projectId === group.projectId);
}

// ---- delete confirm (typed) -----------------------------------------------------

function DeleteProjectBody({
  target,
  busy,
  onDelete,
}: {
  target: { projectId: string; label: string; ids: string[] };
  busy: boolean;
  onDelete: () => void;
}) {
  const [typed, setTyped] = useState("");
  const confirmed = typed.trim() === target.label;
  return (
    <>
      <DialogTitle>Delete {target.label}?</DialogTitle>
      <DialogDescription>
        Permanently removes this project everywhere: all {target.ids.length}{" "}
        session{target.ids.length === 1 ? "" : "s"} and their history, the
        workspace files, and any snapshots. This cannot be undone.
      </DialogDescription>
      <label htmlFor="delete-project-confirmation" className="mt-4 block">
        <span className="mb-1 block text-xs font-medium text-fg-secondary">
          Type <span className="font-mono">{target.label}</span> to confirm
        </span>
        <Input
          id="delete-project-confirmation"
          value={typed}
          disabled={busy}
          autoFocus
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && confirmed && !busy) {
              e.preventDefault();
              onDelete();
            }
          }}
        />
      </label>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost" disabled={busy}>
            Cancel
          </Button>
        </DialogClose>
        <Button
          variant="danger-ghost"
          disabled={busy || !confirmed}
          icon={<Trash2 />}
          onClick={onDelete}
        >
          Delete project
        </Button>
      </DialogFooter>
    </>
  );
}

// ---- new-session flow -------------------------------------------------------------

const DEST_GLOBAL = "\0global";
const DEST_NEW_PROJECT = "\0new-project";

function NewSessionDialog({
  open,
  busy,
  setBusy,
  onOpenChange,
  groups,
  byId,
}: {
  open: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  onOpenChange: (open: boolean) => void;
  groups: ProjectGroup[];
  byId: Readonly<Record<string, SessionSummary>>;
}) {
  const [dest, setDest] = useState(DEST_GLOBAL);
  const [projectName, setProjectName] = useState("");
  const [firstPrompt, setFirstPrompt] = useState("");

  // fresh form every time the dialog opens; overlay counter per D-INV-3
  useEffect(() => {
    if (!open) return;
    setDest(DEST_GLOBAL);
    setProjectName("");
    setFirstPrompt("");
    useUi.getState().enterOverlay();
    return () => useUi.getState().exitOverlay();
  }, [open]);

  const projectGroups = groups.filter((g) => g.projectId !== null);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (dest === DEST_GLOBAL) {
        await openNewSession(createGlobalSessionInput(), firstPrompt);
      } else if (dest === DEST_NEW_PROJECT) {
        const name = projectName.trim();
        if (!name) {
          pushToast({ kind: "err", title: "Project name is required" });
          return;
        }
        const opened = await getBridge().createProject(name);
        pushToast({ kind: "ok", title: `Created ${opened.projectRoot}` });
        await openNewSession(
          {
            scope: "project",
            projectId: opened.projectId,
            projectRoot: opened.projectRoot,
            cwd: opened.cwd,
          },
          firstPrompt,
        );
      } else {
        const group = projectGroups.find((g) => g.key === dest);
        const seed = group?.ids.map((id) => byId[id]).find(Boolean);
        const input = seed && createProjectSessionInput(seed);
        if (!input) {
          pushToast({ kind: "err", title: "Project metadata is missing" });
          return;
        }
        await openNewSession(input, firstPrompt);
      }
      onOpenChange(false);
    } catch (err) {
      errToast("Failed to create session", err);
    } finally {
      setBusy(false);
    }
  };

  // ⌘O flow: native picker + copy-into-workspace. Electron main only — the
  // WS bridge rejects with DESKTOP_ONLY, which we surface as a friendly toast.
  const copyLocalFolder = async () => {
    if (busy) return;
    try {
      const opened = await getBridge().openProjectFolder();
      if (!opened) return; // picker cancelled
      setBusy(true);
      pushToast({
        kind: "ok",
        title: `Copied ${opened.fileCount} file${opened.fileCount === 1 ? "" : "s"} → ${opened.projectRoot}`,
      });
      await openNewSession(
        {
          scope: "project",
          projectId: opened.projectId,
          projectRoot: opened.projectRoot,
          cwd: opened.cwd,
        },
        firstPrompt,
      );
      onOpenChange(false);
    } catch (err) {
      if (isDesktopOnlyError(err)) {
        pushToast({
          kind: "warn",
          title: "Desktop app only",
          detail:
            "Copying a local folder needs the desktop app — this browser session talks directly to the daemon.",
        });
      } else {
        errToast("Failed to open folder", err);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm">
      <DialogTitle>New session</DialogTitle>
      <DialogDescription>
        Pick where the session lives; optionally start it with a prompt.
      </DialogDescription>
      <div className="mt-4 grid gap-3">
        <div className="block">
          <span className="mb-1 block text-xs font-medium text-fg-secondary">
            Project
          </span>
          <Select
            value={dest}
            onValueChange={setDest}
            disabled={busy}
            ariaLabel="Project"
            options={[
              { value: DEST_GLOBAL, label: "Global (no project)" },
              ...projectGroups.map((g) => ({ value: g.key, label: g.label })),
              { value: DEST_NEW_PROJECT, label: "New project…" },
            ]}
          />
        </div>
        {dest === DEST_NEW_PROJECT ? (
          <label htmlFor="new-session-project-name" className="block">
            <span className="mb-1 block text-xs font-medium text-fg-secondary">
              Project name
            </span>
            <Input
              id="new-session-project-name"
              value={projectName}
              disabled={busy}
              autoFocus
              placeholder="checkout-service"
              onChange={(e) => setProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void create();
                }
              }}
            />
          </label>
        ) : null}
        <label htmlFor="new-session-first-prompt" className="block">
          <span className="mb-1 block text-xs font-medium text-fg-secondary">
            First prompt <span className="text-fg-muted">(optional)</span>
          </span>
          <Textarea
            id="new-session-first-prompt"
            value={firstPrompt}
            disabled={busy}
            rows={3}
            placeholder="Handed to the composer once the session opens"
            onChange={(e) => setFirstPrompt(e.target.value)}
          />
        </label>
        <Button
          className="justify-start"
          variant="ghost"
          disabled={busy}
          icon={<FolderOpen />}
          onClick={() => void copyLocalFolder()}
        >
          Copy local folder into a new project…
        </Button>
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost" disabled={busy}>
            Cancel
          </Button>
        </DialogClose>
        <Button
          variant="primary"
          disabled={busy}
          icon={<Plus />}
          onClick={() => void create()}
        >
          Create session
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
