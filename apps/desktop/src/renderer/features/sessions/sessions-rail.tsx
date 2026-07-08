// Left rail — sessions (plan §7.2): project-grouped list from SessionSummary,
// explicit project/global sections, archive toggle, right-click context menu,
// and the session.* commands (new / next / prev).
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
  Eye,
  EyeOff,
  FolderOpen,
  Inbox,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import { useCommands } from "../../store/commands.ts";
import {
  ensureSubscribed,
  useSessions,
  useTranscripts,
  useUi,
} from "../../store/index.ts";
import {
  Badge,
  Button,
  cx,
  EmptyState,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Modal,
  ModalClose,
  ModalDescription,
  ModalFooter,
  ModalTitle,
  PanelShell,
  RelativeTime,
  StatusDot,
  TextInput,
  toast,
} from "../../ui/index.ts";

// ---- helpers -----------------------------------------------------------------

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === "string" ? msg : "Something went wrong";
}

/** Last two path segments — enough context for a dense rail. */
function pathTail(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/") || path;
}

function pathName(path: string | undefined): string | undefined {
  return path?.split("/").filter(Boolean).pop();
}

export function sessionGroupLabel(session: SessionSummary): string {
  return (
    pathName(session.hostCwdHint) ??
    pathName(session.projectRoot) ??
    session.projectId ??
    "Global"
  );
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
    sessions.setError(errMsg(err));
  }
}

function activate(sessionId: string): void {
  useSessions.getState().setActive(sessionId);
  ensureSubscribed(sessionId).catch((err) =>
    toast(errMsg(err), { tone: "err" }),
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
    toast(errMsg(err), { tone: "err" });
  }
}

// ---- grouping ------------------------------------------------------------------

type Group = { key: string; label: string; ids: string[] };
type SessionSections = { projectGroups: Group[]; globalIds: string[] };

export function createGlobalSessionInput(): Partial<CreateSessionRequest> {
  return { scope: "global", cwd: "." };
}

/** Newest-first order preserved within groups; control sessions never listed. */
export function splitSessionSections(
  byId: Readonly<Record<string, SessionSummary>>,
  order: readonly string[],
  showArchived: boolean,
): SessionSections {
  const groups: Group[] = [];
  const index = new Map<string, Group>();
  const globalIds: string[] = [];
  for (const id of order) {
    const s = byId[id];
    if (!s || s.scope === "control") continue;
    if (!showArchived && s.status === "archived") continue;
    if (s.scope === "global") {
      globalIds.push(id);
      continue;
    }
    const key = s.projectId ?? `project:${s.sessionId}`;
    let g = index.get(key);
    if (!g) {
      g = {
        key,
        label: sessionGroupLabel(s),
        ids: [],
      };
      index.set(key, g);
      groups.push(g);
    }
    g.ids.push(id);
  }
  return { projectGroups: groups, globalIds };
}

// ---- row ---------------------------------------------------------------------

