// The dockview workbench: center transcript+composer, right dock tabs
// (inspector/files/timeline/snapshots/diff/search), bottom terminal dock.
// dockview v7 ships no React adapter, so panels render through portals into
// renderer-owned elements — one React tree, so providers and zustand stores
// behave normally. Ported and adapted from apps/desktop app.tsx.
import "dockview/dist/styles/dockview.css";
import "./dockview.css";
import {
  createDockview,
  type DockviewApi,
  type IContentRenderer,
  themeAbyss,
} from "dockview";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChildSessionBanner } from "../features/agents/task-group.tsx";
import {
  pane as browserPane,
  initBrowserStore,
} from "../features/browser/index.ts";
import { Composer } from "../features/composer/composer.tsx";
import { pane as diffPane } from "../features/diff/index.ts";
import { pane as filesPane } from "../features/files/index.ts";
import { pane as inspectorPane } from "../features/inspector/index.ts";
import { pane as searchPane } from "../features/search/index.ts";
import { pane as snapshotsPane } from "../features/snapshots/index.ts";
import { pane as terminalPane } from "../features/terminal/index.ts";
import { pane as timelinePane } from "../features/timeline/index.ts";
import { pane as transcriptPane } from "../features/transcript/index.ts";
import { Transcript } from "../features/transcript/transcript-pane.tsx";
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
const EMPTY_SESSION_PANEL = "session.empty";

function sessionPanelId(sessionId: string): string {
  return `${SESSION_PANEL_PREFIX}${sessionId}`;
}

function panelSessionId(panelId: string): string | null {
  return panelId.startsWith(SESSION_PANEL_PREFIX)
    ? panelId.slice(SESSION_PANEL_PREFIX.length)
    : null;
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
    <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[auto_minmax(0,1fr)_auto] bg-canvas lg:grid-cols-[28px_minmax(0,1fr)]">
      <div className="col-start-1 row-start-1 lg:col-span-2">
        <ChildSessionBanner sessionId={sessionId} />
      </div>
      <Transcript sessionId={sessionId} workspaceGrid />
      <div className="col-start-1 row-start-3 min-w-0 lg:col-start-2">
        <Composer sessionId={sessionId} />
      </div>
    </div>
  );
}

function EmptySessionWorkspace() {
  return (
    <EmptyState
      icon={transcriptPane.icon}
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
  const summary = useSessions.getState().byId[sessionId];
  const added = api.addPanel({
    id,
    component: id,
    title: summary?.title || "Untitled session",
    position: { referencePanel: centerPanelId(api), direction: "within" },
  });
  const empty = api.getPanel(EMPTY_SESSION_PANEL);
  if (empty) api.removePanel(empty);
  added.api.setActive();
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
        if (!sessionId) continue;
        const title = state.byId[sessionId]?.title || "Untitled session";
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
    const layoutSub = api.onDidLayoutChange(scheduleSave);
    const unsubShell = useShellUi.subscribe((s, prev) => {
      if (s.sidebarCollapsed !== prev.sidebarCollapsed) scheduleSave();
    });

    return () => {
      disposed = true;
      window.clearTimeout(saveTimer);
      unregister();
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
      <div ref={containerRef} className="h-full w-full" />
      {[...portals.entries()].map(([id, element]) =>
        createPortal(panelNode(id), element, id),
      )}
    </>
  );
}
