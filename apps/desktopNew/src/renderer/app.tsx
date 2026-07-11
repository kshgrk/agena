// The app shell. Boot wiring (features.md §0): the bridge is already installed
// by main.tsx; here we wire streams BEFORE connecting (subscribeBridge), load
// persisted state, then connectAndBootstrap after first paint — a failed
// connect leaves a usable shell. Frame: collapsible sessions rail (outside
// dockview) · dockview workbench · 24px statusbar, with the connect feature
// replacing the workbench while there is no daemon connection, and the
// overlay hosts (palette, settings, approvals, toasts) as siblings.
import { PanelLeftOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PersistedState } from "../shared/bridge.ts";
import { pane as approvalsPane } from "./features/approvals/index.ts";
import { pane as connectPane } from "./features/connect/index.ts";
import { pane as palettePane } from "./features/palette/index.ts";
import { pane as sessionsPane } from "./features/sessions/index.ts";
import { pane as settingsPane } from "./features/settings/index.ts";
import { pane as toastsPane } from "./features/toasts/index.ts";
import { peekBridge } from "./lib/bridge.ts";
import { DockLayout } from "./shell/layout.tsx";
import {
  parseSavedLayout,
  type SavedLayout,
  useShellUi,
} from "./shell/panes.ts";
import { GlobalShortcuts } from "./shell/shortcuts.tsx";
import { StatusBar } from "./shell/statusbar.tsx";
import {
  connectAndBootstrap,
  hasOverlay,
  hydrateUiFromPersisted,
  loadPersistedState,
  subscribeBridge,
  useConnection,
  useUi,
} from "./store/index.ts";
import { Button, cx, IconButton, TooltipProvider } from "./ui/index.ts";

/** connect() must run exactly once per renderer load (StrictMode double-mounts). */
let bootConnectStarted = false;

/** Banner shown when a previously-working connection drops for good. */
function DisconnectedBanner({ detail }: { detail: string | null }) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-danger/35 bg-danger/10 px-3 text-xs text-danger">
      <span className="truncate">
        Disconnected from daemon{detail ? ` — ${detail}` : ""}
      </span>
      <Button size="sm" onClick={() => void connectAndBootstrap()}>
        Retry
      </Button>
    </div>
  );
}

export function App() {
  const [persisted, setPersisted] = useState<PersistedState | null>(null);
  const [savedLayout, setSavedLayout] = useState<SavedLayout | null>(null);
  const connState = useConnection((s) => s.state);
  const connDetail = useConnection((s) => s.detail);
  const connInfo = useConnection((s) => s.info);
  const sidebarCollapsed = useShellUi((s) => s.sidebarCollapsed);
  const autoCollapsed = useRef(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const sync = () => {
      if (media.matches && !useShellUi.getState().sidebarCollapsed) {
        autoCollapsed.current = true;
        useShellUi.getState().setSidebarCollapsed(true);
      } else if (!media.matches && autoCollapsed.current) {
        autoCollapsed.current = false;
        useShellUi.getState().setSidebarCollapsed(false);
      }
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  // Boot: wire streams → hydrate persisted UI state → connect after first paint.
  useEffect(() => {
    const bridge = peekBridge();
    if (!bridge) return; // main.tsx ensureBridge() failed; connect pane shows
    const off = subscribeBridge(bridge);
    let cancelled = false;
    void (async () => {
      const p = await loadPersistedState();
      if (cancelled) return;
      hydrateUiFromPersisted(p);
      const saved = parseSavedLayout(p.layout);
      if (saved)
        useShellUi.getState().setSidebarCollapsed(saved.sidebarCollapsed);
      setSavedLayout(saved);
      setPersisted(p);
      if (!bootConnectStarted) {
        bootConnectStarted = true;
        void connectAndBootstrap();
      }
    })();
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // D-INV-3: the native browser WebContentsView paints above ALL renderer DOM,
  // so it must hide whenever any overlay is up. `hasOverlay` covers the palette
  // and counter-tracked overlays; the settings dialog is included explicitly
  // (the ui-kit Dialog doesn't bump the counter).
  const overlayUp = useUi((s) => hasOverlay(s) || s.settingsOpen);
  const browserOpen = useUi((s) => s.browserOpen);
  useEffect(() => {
    void peekBridge()
      ?.browserSetVisible(browserOpen && !overlayUp)
      .catch(() => {});
  }, [overlayUp, browserOpen]);

  // No daemon connection was ever established → the connect feature owns the
  // screen (statusbar stays for the connection indicator).
  const showConnect = connState === "closed" && connInfo === null;

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col bg-canvas font-sans text-sm text-fg">
        {showConnect ? (
          <div className="min-h-0 flex-1">
            <connectPane.Component />
          </div>
        ) : (
          <>
            {connState === "closed" ? (
              <DisconnectedBanner detail={connDetail} />
            ) : null}
            <div className="flex min-h-0 flex-1">
              {/* hidden, never unmounted: the rail owns the session.* commands
                  (mod+n dialog, mod+o, mod+alt+arrows) — unmounting it would
                  unregister them exactly when the sidebar is collapsed */}
              <aside
                className={cx(
                  "w-[260px] shrink-0 border-r border-border-subtle bg-surface",
                  sidebarCollapsed && "hidden",
                )}
              >
                <sessionsPane.Component />
              </aside>
              <main className="relative min-w-0 flex-1">
                {sidebarCollapsed ? (
                  <div className="absolute left-2 top-2 z-20">
                    <IconButton
                      label="Show sessions sidebar"
                      onClick={() =>
                        useShellUi.getState().setSidebarCollapsed(false)
                      }
                    >
                      <PanelLeftOpen />
                    </IconButton>
                  </div>
                ) : null}
                {persisted ? <DockLayout saved={savedLayout} /> : null}
              </main>
            </div>
          </>
        )}
        <StatusBar />
      </div>
      <toastsPane.Component />
      <approvalsPane.Component />
      <palettePane.Component />
      <settingsPane.Component />
      <GlobalShortcuts />
    </TooltipProvider>
  );
}
