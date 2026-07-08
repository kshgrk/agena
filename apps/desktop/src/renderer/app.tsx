// The workbench shell (plan §7.1): fixed 260px sessions rail on the left, a
// dockview grid for center/right/bottom (transcript · inspector · dock), a
// fixed status bar, and the app-level overlays. dockview v7 ships no React
// adapter, so panels render through portals into renderer-owned elements —
// one React tree, so providers and zustand stores behave normally.
import "dockview/dist/styles/dockview.css";
import {
  createDockview,
  type DockviewApi,
  type IContentRenderer,
  type SerializedDockview,
  themeAbyss,
} from "dockview";
import { MessageSquare } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PersistedState } from "../shared/bridge.ts";
import { ApprovalsHost } from "./features/approvals/approvals-host.tsx";
import { Composer } from "./features/composer/composer.tsx";
import { FilesPane } from "./features/files/files-pane.tsx";
import { InspectorPane } from "./features/inspector/inspector-pane.tsx";
import { CommandPalette } from "./features/palette/command-palette.tsx";
import { GlobalHotkeys } from "./features/palette/global-hotkeys.tsx";
import { SearchPane } from "./features/search/search-pane.tsx";
import { SessionsRail } from "./features/sessions/sessions-rail.tsx";
import { SnapshotsPane } from "./features/snapshots/snapshots-pane.tsx";
import { StatusBar } from "./features/statusbar/status-bar.tsx";
import { TerminalDock } from "./features/terminal/terminal-dock.tsx";
import { TranscriptPane } from "./features/transcript/transcript-pane.tsx";
import { getBridge } from "./lib/bridge.ts";
import { connectAndBootstrap } from "./lib/connect.ts";
import { chordLabel } from "./store/commands.ts";
import {
  ensureSubscribed,
  useConnection,
  useSessions,
  useUi,
} from "./store/index.ts";
import {
  Button,
  EmptyState,
  PanelShell,
  Toasts,
  TooltipProvider,
  toast,
} from "./ui/index.ts";

// ---- center panel: the session workspace ------------------------------------

function SessionWorkspace() {
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const connState = useConnection((s) => s.state);
  // The displayed session is always subscribed — this heals every race
  // (activation while connecting, reconnects, bootstrap ordering).
  useEffect(() => {
    if (!activeSessionId || connState !== "connected") return;
    ensureSubscribed(activeSessionId).catch((err: unknown) => {
      const m = err instanceof Error ? err.message : "subscribe failed";
      toast(m, { tone: "err" });
    });
  }, [activeSessionId, connState]);
  if (!activeSessionId) {
    return (
      <PanelShell className="bg-app">
        <EmptyState
          icon={MessageSquare}
          title="Pick or create a session"
          hint={`${chordLabel("mod+n")} starts a new one.`}
        />
      </PanelShell>
    );
  }
  return (
    <PanelShell key={activeSessionId} className="bg-app">
      <div className="min-h-0 flex-1">
        <TranscriptPane sessionId={activeSessionId} />
      </div>
      <Composer sessionId={activeSessionId} />
    </PanelShell>
  );
}

// ---- dockview panel registry -------------------------------------------------

const DOCK_PANELS = [
  ["terminal", "Terminal"],
  ["files", "Files"],
  ["search", "Search"],
  ["snapshots", "Snapshots"],
] as const;
const DOCK_IDS: readonly string[] = DOCK_PANELS.map(([id]) => id);

function panelNode(id: string): ReactNode {
  switch (id) {
    case "transcript":
      return <SessionWorkspace />;
    case "inspector":
      return <InspectorPane />;
    case "terminal":
      return <TerminalDock />;
    case "files":
      return <FilesPane />;
    case "search":
      return <SearchPane />;
    case "snapshots":
      return <SnapshotsPane />;
    default:
      // stale layouts may reference panels this build no longer ships (D-INV-6 spirit)
      return <EmptyState title={`Unknown panel “${id}”`} />;
  }
}

// ---- layout helpers -----------------------------------------------------------

function ensureTranscript(api: DockviewApi): void {
  if (!api.getPanel("transcript")) {
    api.addPanel({
      id: "transcript",
      component: "transcript",
      title: "Session",
    });
  }
}

/** Add any missing dock panels; the first missing one opens the bottom group. */
function ensureDockPanels(api: DockviewApi): void {
  ensureTranscript(api);
  let ref: string | null = null;
  for (const id of DOCK_IDS) if (api.getPanel(id)) ref = ref ?? id;
  for (const [id, title] of DOCK_PANELS) {
    if (api.getPanel(id)) continue;
    api.addPanel({
      id,
      component: id,
      title,
      inactive: true,
      ...(ref === null
        ? {
            position: { referencePanel: "transcript", direction: "below" },
            initialHeight: 280,
          }
        : { position: { referencePanel: ref, direction: "within" } }),
    });
    ref = id;
  }
  // a freshly-built group has no active panel yet (everything added inactive)
  const group = dockGroup(api);
  if (group && !group.activePanel) api.getPanel("terminal")?.api.setActive();
}

/** The dock group = the group holding the terminal panel (or any dock panel). */
function dockGroup(api: DockviewApi) {
  for (const id of DOCK_IDS) {
    const panel = api.getPanel(id);
    if (panel) return panel.group;
  }
  return undefined;
}

