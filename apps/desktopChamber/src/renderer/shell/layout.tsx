// The dockview workbench: center transcript+composer, right dock tabs
// (inspector/files/timeline/snapshots/diff/search), bottom terminal dock.
// dockview v7 ships no React adapter, so panels render through portals into
// renderer-owned elements — one React tree, so providers and zustand stores
// behave normally. Ported and adapted from apps/desktop app.tsx. Visual shell
// geometry adapted from openchamber commit 8702c6d5cefa (MIT), Copyright (c)
// 2025 Bohdan Triapitsyn. See THIRD_PARTY_NOTICES.md.
import "dockview/dist/styles/dockview.css";
import "./dockview.css";
import {
  createDockview,
  type DockviewApi,
  type IContentRenderer,
  type IHeaderActionsRenderer,
  themeAbyss,
} from "dockview";
import { MessageSquare } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChildSessionBanner } from "../features/agents/task-group.tsx";
import {
  pane as browserPane,
  initBrowserStore,
} from "../features/browser/index.ts";
import {
  OPEN_SESSION_CHANGES_EVENT,
  SessionChangesPill,
  SessionChangesWorkspace,
} from "../features/changes/index.tsx";
import { Composer } from "../features/composer/composer.tsx";
import { pane as diffPane } from "../features/diff/index.ts";
import { pane as filesPane } from "../features/files/index.ts";
import { pane as inspectorPane } from "../features/inspector/index.ts";
import { pane as searchPane } from "../features/search/index.ts";
import {
  sideChatsForRoot,
  sideChatTitle,
} from "../features/sessions/side-chats.ts";
import { pane as snapshotsPane } from "../features/snapshots/index.ts";
import { pane as terminalPane } from "../features/terminal/index.ts";
import { pane as timelinePane } from "../features/timeline/index.ts";
import { getBridge } from "../lib/bridge.ts";
import { AgenaChamberChat } from "../openchamber/adapters/agena-chat.tsx";
import { DOCK_RELAYOUT_EVENT } from "../openchamber/chat/use-chat-auto-follow.ts";
import {
  ensureSubscribed,
  pushToast,
  registerCommands,
  savePersistedPatch,
  shortcutLabel,
  useConnection,
  useSessions,
  useUi,
} from "../store/index.ts";
import { EmptyState } from "../ui/index.ts";
import {
  buildSavedLayout,
  OPEN_SEARCH_EVENT,
  type PaneDefinition,
  type SavedLayout,
  useShellUi,
} from "./panes.ts";

// ---- center panel: the session workspace ------------------------------------

const SESSION_PANEL_PREFIX = "session:";
const QUICK_CHAT_PANEL_PREFIX = "quick-chat:";
const CHANGES_PANEL_PREFIX = "changes:";
const EMPTY_SESSION_PANEL = "session.empty";

function sessionPanelId(sessionId: string): string {
  return `${SESSION_PANEL_PREFIX}${sessionId}`;
}

function panelSessionId(panelId: string): string | null {
  return panelId.startsWith(SESSION_PANEL_PREFIX)
    ? panelId.slice(SESSION_PANEL_PREFIX.length)
    : null;
}

function quickChatPanelParts(
  panelId: string,
): { rootSessionId: string; sessionId: string } | null {
  if (!panelId.startsWith(QUICK_CHAT_PANEL_PREFIX)) return null;
  const [, rootSessionId, sessionId] = panelId.split(":");
  return rootSessionId && sessionId ? { rootSessionId, sessionId } : null;
}

function quickChatSessionId(panelId: string): string | null {
  return quickChatPanelParts(panelId)?.sessionId ?? null;
}

function changesSessionId(panelId: string): string | null {
  return panelId.startsWith(CHANGES_PANEL_PREFIX)
    ? panelId.slice(CHANGES_PANEL_PREFIX.length)
    : null;
}

function sessionTabTitle(sessionId: string): string {
  const session = useSessions.getState().byId[sessionId];
  const workspace =
    session?.cwd.split("/").filter(Boolean).pop() ?? "workspace";
  return `${workspace} / ${session?.title || "Untitled session"}${session ? ` · ${session.status}` : ""}`;
}

