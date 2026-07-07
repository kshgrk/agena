// Left rail — sessions (plan §7.2): project-grouped list from SessionSummary,
// inline new-session composer, archive toggle, right-click context menu, and
// the session.* commands (new / next / prev).
import type {
  CreateSessionRequest,
  SessionStatus,
  SessionSummary,
} from "@agena/protocol";
import {
  Archive,
  ArchiveRestore,
  Copy,
  Eye,
  EyeOff,
  FolderOpen,
  Inbox,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import { chordLabel, useCommands } from "../../store/commands.ts";
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

export function createSessionInputForActive(
  title: string,
  active: SessionSummary | undefined,
): Partial<CreateSessionRequest> {
  const input: Partial<CreateSessionRequest> = title ? { title } : {};
  if (active?.scope !== "project" || !active.projectId || !active.projectRoot) {
    return input;
  }
  return {
    ...input,
    scope: "project",
    projectId: active.projectId,
    projectRoot: active.projectRoot,
    cwd: active.cwd,
    ...(active.hostCwdHint ? { hostCwdHint: active.hostCwdHint } : {}),
  };
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

/** Newest-first order preserved within groups; control sessions never listed;
 * global scope collapses into one trailing "Global" group. */
function groupSessions(
  byId: Readonly<Record<string, SessionSummary>>,
  order: readonly string[],
  showArchived: boolean,
): Group[] {
  const groups: Group[] = [];
  const index = new Map<string, Group>();
  for (const id of order) {
    const s = byId[id];
    if (!s || s.scope === "control") continue;
    if (!showArchived && s.status === "archived") continue;
    const key = s.scope === "global" || !s.projectId ? "global" : s.projectId;
    let g = index.get(key);
    if (!g) {
      g = {
        key,
        label: key === "global" ? "Global" : sessionGroupLabel(s),
        ids: [],
      };
      index.set(key, g);
      groups.push(g);
    }
    g.ids.push(id);
  }
  // stable sort: Global group sinks to the bottom
  groups.sort(
    (a, b) => Number(a.key === "global") - Number(b.key === "global"),
  );
  return groups;
}

// ---- row ---------------------------------------------------------------------

function SessionRow({
  session,
  active,
  onContextMenu,
}: {
  session: SessionSummary;
  active: boolean;
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
      <span className="flex w-full items-center gap-1.5 pl-3">
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-mute">
          {pathTail(session.cwd)}
        </span>
        {origin ? <Badge tone="info">{origin}</Badge> : null}
      </span>
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
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
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

  const openProject = useCallback(async () => {
    if (busy) return;
    try {
      // The bridge owns pick AND copy-into-workspace (shared/bridge.ts): the
      // paths below are workspace-relative, so this works against remote too.
      const opened = await getBridge().openProjectFolder();
      if (!opened) return;
      setBusy(true);
      const id = await getBridge().createSession({
        title: opened.name,
        scope: "project",
        projectId: opened.projectId,
        projectRoot: opened.projectRoot,
        cwd: opened.cwd,
      });
      await ensureSubscribed(id, 0);
      await refresh();
      useSessions.getState().setActive(id);
      toast(
        `Copied ${opened.fileCount} file${opened.fileCount === 1 ? "" : "s"} → ${opened.projectRoot}`,
        { tone: "ok" },
      );
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
      const ids = groupSessions(
        s.byId,
        s.order,
        showArchivedRef.current,
      ).flatMap((g) => g.ids);
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
        title: "New session",
        group: "Session",
        chord: "mod+n",
        run: () => setCreating(true),
      },
      {
        id: "project.open",
        title: "Open project folder…",
        group: "Session",
        chord: "mod+o",
        run: () => void openProject(),
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
  }, [openProject]);

  const submitCreate = async () => {
    if (busy) return;
    setBusy(true);
    const t = title.trim();
    try {
      const active = activeSessionId ? byId[activeSessionId] : undefined;
      const id = await getBridge().createSession(
        createSessionInputForActive(t, active),
      );
      await ensureSubscribed(id, 0);
      await refresh();
      useSessions.getState().setActive(id);
      setCreating(false);
      setTitle("");
      // ponytail: no dedicated focus channel; an empty composer-insert request
      // is the cross-pane "focus the composer" signal.
      useUi.getState().requestComposerInsert("");
    } catch (err) {
      toast(errMsg(err), { tone: "err" });
    } finally {
      setBusy(false);
    }
  };

  const groups = groupSessions(byId, order, showArchived);
  const visibleCount = groups.reduce((n, g) => n + g.ids.length, 0);
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
            label={`New session · ${chordLabel("mod+n")}`}
            size="sm"
            onClick={() => setCreating(true)}
          >
            <Plus />
          </IconButton>
          <IconButton
            label={`Open project folder · ${chordLabel("mod+o")}`}
            size="sm"
            onClick={() => void openProject()}
          >
            <FolderOpen />
          </IconButton>
          <IconButton
            label="Reload sessions"
            size="sm"
            onClick={() => void refresh()}
          >
            <RefreshCw />
          </IconButton>
        </span>
      </div>

      {creating ? (
        <form
          className="shrink-0 border-b border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submitCreate();
          }}
        >
          <TextInput
            autoFocus
            value={title}
            disabled={busy}
            placeholder="Session title — Enter to create, Esc to cancel"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setCreating(false);
                setTitle("");
              }
            }}
          />
        </form>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
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
            <EmptyState
              icon={Inbox}
              title="No sessions yet"
              action={
                <Button
                  variant="solid"
                  size="sm"
                  onClick={() => setCreating(true)}
                >
                  Create your first session
                </Button>
              }
              className="h-full"
            />
          )
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              <div className="sticky top-0 z-10 bg-surface px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-ink-mute">
                {group.label}
              </div>
              {group.ids.map((id) => {
                const s = byId[id];
                return s ? (
                  <SessionRow
                    key={id}
                    session={s}
                    active={id === activeSessionId}
                    onContextMenu={(x, y) => setMenu({ sessionId: id, x, y })}
                  />
                ) : null;
              })}
            </div>
          ))
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
    </PanelShell>
  );
}