function applyDock(api: DockviewApi, open: boolean): void {
  if (open) ensureDockPanels(api);
  // ponytail: "the dock" is the group holding the terminal tab; panels the
  // user dragged elsewhere are their own problem.
  dockGroup(api)?.api.setVisible(open);
}

function applyInspector(api: DockviewApi, open: boolean): void {
  const panel = api.getPanel("inspector");
  if (open && !panel) {
    ensureTranscript(api);
    const added = api.addPanel({
      id: "inspector",
      component: "inspector",
      title: "Inspector",
      inactive: true,
      initialWidth: 340,
      position: { referencePanel: "transcript", direction: "right" },
    });
    // its (new) group needs an active panel or the content never attaches
    if (!added.group.activePanel) added.api.setActive();
  } else if (!open && panel) {
    api.removePanel(panel);
  }
}

/** Bump to discard persisted layouts whose defaults no longer apply. */
const LAYOUT_VERSION = 2;

/** Transcript-first: the session IS the app; inspector/dock open on demand. */
function buildDefaultLayout(api: DockviewApi): void {
  api.addPanel({ id: "transcript", component: "transcript", title: "Session" });
  api.getPanel("transcript")?.api.setActive();
}

// ---- the shell ------------------------------------------------------------------

export function App({ persisted }: { persisted: PersistedState }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [portals, setPortals] = useState<ReadonlyMap<string, HTMLElement>>(
    new Map(),
  );
  const connState = useConnection((s) => s.state);
  const connDetail = useConnection((s) => s.detail);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;

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

    // restore the persisted layout; wrong version or anything bad → default
    let restored = false;
    const saved = persisted.layout as {
      v?: number;
      dock?: SerializedDockview;
    } | null;
    if (saved?.v === LAYOUT_VERSION && saved.dock) {
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
    useUi.getState().setTerminalOpen(dockGroup(api)?.api.isVisible ?? false);

    // dockview → store (tab close buttons)
    const removeSub = api.onDidRemovePanel((panel) => {
      if (disposed) return;
      if (panel.id === "transcript") {
        // the workbench always has its center panel
        queueMicrotask(() => {
          if (!disposed) ensureTranscript(api);
        });
      } else if (panel.id === "inspector") {
        useUi.getState().setInspectorOpen(false);
      } else if (
        DOCK_IDS.includes(panel.id) &&
        !DOCK_IDS.some((id) => api.getPanel(id))
      ) {
        useUi.getState().setTerminalOpen(false);
      }
    });
    const addSub = api.onDidAddPanel((panel) => {
      if (!disposed && panel.id === "inspector") {
        useUi.getState().setInspectorOpen(true);
      }
    });

    // store → dockview
    const unsubUi = useUi.subscribe((s, prev) => {
      if (s.inspectorOpen !== prev.inspectorOpen) {
        applyInspector(api, s.inspectorOpen);
      }
      if (s.terminalOpen !== prev.terminalOpen) applyDock(api, s.terminalOpen);
    });

    // mod+shift+f / search.open → reveal the dock, focus the Search tab. The
    // event re-fires once on the next frame so SearchPane's own listener can
    // focus its input after the dock became visible.
    let refiring = false;
    const openSearch = () => {
      applyDock(api, true);
      useUi.getState().setTerminalOpen(true);
      api.getPanel("search")?.api.setActive();
      if (!refiring) {
        refiring = true;
        requestAnimationFrame(() => {
          window.dispatchEvent(new Event("agena:open-search"));
          refiring = false;
        });
      }
    };
    window.addEventListener("agena:open-search", openSearch);

    // layout persistence (debounced; losing it loses nothing but comfort)
    let saveTimer = 0;
    const layoutSub = api.onDidLayoutChange(() => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        if (disposed) return;
        void getBridge()
          .savePersisted({ layout: { v: LAYOUT_VERSION, dock: api.toJSON() } })
          .catch(() => {});
      }, 800);
    });

    return () => {
      disposed = true;
      window.clearTimeout(saveTimer);
      window.removeEventListener("agena:open-search", openSearch);
      unsubUi();
      removeSub.dispose();
      addSub.dispose();
      layoutSub.dispose();
      api.dispose();
    };
  }, [persisted]);

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-app font-sans text-[13px] text-ink">
        {connState === "closed" ? (
          <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-err/40 bg-err/10 px-3 text-xs text-err">
            <span className="truncate">
              Disconnected from daemon
              {connDetail ? ` — ${connDetail}` : ""}
            </span>
            <Button
              size="sm"
              onClick={() => void connectAndBootstrap(persisted)}
            >
              Retry
            </Button>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1">
          <aside className="w-[260px] shrink-0 border-r border-border">
            <SessionsRail />
          </aside>
          <main className="min-w-0 flex-1">
            <div ref={containerRef} className="h-full w-full" />
          </main>
        </div>
        <StatusBar />
      </div>
      {[...portals.entries()].map(([id, element]) =>
        createPortal(panelNode(id), element, id),
      )}
      <Toasts />
      <ApprovalsHost />
      <CommandPalette />
      <GlobalHotkeys />
    </TooltipProvider>
  );
}