function workbenchPrefix(group: {
  readonly panels: readonly { id: string }[];
}): IHeaderActionsRenderer {
  const element = document.createElement("div");
  element.className = "chamber-workbench-prefix";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "chamber-sidebar-toggle";
  toggle.textContent = "☰";
  toggle.setAttribute("aria-label", "Show sessions sidebar");
  toggle.title = "Show sessions sidebar";

  const brand = document.createElement("span");
  brand.className = "chamber-workbench-brand";
  brand.textContent = "Agena Conductor";
  element.append(toggle, brand);

  let dispose = () => {};
  return {
    element,
    init({ containerApi }) {
      const refresh = () => {
        element.hidden = !group.panels.some(
          (panel) =>
            panelSessionId(panel.id) !== null ||
            panel.id === EMPTY_SESSION_PANEL,
        );
        toggle.hidden = !useShellUi.getState().sidebarCollapsed;
      };
      const showSidebar = () =>
        useShellUi.getState().setSidebarCollapsed(false);
      toggle.addEventListener("click", showSidebar);
      const unsubscribeShell = useShellUi.subscribe(refresh);
      const layoutSubscription = containerApi.onDidLayoutChange(refresh);
      refresh();
      dispose = () => {
        toggle.removeEventListener("click", showSidebar);
        unsubscribeShell();
        layoutSubscription.dispose();
      };
    },
    dispose: () => dispose(),
  };
}

function quickChatActions(
  group: { readonly activePanel: { id: string } | undefined },
  onCreate: (rootSessionId: string, sourceSessionId: string) => void,
): IHeaderActionsRenderer {
  const element = document.createElement("div");
  element.className = "chamber-quick-chat-actions";
  const select = document.createElement("select");
  select.className = "chamber-quick-chat-add";
  select.setAttribute("aria-label", "Create side chat");
  select.title = "Create side chat";
  element.append(select);

  let dispose = () => {};
  return {
    element,
    init({ containerApi }) {
      const refresh = () => {
        const parts = group.activePanel
          ? quickChatPanelParts(group.activePanel.id)
          : null;
        element.hidden = !parts;
        if (!parts) return;
        const byId = useSessions.getState().byId;
        select.replaceChildren(
          new Option("+", ""),
          new Option("From main chat", parts.rootSessionId),
          new Option(
            `From ${sideChatTitle(byId, parts.sessionId)}`,
            parts.sessionId,
          ),
        );
      };
      const create = () => {
        const parts = group.activePanel
          ? quickChatPanelParts(group.activePanel.id)
          : null;
        const sourceSessionId = select.value;
        select.value = "";
        if (!parts || !sourceSessionId) return;
        onCreate(parts.rootSessionId, sourceSessionId);
      };
      const stopDrag = (event: PointerEvent) => event.stopPropagation();
      select.addEventListener("change", create);
      select.addEventListener("pointerdown", stopDrag);
      const unsubscribeSessions = useSessions.subscribe(refresh);
      const activeSubscription = containerApi.onDidActivePanelChange(refresh);
      const layoutSubscription = containerApi.onDidLayoutChange(refresh);
      refresh();
      dispose = () => {
        select.removeEventListener("change", create);
        select.removeEventListener("pointerdown", stopDrag);
        unsubscribeSessions();
        activeSubscription.dispose();
        layoutSubscription.dispose();
      };
    },
    dispose: () => dispose(),
  };
}

function SessionWorkspace({ sessionId }: { sessionId: string }) {
  const connState = useConnection((s) => s.state);
  // The displayed session is always subscribed — heals every race
  // (activation while connecting, reconnects, bootstrap ordering).
  useEffect(() => {
    if (connState !== "connected") return;
    ensureSubscribed(sessionId).catch((err: unknown) => {
      pushToast({
        kind: "err",
        title: "Failed to subscribe to session",
        detail: err instanceof Error ? err.message : "subscribe failed",
      });
    });
  }, [sessionId, connState]);
  return (
    <div
      className="chamber-session-workspace grid h-full min-h-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto] bg-canvas lg:grid-cols-[28px_minmax(0,1fr)]"
      data-chamber-session-workspace={sessionId}
    >
      <div className="col-start-1 row-start-1 lg:col-span-2">
        <ChildSessionBanner sessionId={sessionId} />
      </div>
      <div className="relative col-start-1 row-start-2 min-h-0 min-w-0 lg:col-start-2">
        <AgenaChamberChat sessionId={sessionId} />
        <SessionChangesPill sessionId={sessionId} />
      </div>
      <div className="col-start-1 row-start-3 min-w-0 lg:col-start-2">
        <Composer sessionId={sessionId} />
      </div>
    </div>
  );
}