function SessionRow({
  session,
  active,
  showCwd = true,
  onContextMenu,
}: {
  session: SessionSummary;
  active: boolean;
  showCwd?: boolean;
  onContextMenu: (x: number, y: number) => void;
}) {
  // Imported-origin badge only when the transcript (hence session.created) is
  // loaded; the summary doesn't carry origin, so we omit it otherwise.
  const origin = useTranscripts((s) => {
    const row = s.bySession[session.sessionId]?.rawEvents.find(
      (r) => r.type === "session.created",
    );
    const p = row?.payload;
    const o =
      typeof p === "object" && p !== null
        ? (p as { origin?: unknown }).origin
        : undefined;
    return o === "import.claude"
      ? "claude"
      : o === "import.codex"
        ? "codex"
        : null;
  });
  return (
    <button
      type="button"
      onClick={() => activate(session.sessionId)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      className={cx(
        "flex w-full flex-col gap-0.5 border-l-2 px-3 py-1.5 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent",
        active
          ? "border-l-accent bg-raised"
          : "border-l-transparent hover:bg-raised/60",
      )}
    >
      <span className="flex w-full items-center gap-1.5">
        <StatusDot status={session.status} />
        <span
          className={cx(
            "min-w-0 flex-1 truncate text-[13px]",
            session.title ? "text-ink" : "text-ink-mute",
          )}
        >
          {session.title || "untitled"}
        </span>
        <RelativeTime
          iso={session.updatedAt}
          className="shrink-0 text-[10px] text-ink-mute"
        />
      </span>
      {showCwd || origin ? (
        <span className="flex w-full items-center gap-1.5 pl-3">
          {showCwd ? (
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-mute">
              {pathTail(session.cwd)}
            </span>
          ) : null}
          {origin ? <Badge tone="info">{origin}</Badge> : null}
        </span>
      ) : null}
    </button>
  );
}

// ---- rail ----------------------------------------------------------------------

export function SessionsRail() {
  const byId = useSessions((s) => s.byId);
  const order = useSessions((s) => s.order);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const loading = useSessions((s) => s.loading);
  const error = useSessions((s) => s.error);

  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => new Set(),
  );
  const [menu, setMenu] = useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);

  const showArchivedRef = useRef(showArchived);
  showArchivedRef.current = showArchived;

  useEffect(() => {
    void refresh();
  }, []);

  const openProjectSession = useCallback(
    async (opened: {
      name: string;
      projectId: string;
      projectRoot: string;
      cwd: string;
      fileCount: number;
    }) => {
      const id = await getBridge().createSession({
        scope: "project",
        projectId: opened.projectId,
        projectRoot: opened.projectRoot,
        cwd: opened.cwd,
      });
      await ensureSubscribed(id, 0);
      await refresh();
      useSessions.getState().setActive(id);
      useUi.getState().requestComposerInsert("");
    },
    [],
  );

  const newEmptyRemoteProject = useCallback(async () => {
    if (busy) return;
    const name = projectName.trim();
    if (!name) {
      toast("Project name is required", { tone: "err" });
      return;
    }
    setBusy(true);
    try {
      const opened = await getBridge().createProject(name);
      await openProjectSession(opened);
      setProjectName("");
      setProjectModalOpen(false);
      toast(`Created ${opened.projectRoot}`, { tone: "ok" });
    } catch (err) {
      toast(errMsg(err), { tone: "err" });
    } finally {
      setBusy(false);
    }
  }, [busy, openProjectSession, projectName]);

  const openProject = useCallback(async () => {
    if (busy) return;
    try {
      // The bridge owns pick AND copy-into-workspace (shared/bridge.ts): the
      // paths below are workspace-relative, so this works against remote too.
      const opened = await getBridge().openProjectFolder();
      if (!opened) return;
      setBusy(true);
      setProjectModalOpen(false);
      await openProjectSession(opened);
      toast(
        `Copied ${opened.fileCount} file${opened.fileCount === 1 ? "" : "s"} → ${opened.projectRoot}`,
        { tone: "ok" },
      );
    } catch (err) {
      toast(errMsg(err), { tone: "err" });
    } finally {
      setBusy(false);
    }
  }, [busy, openProjectSession]);

  const createGlobalSession = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await getBridge().createSession(createGlobalSessionInput());
      await ensureSubscribed(id, 0);
      await refresh();
      useSessions.getState().setActive(id);
      useUi.getState().requestComposerInsert("");
    } catch (err) {
      toast(errMsg(err), { tone: "err" });
    } finally {
      setBusy(false);
    }
  }, [busy]);

  useEffect(() => {
    const cycle = (dir: 1 | -1) => {
      const s = useSessions.getState();
      const sections = splitSessionSections(
        s.byId,
        s.order,
        showArchivedRef.current,
      );
      const ids = [
        ...sections.projectGroups.flatMap((g) => g.ids),
        ...sections.globalIds,
      ];
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
    return useCommands.getState().register([
      {
        id: "session.new",
        title: "New global session",
        group: "Session",
        chord: "mod+n",
        run: () => void createGlobalSession(),
      },
      {
        id: "project.open",
        title: "New project…",
        group: "Session",
        chord: "mod+o",
        run: () => setProjectModalOpen(true),
      },
      {
        id: "session.next",
        title: "Next session",
        group: "Session",
        chord: "mod+alt+arrowdown",
        run: () => cycle(1),
      },
      {
        id: "session.prev",
        title: "Previous session",
        group: "Session",
        chord: "mod+alt+arrowup",
        run: () => cycle(-1),
      },
    ]);
  }, [createGlobalSession]);

  const sections = splitSessionSections(byId, order, showArchived);
  const visibleCount =
    sections.projectGroups.reduce((n, g) => n + g.ids.length, 0) +
    sections.globalIds.length;
  const menuSession = menu ? byId[menu.sessionId] : undefined;
  const menuArchived = menuSession?.status === "archived";

  return (
    <PanelShell>
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="text-xs font-semibold tracking-wide text-ink">
          Agena
        </span>
        <span className="flex items-center gap-1">
          <IconButton
            label="Reload sessions"
            size="sm"
            onClick={() => void refresh()}
          >
            <RefreshCw />
          </IconButton>
        </span>
      </div>

      <div className="min-h-0 flex-1">
        {error && order.length > 0 ? (
          <div className="flex items-center justify-between gap-2 border-b border-border bg-err/10 px-3 py-1 text-[11px] text-err">
            <span className="truncate">{error}</span>
            <button
              type="button"
              className="shrink-0 underline hover:text-ink"
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </div>
        ) : null}

        {loading && order.length === 0 ? (
          <div className="space-y-1.5 p-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-10 animate-pulse rounded bg-raised"
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
            className="h-full"
          />
        ) : visibleCount === 0 ? (
          order.length > 0 ? (
            <EmptyState
              icon={Inbox}
              title="No visible sessions"
              hint="All sessions are archived."
              action={
                <Button size="sm" onClick={() => setShowArchived(true)}>
                  Show archived
                </Button>
              }
              className="h-full"
            />
          ) : (
            <div className="flex h-full flex-col">
              <RailSection
                title="Projects"
                onCreate={() => setProjectModalOpen(true)}
              />
              <RailSection
                title="Global"
                className="border-t border-border"
                onCreate={() => void createGlobalSession()}
              />
            </div>
          )
        ) : (
          <div className="flex h-full flex-col">
            <RailSection
              title="Projects"
              onCreate={() => setProjectModalOpen(true)}
            >
              {sections.projectGroups.map((group) => (
                <div key={group.key}>
                  <ProjectGroupHeader
                    label={group.label}
                    count={group.ids.length}
                    collapsed={collapsedProjects.has(group.key)}
                    onToggle={() =>
                      setCollapsedProjects((prev) => {
                        const next = new Set(prev);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      })
                    }
                  />
                  {collapsedProjects.has(group.key)
                    ? null
                    : group.ids.map((id) => {
                        const s = byId[id];
                        return s ? (
                          <SessionRow
                            key={id}
                            session={s}
                            active={id === activeSessionId}
                            onContextMenu={(x, y) =>
                              setMenu({ sessionId: id, x, y })
                            }
                          />
                        ) : null;
                      })}
                </div>
              ))}
            </RailSection>
            <RailSection
              title="Global"
              className="border-t border-border"
              onCreate={() => void createGlobalSession()}
            >
              {sections.globalIds.map((id) => {
                const s = byId[id];
                return s ? (
                  <SessionRow
                    key={id}
                    session={s}
                    active={id === activeSessionId}
                    showCwd={false}
                    onContextMenu={(x, y) => setMenu({ sessionId: id, x, y })}
                  />
                ) : null;
              })}
            </RailSection>
          </div>
        )}
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between border-t border-border px-3">
        <span className="text-[10px] text-ink-mute">
          {visibleCount} session{visibleCount === 1 ? "" : "s"}
        </span>
        <IconButton
          label={showArchived ? "Hide archived" : "Show archived"}
          size="sm"
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? <Eye /> : <EyeOff />}
        </IconButton>
      </div>

      {menu ? (
        <Menu
          open
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
        >
          <MenuTrigger>
            <span
              className="fixed size-px"
              style={{ left: menu.x, top: menu.y }}
            />
          </MenuTrigger>
          <MenuContent>
            <MenuItem
              onSelect={() =>
                void setSessionStatus(
                  menu.sessionId,
                  menuArchived ? "idle" : "archived",
                )
              }
            >
              {menuArchived ? <ArchiveRestore /> : <Archive />}
              {menuArchived ? "Unarchive" : "Archive"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onSelect={() => {
                void navigator.clipboard.writeText(menu.sessionId);
                toast("Session id copied");
              }}
            >
              <Copy />
              Copy session id
            </MenuItem>
          </MenuContent>
        </Menu>
      ) : null}

      <Modal
        open={projectModalOpen}
        onOpenChange={(open) => {
          if (!busy) setProjectModalOpen(open);
        }}
        size="sm"
      >
        <ModalTitle>New project</ModalTitle>
        <ModalDescription>
          Start empty in the remote workspace, or copy a local folder into it.
        </ModalDescription>
        <div className="mt-4 grid gap-2">
          <TextInput
            value={projectName}
            disabled={busy}
            placeholder="Project name"
            onChange={(e) => setProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void newEmptyRemoteProject();
              }
            }}
          />
          <Button
            className="justify-start"
            disabled={busy}
            icon={<Plus />}
            onClick={() => void newEmptyRemoteProject()}
          >
            New empty remote project
          </Button>
          <Button
            className="justify-start"
            disabled={busy}
            icon={<FolderOpen />}
            onClick={() => void openProject()}
          >
            Copy local folder
          </Button>
        </div>
        <ModalFooter>
          <ModalClose asChild>
            <Button disabled={busy} variant="ghost">
              Cancel
            </Button>
          </ModalClose>
        </ModalFooter>
      </Modal>
    </PanelShell>
  );
}

function ProjectGroupHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const Icon = collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="sticky top-0 z-10 flex h-7 w-full items-center gap-1.5 bg-surface px-3 text-left text-[10px] font-medium uppercase tracking-wider text-ink-mute hover:bg-raised/60"
    >
      <Icon className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 tabular-nums">{count}</span>
    </button>
  );
}

function RailSection({
  title,
  className,
  onCreate,
  children,
}: {
  title: string;
  className?: string;
  onCreate: () => void;
  children?: ReactNode;
}) {
  return (
    <section className={cx("min-h-0 flex-1 overflow-y-auto", className)}>
      <div className="sticky top-0 z-20 flex h-8 items-center justify-between bg-surface px-3 text-[10px] font-semibold uppercase tracking-wider text-ink-mute">
        <span>{title}</span>
        <IconButton
          label={`New ${title.toLowerCase()}`}
          size="sm"
          onClick={onCreate}
        >
          <Plus />
        </IconButton>
      </div>
      {children}
    </section>
  );
}
