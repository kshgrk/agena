// Source-derived from OpenChamber apps/MobileApp.tsx (MIT).
import { PanelLeft, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { OpenChamberSlidingDrawer } from "./sliding-drawer.tsx";
import { useEdgeSwipe } from "./use-edge-swipe.ts";

export type OpenChamberMobileShellProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  chat: ReactNode;
  composer?: ReactNode;
  sessions: (close: () => void) => ReactNode;
  workspace: ReactNode;
  sessionsFooter?: ReactNode;
  workspaceHeader?: ReactNode;
  overlays?: ReactNode;
};

export function OpenChamberMobileShell({
  title,
  subtitle,
  chat,
  composer,
  sessions,
  workspace,
  sessionsFooter,
  workspaceHeader,
  overlays,
}: OpenChamberMobileShellProps) {
  const [drawer, setDrawer] = useState<"sessions" | "workspace" | null>(null);
  const chatRef = useRef<HTMLElement | null>(null);
  useEdgeSwipe(chatRef, {
    onLeft: () => setDrawer("sessions"),
    onRight: () => setDrawer("workspace"),
  });
  useEffect(() => {
    const back = (event: Event) => {
      if (!drawer) return;
      event.preventDefault();
      setDrawer(null);
    };
    window.addEventListener("agena:native-back", back);
    return () => window.removeEventListener("agena:native-back", back);
  }, [drawer]);
  const closeDrawer = () => setDrawer(null);
  return (
    <div className="oc-mobile-app-shell main-content-safe-area flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header
        className="oc-mobile-header flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 border-b border-border px-2"
        style={{
          paddingTop: "var(--oc-safe-area-top, env(safe-area-inset-top, 0px))",
        }}
      >
        <button
          type="button"
          onClick={() => setDrawer("sessions")}
          className="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
          aria-label="Open sessions"
        >
          <PanelLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-sm font-semibold">{title}</div>
          {subtitle ? (
            <div className="truncate text-[11px] text-muted-foreground">
              {subtitle}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setDrawer("workspace")}
          className="flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
          aria-label="Open workspace"
        >
          <PanelRight className="size-5" />
        </button>
      </header>
      <main ref={chatRef} className="relative min-h-0 flex-1 overflow-hidden">
        {chat}
      </main>
      {composer ? (
        <div className="oc-mobile-composer shrink-0">{composer}</div>
      ) : null}

      <OpenChamberSlidingDrawer
        open={drawer === "sessions"}
        side="left"
        onClose={closeDrawer}
        ariaLabel="Sessions"
      >
        <div className="min-h-0 flex-1 overflow-hidden">
          {sessions(closeDrawer)}
        </div>
        {sessionsFooter ? (
          <div className="shrink-0 border-t border-border">
            {sessionsFooter}
          </div>
        ) : null}
      </OpenChamberSlidingDrawer>
      <OpenChamberSlidingDrawer
        open={drawer === "workspace"}
        side="right"
        onClose={closeDrawer}
        ariaLabel="Workspace"
      >
        {workspaceHeader}
        <div className="min-h-0 flex-1 overflow-hidden">{workspace}</div>
      </OpenChamberSlidingDrawer>
      {overlays}
    </div>
  );
}