function EmptySessionWorkspace() {
  return (
    <EmptyState
      icon={MessageSquare}
      title="Pick or create a session"
      hint={`${shortcutLabel("mod+n")} starts a new one.`}
    />
  );
}

// ---- pane registry ----------------------------------------------------------------

/** Right-dock tab panes, in default tab order (ARCHITECTURE §Layout + search). */
const RIGHT_PANES: readonly PaneDefinition[] = [
  inspectorPane,
  filesPane,
  timelinePane,
  snapshotsPane,
  diffPane,
  searchPane,
  browserPane,
];
const RIGHT_IDS: readonly string[] = RIGHT_PANES.map((p) => p.id);

function panelNode(id: string): ReactNode {
  const changesId = changesSessionId(id);
  if (changesId) return <SessionChangesWorkspace sessionId={changesId} />;
  const quickChatId = quickChatSessionId(id);
  if (quickChatId) return <SessionWorkspace sessionId={quickChatId} />;
  const sessionId = panelSessionId(id);
  if (sessionId) return <SessionWorkspace sessionId={sessionId} />;
  if (id === EMPTY_SESSION_PANEL) return <EmptySessionWorkspace />;
  if (id === "terminal") return <terminalPane.Component />;
  const right = RIGHT_PANES.find((p) => p.id === id);
  if (right) return <right.Component />;
  // stale layouts may reference panels this build no longer ships (D-INV-6 spirit)
  return <EmptyState title={`Unknown panel “${id}”`} />;
}

// ---- layout helpers -----------------------------------------------------------------

function ensureCenter(api: DockviewApi): void {
  const hasSession = api.panels.some((panel) => panelSessionId(panel.id));
  if (!hasSession && !api.getPanel(EMPTY_SESSION_PANEL)) {
    api.addPanel({
      id: EMPTY_SESSION_PANEL,
      component: EMPTY_SESSION_PANEL,
      title: "Sessions",
    });
  }
}

function centerPanelId(api: DockviewApi): string {
  return (
    api.panels.find((panel) => panelSessionId(panel.id))?.id ??
    EMPTY_SESSION_PANEL
  );
}

function openSessionPanel(api: DockviewApi, sessionId: string): void {
  const id = sessionPanelId(sessionId);
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  ensureCenter(api);
  const added = api.addPanel({
    id,
    component: id,
    title: sessionTabTitle(sessionId),
    position: { referencePanel: centerPanelId(api), direction: "within" },
  });
  const empty = api.getPanel(EMPTY_SESSION_PANEL);
  if (empty) api.removePanel(empty);
  added.api.setActive();
}

function openQuickChatPanel(
  api: DockviewApi,
  rootSessionId: string,
  childSessionId: string,
): void {
  const id = `${QUICK_CHAT_PANEL_PREFIX}${rootSessionId}:${childSessionId}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    focusQuickChatComposer(childSessionId);
    return;
  }
  const sibling = api.panels.find(
    (panel) => quickChatPanelParts(panel.id)?.rootSessionId === rootSessionId,
  );
  const byId = useSessions.getState().byId;
  const added = api.addPanel({
    id,
    component: id,
    title: sideChatTitle(byId, childSessionId),
    ...(sibling
      ? {
          position: { referencePanel: sibling.id, direction: "within" },
        }
      : {
          position: {
            referencePanel: api.getPanel(sessionPanelId(rootSessionId))
              ? sessionPanelId(rootSessionId)
              : centerPanelId(api),
            direction: "right",
          },
          initialWidth: 420,
        }),
  });
  added.api.setActive();
  focusQuickChatComposer(childSessionId);
}

function openChangesPanel(api: DockviewApi, sessionId: string): void {
  const id = `${CHANGES_PANEL_PREFIX}${sessionId}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const added = api.addPanel({
    id,
    component: id,
    title: "Session Changes",
    position: {
      referencePanel: api.getPanel(sessionPanelId(sessionId))
        ? sessionPanelId(sessionId)
        : centerPanelId(api),
      direction: "within",
    },
  });
  added.api.setActive();
}

function focusQuickChatComposer(sessionId: string): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `[data-chamber-session-workspace="${CSS.escape(sessionId)}"] .cm-content`,
        )
        ?.focus();
    }),
  );
}

