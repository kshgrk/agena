import { FileDiff, Folder, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { ComposerPane } from "../features/composer/pane.tsx";
import { DiffPane } from "../features/diff/pane.tsx";
import { FilesPane } from "../features/files/pane.tsx";
import { MobileTerminal } from "../features/terminal/mobile-terminal.tsx";
import { AgenaChamberChat } from "../openchamber/adapters/agena-chat.tsx";
import { AgenaSessionSidebar } from "../openchamber/adapters/agena-sessions.tsx";
import { OpenChamberMobileShell } from "../openchamber/mobile/index.ts";
import { useSessions } from "../store/index.ts";
import { cx } from "../ui/index.ts";
import { isMobileHost } from "./mobile-logic.ts";

type WorkspaceView = "files" | "diff" | "terminal";

const WORKSPACE = [
  { id: "files", label: "Files", icon: Folder },
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "terminal", label: "Terminal", icon: Terminal },
] as const;

export function useMobileHost(): boolean {
  const native = Boolean(
    (
      globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }
    ).Capacitor?.isNativePlatform?.(),
  );
  const [mobile, setMobile] = useState(() =>
    isMobileHost(
      typeof window === "undefined" ? 1024 : window.innerWidth,
      native,
    ),
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const sync = () => setMobile(isMobileHost(window.innerWidth, native));
    sync();
    media.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }, [native]);
  return mobile;
}

/** OpenChamber's drawer-first mobile lifecycle over Agena's native surfaces. */
export function MobileShell() {
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const active = useSessions((s) =>
    s.activeSessionId ? s.byId[s.activeSessionId] : undefined,
  );
  const [workspace, setWorkspace] = useState<WorkspaceView>("files");

  return (
    <OpenChamberMobileShell
      title={active?.title || "Agena"}
      subtitle={active?.cwd}
      sessions={(close) => <AgenaSessionSidebar onSessionSelected={close} />}
      chat={
        activeSessionId ? (
          <AgenaChamberChat sessionId={activeSessionId} mobile />
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            Choose a session from the left drawer
          </div>
        )
      }
      composer={activeSessionId ? <ComposerPane mobile /> : null}
      workspaceHeader={
        <nav className="grid shrink-0 grid-cols-3 border-b border-border p-1">
          {WORKSPACE.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setWorkspace(id)}
              className={cx(
                "flex h-10 items-center justify-center gap-1.5 rounded-md text-xs",
                workspace === id
                  ? "bg-interactive-active text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
      }
      workspace={
        <>
          <section className={cx("h-full", workspace !== "files" && "hidden")}>
            <FilesPane mobile />
          </section>
          <section className={cx("h-full", workspace !== "diff" && "hidden")}>
            <DiffPane mobile />
          </section>
          <section
            className={cx("h-full", workspace !== "terminal" && "hidden")}
          >
            <MobileTerminal />
          </section>
        </>
      }
    />
  );
}
