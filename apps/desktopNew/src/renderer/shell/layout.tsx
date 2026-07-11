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
import {
  pane as browserPane,
  initBrowserStore,
} from "../features/browser/index.ts";
import { pane as composerPane } from "../features/composer/index.ts";
import { pane as diffPane } from "../features/diff/index.ts";
import { pane as filesPane } from "../features/files/index.ts";
import { pane as inspectorPane } from "../features/inspector/index.ts";
import { pane as searchPane } from "../features/search/index.ts";
import { pane as snapshotsPane } from "../features/snapshots/index.ts";
import { pane as terminalPane } from "../features/terminal/index.ts";
import { pane as timelinePane } from "../features/timeline/index.ts";
import { pane as transcriptPane } from "../features/transcript/index.ts";
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

function SessionWorkspace() {
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const connState = useConnection((s) => s.state);
  // The displayed session is always subscribed — heals every race
  // (activation while connecting, reconnects, bootstrap ordering).
  useEffect(() => {
    if (!activeSessionId || connState !== "connected") return;
    ensureSubscribed(activeSessionId).catch((err: unknown) => {
      pushToast({
        kind: "err",
        title: "Failed to subscribe to session",
        detail: err instanceof Error ? err.message : "subscribe failed",
      });
    });
  }, [activeSessionId, connState]);
  if (!activeSessionId) {
    return (
      <EmptyState
        icon={transcriptPane.icon}
        title="Pick or create a session"
        hint={`${shortcutLabel("mod+n")} starts a new one.`}
      />
    );
  }
  return (
    <div
      key={activeSessionId}
      className="flex h-full min-h-0 flex-col bg-canvas"
    >
      <div className="min-h-0 flex-1">
        <transcriptPane.Component />
      </div>
      <div className="shrink-0">
        <composerPane.Component />
      </div>
    </div>
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
  if (id === "transcript") return <SessionWorkspace />;
  if (id === "terminal") return <terminalPane.Component />;
  const right = RIGHT_PANES.find((p) => p.id === id);
  if (right) return <right.Component />;
  // stale layouts may reference panels this build no longer ships (D-INV-6 spirit)
  return <EmptyState title={`Unknown panel “${id}”`} />;
}

// ---- layout helpers -----------------------------------------------------------------

function ensureTranscript(api: DockviewApi): void {
  if (!api.getPanel("transcript")) {
    api.addPanel({
      id: "transcript",
      component: "transcript",
      title: transcriptPane.title,
    });
  }
}

/** Add a right-dock pane: joins the existing right group, or opens one. */
function addRightPane(api: DockviewApi, id: string): void {
  ensureTranscript(api);
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
          position: { referencePanel: "transcript", direction: "right" },
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
  ensureTranscript(api);
  if (api.getPanel("terminal")) return;
  const added = api.addPanel({
    id: "terminal",
    component: "terminal",
    title: terminalPane.title,
    inactive: true,
    position: { referencePanel: "transcript", direction: "below" },
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
    id: "transcript",
    component: "transcript",
    title: transcriptPane.title,
  });
  api.getPanel("transcript")?.api.setActive();
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
    ensureTranscript(api);
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
      if (panel.id === "transcript") {
        // the workbench always has its center panel
        queueMicrotask(() => {
          if (!disposed) ensureTranscript(api);
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
      unsubShell();
      removeSub.dispose();
      addSub.dispose();
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