/** Add a right-dock pane: joins the existing right group, or opens one. */
function addRightPane(api: DockviewApi, id: string): void {
  ensureCenter(api);
  const def = RIGHT_PANES.find((p) => p.id === id);
  if (!def || api.getPanel(id)) return;
  let ref: string | null = null;
  for (const rid of RIGHT_IDS) {
    if (rid !== id && api.getPanel(rid)) {
      ref = rid;
      break;
    }
  }
  const added = api.addPanel({
    id,
    component: id,
    title: def.title,
    inactive: true,
    ...(ref
      ? { position: { referencePanel: ref, direction: "within" } }
      : {
          position: { referencePanel: centerPanelId(api), direction: "right" },
          initialWidth: id === "browser" ? 640 : id === "inspector" ? 340 : 380,
        }),
  });
  added.api.setActive();
}

/** Tab-toggle semantics: absent → open+focus; visible+active → close; else focus. */
function toggleRightPane(api: DockviewApi, id: string): void {
  const panel = api.getPanel(id);
  if (!panel) {
    addRightPane(api, id);
  } else if (panel.api.isActive) {
    api.removePanel(panel);
  } else {
    panel.api.setActive();
  }
}

/** inspectorOpen (store/ui) ↔ inspector panel presence. */
function applyInspector(api: DockviewApi, open: boolean): void {
  const panel = api.getPanel("inspector");
  if (open && !panel) addRightPane(api, "inspector");
  else if (!open && panel) api.removePanel(panel);
}

/** The bottom dock = the group holding the terminal panel. */
function ensureTerminal(api: DockviewApi): void {
  ensureCenter(api);
  if (api.getPanel("terminal")) return;
  const added = api.addPanel({
    id: "terminal",
    component: "terminal",
    title: terminalPane.title,
    inactive: true,
    position: { referencePanel: centerPanelId(api), direction: "below" },
    initialHeight: 280,
  });
  // a freshly-built group has no active panel yet (added inactive)
  if (!added.group.activePanel) added.api.setActive();
}

function applyTerminal(api: DockviewApi, open: boolean): void {
  if (open) ensureTerminal(api);
  // ponytail: "the dock" is the group holding the terminal panel; panels the
  // user dragged elsewhere are their own problem.
  api.getPanel("terminal")?.group.api.setVisible(open);
}

/** Transcript-first default: the session IS the app; docks open on demand. */
function buildDefaultLayout(api: DockviewApi): void {
  api.addPanel({
    id: EMPTY_SESSION_PANEL,
    component: EMPTY_SESSION_PANEL,
    title: "Sessions",
  });
  api.getPanel(EMPTY_SESSION_PANEL)?.api.setActive();
}

// ---- the dockview host component -----------------------------------------------------

