// Source-derived from OpenChamber components/layout/MainLayout.tsx (MIT).
import type { ReactNode } from "react";
import { OpenChamberSidebar } from "./sidebar.tsx";

export type OpenChamberDesktopShellProps = {
  sidebarOpen: boolean;
  sidebarWidth?: number;
  onSidebarWidthChange?: (width: number) => void;
  titlebarControls?: ReactNode;
  sidebarTopBar?: ReactNode;
  sidebar: ReactNode;
  header: ReactNode;
  workspace: ReactNode;
  contextRail?: ReactNode;
  contextPanel?: ReactNode;
  overlays?: ReactNode;
};

/** OpenChamber's shell lifecycle with Agena's Dockview supplied as `workspace`. */
export function OpenChamberDesktopShell({
  sidebarOpen,
  sidebarWidth,
  onSidebarWidthChange,
  titlebarControls,
  sidebarTopBar,
  sidebar,
  header,
  workspace,
  contextRail,
  contextPanel,
  overlays,
}: OpenChamberDesktopShellProps) {
  return (
    <div
      className="main-content-safe-area relative flex h-full overflow-hidden bg-background text-foreground"
      data-page-scroll-lock="true"
    >
      {titlebarControls ? (
        <div className="pointer-events-none absolute left-0 top-0 z-40 h-12">
          <div className="pointer-events-auto h-full">{titlebarControls}</div>
        </div>
      ) : null}
      <OpenChamberSidebar
        open={sidebarOpen}
        topBar={sidebarTopBar}
        {...(sidebarWidth === undefined ? {} : { width: sidebarWidth })}
        {...(onSidebarWidthChange === undefined
          ? {}
          : { onWidthChange: onSidebarWidthChange })}
      >
        {sidebar}
      </OpenChamberSidebar>
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {header}
        <div className="relative flex min-h-0 flex-1 overflow-hidden border-t border-border bg-background">
          <main className="relative min-w-0 flex-1 overflow-hidden bg-background">
            {workspace}
          </main>
          {contextRail ? (
            <aside className="relative z-10 flex w-11 shrink-0 flex-col border-l border-border bg-background">
              {contextRail}
            </aside>
          ) : null}
          {contextPanel ? (
            <aside className="relative z-10 min-w-0 shrink-0 overflow-hidden border-l border-border bg-background">
              {contextPanel}
            </aside>
          ) : null}
        </div>
      </div>
      {overlays}
    </div>
  );
}
