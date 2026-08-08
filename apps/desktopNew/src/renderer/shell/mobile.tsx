import {
  FileDiff,
  Folder,
  MessageSquare,
  PanelLeft,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ComposerPane } from "../features/composer/pane.tsx";
import { DiffPane } from "../features/diff/pane.tsx";
import { FilesPane } from "../features/files/pane.tsx";
import { MobileSessions } from "../features/sessions/mobile-sessions.tsx";
import { MobileTerminal } from "../features/terminal/mobile-terminal.tsx";
import { TranscriptPane } from "../features/transcript/pane.tsx";
import { useConnection, useSessions } from "../store/index.ts";
import { cx } from "../ui/index.ts";
import { isMobileHost, isSoftwareKeyboardVisible } from "./mobile-logic.ts";

export type MobileView = "sessions" | "work" | "files" | "diff" | "terminal";

const NAV = [
  { id: "sessions", label: "Sessions", icon: PanelLeft },
  { id: "work", label: "Work", icon: MessageSquare },
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

function useSoftwareKeyboard(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let baseline = viewport.height;
    const sync = () => {
      const active = document.activeElement;
      const textInput =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (!textInput) baseline = Math.max(baseline, viewport.height);
      setVisible(
        isSoftwareKeyboardVisible(viewport.height, baseline, textInput),
      );
    };
    const reset = () => {
      baseline = viewport.height;
      setVisible(false);
    };
    sync();
    viewport.addEventListener("resize", sync);
    window.addEventListener("focusin", sync);
    window.addEventListener("focusout", sync);
    screen.orientation?.addEventListener("change", reset);
    return () => {
      viewport.removeEventListener("resize", sync);
      window.removeEventListener("focusin", sync);
      window.removeEventListener("focusout", sync);
      screen.orientation?.removeEventListener("change", reset);
    };
  }, []);
  return visible;
}

function MobileHeader({ view }: { view: MobileView }) {
  const connection = useConnection((s) => s.state);
  const active = useSessions((s) =>
    s.activeSessionId ? s.byId[s.activeSessionId] : undefined,
  );
  const title =
    view === "work" || view === "terminal"
      ? active?.title || active?.cwd || "Agena"
      : NAV.find((item) => item.id === view)?.label || "Agena";
  return (
    <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-4 pt-[env(safe-area-inset-top)]">
      <span
        role="status"
        aria-label={connection}
        className={cx(
          "status-dot",
          connection === "connected"
            ? "bg-success"
            : connection === "closed"
              ? "bg-danger"
              : "bg-warn animate-pulse-soft",
        )}
      />
      <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-fg">
        {title}
      </h1>
    </header>
  );
}

/** Phone-first single-screen shell; every screen stays mounted to preserve state. */
export function MobileShell() {
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const [view, setView] = useState<MobileView>(() =>
    activeSessionId ? "work" : "sessions",
  );
  const previousSession = useRef(activeSessionId);
  const keyboardVisible = useSoftwareKeyboard();

  useEffect(() => {
    if (
      activeSessionId &&
      activeSessionId !== previousSession.current &&
      view === "sessions"
    ) {
      setView("work");
    }
    previousSession.current = activeSessionId;
  }, [activeSessionId, view]);

  return (
    <div className="agena-mobile flex h-full min-h-0 flex-col bg-canvas">
      <MobileHeader view={view} />
      <main className="relative min-h-0 flex-1">
        <section
          className={cx("absolute inset-0", view !== "sessions" && "hidden")}
        >
          <MobileSessions />
        </section>
        <section
          className={cx(
            "absolute inset-0 flex min-h-0 flex-col",
            view !== "work" && "hidden",
          )}
        >
          <div className="min-h-0 flex-1">
            <TranscriptPane />
          </div>
          <div className="shrink-0 border-t border-border-subtle bg-surface pb-[env(safe-area-inset-bottom)]">
            <ComposerPane mobile />
          </div>
        </section>
        <section
          className={cx("absolute inset-0", view !== "files" && "hidden")}
        >
          <FilesPane mobile />
        </section>
        <section
          className={cx("absolute inset-0", view !== "diff" && "hidden")}
        >
          <DiffPane mobile />
        </section>
        <section
          className={cx("absolute inset-0", view !== "terminal" && "hidden")}
        >
          <MobileTerminal />
        </section>
      </main>
      <nav
        aria-label="Conductor"
        className={cx(
          "agena-mobile-nav grid shrink-0 grid-cols-5 border-t border-border-subtle bg-surface pb-[env(safe-area-inset-bottom)]",
          keyboardVisible && "hidden",
        )}
      >
        {NAV.map(({ id, label, icon: Icon }) => {
          const selected = view === id;
          return (
            <button
              key={id}
              type="button"
              aria-current={selected ? "page" : undefined}
              onClick={() => setView(id)}
              className={cx(
                "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-2xs",
                selected ? "text-accent" : "text-fg-muted active:text-fg",
              )}
            >
              <Icon className="size-5" />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