export function DockLayout({ saved }: { saved: SavedLayout | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [portals, setPortals] = useState<ReadonlyMap<string, HTMLElement>>(
    new Map(),
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;

    initBrowserStore();

    let createQuickChatFromHeader:
      | ((rootSessionId: string, sourceSessionId: string) => void)
      | undefined;
    const api = createDockview(el, {
      theme: {
        ...themeAbyss,
        name: "agena",
        className: `${themeAbyss.className} dv-theme-agena`,
      },
      createComponent: ({ id }): IContentRenderer => {
        const element = document.createElement("div");
        element.className = "dv-agena-panel";
        return {
          element,
          init: () => setPortals((m) => new Map(m).set(id, element)),
          dispose: () =>
            setPortals((m) => {
              if (m.get(id) !== element) return m;
              const next = new Map(m);
              next.delete(id);
              return next;
            }),
        };
      },
      createPrefixHeaderActionComponent: (group) => workbenchPrefix(group),
      createRightHeaderActionComponent: (group) =>
        quickChatActions(group, (rootSessionId, sourceSessionId) =>
          createQuickChatFromHeader?.(rootSessionId, sourceSessionId),
        ),
    });

    // restore the persisted layout; anything bad → default rebuild
    let restored = false;
    if (saved?.dock) {
      try {
        api.fromJSON(saved.dock);
        restored = true;
      } catch {
        try {
          api.clear();
        } catch {
          // a half-restored layout may fail to clear; the default rebuild wins
        }
      }
    }
    if (!restored) buildDefaultLayout(api);
    ensureCenter(api);
    // groups restored (or built) without an active panel never attach content
    for (const group of api.groups) {
      if (!group.activePanel) group.panels[0]?.api.setActive();
    }

    // one-time store sync FROM the layout (both-ways contract, dockview side)
    useUi.getState().setInspectorOpen(api.getPanel("inspector") !== undefined);
    useUi.getState().setBrowserOpen(api.getPanel("browser") !== undefined);
    useUi
      .getState()
      .setTerminalOpen(api.getPanel("terminal")?.group.api.isVisible ?? false);

    // dockview → store (tab close buttons, drag-out removals)
    const removeSub = api.onDidRemovePanel((panel) => {
      if (disposed) return;
      if (panelSessionId(panel.id) || panel.id === EMPTY_SESSION_PANEL) {
        queueMicrotask(() => {
          if (disposed) return;
          ensureCenter(api);
          const removedSessionId = panelSessionId(panel.id);
          if (
            removedSessionId &&
            useSessions.getState().activeSessionId !== removedSessionId
          ) {
            return;
          }
          const next = api.panels.find((candidate) =>
            panelSessionId(candidate.id),
          );
          const nextSessionId = next ? panelSessionId(next.id) : null;
          useSessions.getState().setActive(nextSessionId);
        });
      } else if (panel.id === "inspector") {
        useUi.getState().setInspectorOpen(false);
      } else if (panel.id === "browser") {
        useUi.getState().setBrowserOpen(false);
      } else if (panel.id === "terminal") {
        useUi.getState().setTerminalOpen(false);
      }
    });
    const addSub = api.onDidAddPanel((panel) => {
      if (disposed) return;
      if (panel.id === "inspector") useUi.getState().setInspectorOpen(true);
      else if (panel.id === "browser") useUi.getState().setBrowserOpen(true);
      else if (panel.id === "terminal") useUi.getState().setTerminalOpen(true);
    });
    const activeSub = api.onDidActivePanelChange((event) => {
      const sessionId = event.panel ? panelSessionId(event.panel.id) : null;
      if (sessionId && useSessions.getState().activeSessionId !== sessionId) {
        useSessions.getState().setActive(sessionId);
      }
    });

    const unsubSessions = useSessions.subscribe((state, previous) => {
      if (
        state.activeSessionId &&
        state.activeSessionId !== previous.activeSessionId
      ) {
        openSessionPanel(api, state.activeSessionId);
      }
      for (const panel of api.panels) {
        const sessionId = panelSessionId(panel.id);
        const quickChatId = quickChatSessionId(panel.id);
        if (!sessionId && !quickChatId) continue;
        const title = sessionId
          ? sessionTabTitle(sessionId)
          : sideChatTitle(useSessions.getState().byId, quickChatId as string);
        if (panel.title !== title) panel.api.setTitle(title);
      }
    });
    const initialSessionId = useSessions.getState().activeSessionId;
    if (initialSessionId) openSessionPanel(api, initialSessionId);

    // store → dockview
    const unsubUi = useUi.subscribe((s, prev) => {
      if (s.inspectorOpen !== prev.inspectorOpen) {
        applyInspector(api, s.inspectorOpen);
      }
      if (s.browserOpen !== prev.browserOpen) {
        const panel = api.getPanel("browser");
        if (s.browserOpen && !panel) addRightPane(api, "browser");
        else if (!s.browserOpen && panel) api.removePanel(panel);
      }
      if (s.terminalOpen !== prev.terminalOpen) {
        applyTerminal(api, s.terminalOpen);
      }
    });

    // dockview-dependent commands (shortcut binding is in shell/shortcuts.tsx)
    const revealSearch = () => {
      const panel = api.getPanel("search");
      if (panel) panel.api.setActive();
      else addRightPane(api, "search");
      // re-fire on the next frame so the (now-visible) pane can focus its input
      requestAnimationFrame(() =>
        window.dispatchEvent(new Event(OPEN_SEARCH_EVENT)),
      );
    };
    const creatingQuickChats = new Set<string>();
    const createQuickChat = async (
      rootSessionId: string,
      sourceSessionId: string,
    ) => {
      if (creatingQuickChats.has(sourceSessionId)) return;
      creatingQuickChats.add(sourceSessionId);
      try {
        const bridge = getBridge();
        const child = await bridge.createQuickChat(sourceSessionId);
        await ensureSubscribed(child.sessionId, 0);
        useSessions.getState().setAll(
          await bridge.listSessionSummaries({
            allProjects: true,
            includeArchived: true,
          }),
        );
        openQuickChatPanel(api, rootSessionId, child.sessionId);
      } catch (error) {
        pushToast({
          kind: "err",
          title: "Could not create side chat",
          detail: error instanceof Error ? error.message : "Side chat failed",
        });
      } finally {
        creatingQuickChats.delete(sourceSessionId);
      }
    };
    const revealQuickChat = async () => {
      const rootSessionId = useSessions.getState().activeSessionId;
      if (!rootSessionId) return;
      const chats = sideChatsForRoot(
        useSessions.getState().byId,
        rootSessionId,
      );
      if (chats.length > 0) {
        for (const chat of chats) {
          openQuickChatPanel(api, rootSessionId, chat.sessionId);
        }
        return;
      }
      await createQuickChat(rootSessionId, rootSessionId);
    };
    createQuickChatFromHeader = (rootSessionId, sourceSessionId) => {
      void createQuickChat(rootSessionId, sourceSessionId);
    };
    const onOpenChanges = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail
        ?.sessionId;
      if (sessionId) openChangesPanel(api, sessionId);
    };
    window.addEventListener(OPEN_SESSION_CHANGES_EVENT, onOpenChanges);
    const unregister = registerCommands([
      ...[filesPane, timelinePane, snapshotsPane, diffPane].map((p) => ({
        id: `view.${p.id}`,
        title: `Toggle ${p.title}`,
        group: "View",
        ...(p.id === "files" ? { shortcut: "mod+shift+e" } : {}),
        ...(p.id === "diff" ? { shortcut: "mod+shift+d" } : {}),
        run: () => toggleRightPane(api, p.id),
      })),
      {
        id: "session.quickChat",
        title: "Open Quick Chat",
        group: "Session",
        shortcut: "mod+shift+s",
        when: () => {
          const sessions = useSessions.getState();
          const active = sessions.activeSessionId
            ? sessions.byId[sessions.activeSessionId]
            : undefined;
          return Boolean(active && active.purpose !== "quick_chat");
        },
        run: revealQuickChat,
      },
      {
        id: "session.changes",
        title: "Review Session Changes",
        group: "Session",
        shortcut: "mod+shift+g",
        when: () => useSessions.getState().activeSessionId !== null,
        run: () => {
          const sessionId = useSessions.getState().activeSessionId;
          if (sessionId) openChangesPanel(api, sessionId);
        },
      },
      {
        id: "search.open",
        title: "Search Transcripts",
        group: "Search",
        shortcut: "mod+shift+f",
        run: revealSearch,
      },
    ]);

    // layout persistence (debounced; losing it loses nothing but comfort)
    let saveTimer = 0;
    const scheduleSave = () => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        if (disposed) return;
        savePersistedPatch({
          layout: buildSavedLayout(
            api.toJSON(),
            useShellUi.getState().sidebarCollapsed,
          ),
        });
      }, 800);
    };
    const layoutSub = api.onDidLayoutChange(() => {
      // Synchronous, NOT debounced: chat surfaces must freeze scroll handling
      // before this frame's stray scroll events land (dockview reparents
      // panel DOM on splits/moves, silently resetting scrollTop).
      window.dispatchEvent(new Event(DOCK_RELAYOUT_EVENT));
      scheduleSave();
    });
    const unsubShell = useShellUi.subscribe((s, prev) => {
      if (s.sidebarCollapsed !== prev.sidebarCollapsed) scheduleSave();
    });

    return () => {
      disposed = true;
      window.clearTimeout(saveTimer);
      unregister();
      window.removeEventListener(OPEN_SESSION_CHANGES_EVENT, onOpenChanges);
      unsubUi();
      unsubSessions();
      unsubShell();
      removeSub.dispose();
      addSub.dispose();
      activeSub.dispose();
      layoutSub.dispose();
      api.dispose();
    };
  }, [saved]);

  return (
    <>
      <div
        ref={containerRef}
        className="chamber-dock-layout h-full w-full"
        data-chamber-dock-layout
      />
      {[...portals.entries()].map(([id, element]) =>
        createPortal(panelNode(id), element, id),
      )}
    </>
  );
}
