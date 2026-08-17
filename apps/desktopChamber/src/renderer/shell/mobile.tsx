import {
  FileDiff,
  Folder,
  MessageSquare,
  PanelLeft,
  Settings,
  Terminal,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  OPEN_SESSION_CHANGES_EVENT,
  SessionChangesPill,
  SessionChangesWorkspace,
} from "../features/changes/index.tsx";
import { ComposerPane } from "../features/composer/pane.tsx";
import { DiffPane } from "../features/diff/pane.tsx";
import { FilesPane } from "../features/files/pane.tsx";
import { MobileSessions } from "../features/sessions/mobile-sessions.tsx";
import { MobileTerminal } from "../features/terminal/mobile-terminal.tsx";
import { AgenaChamberChat } from "../openchamber/adapters/agena-chat.tsx";
import { useConnection, useSessions, useUi } from "../store/index.ts";
import {
  OPEN_SOURCE_REFERENCE_EVENT,
  type SourceReference,
} from "../store/source-reference.ts";
import { cx } from "../ui/index.ts";
import { isMobileHost, isSoftwareKeyboardVisible } from "./mobile-logic.ts";

type MobileView = "sessions" | "chat" | "work" | "terminal";
type WorkView = "files" | "changes" | "diff";

const NAV = [
  { id: "sessions", label: "Sessions", icon: PanelLeft },
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "work", label: "Work", icon: Folder },
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
  const connection = useConnection((state) => state.state);
  const active = useSessions((state) =>
    state.activeSessionId ? state.byId[state.activeSessionId] : undefined,
  );
  const title =
    view === "chat" || view === "terminal"
      ? active?.title || active?.cwd || "Agena"
      : view === "work"
        ? "Workspace"
        : "Agena";
  return (
    <header className="flex min-h-14 shrink-0 items-end gap-3 border-b border-border-subtle bg-surface px-4 pb-2 pt-[env(safe-area-inset-top)]">
      <span
        role="status"
        aria-label={connection}
        className={cx(
          "mb-3 size-2 shrink-0 rounded-full",
          connection === "connected"
            ? "bg-success"
            : connection === "closed"
              ? "bg-danger"
              : "bg-warn animate-pulse-soft",
        )}
      />
      <div className="min-w-0 flex-1 py-1">
        <h1 className="truncate text-[17px] font-semibold leading-5 text-fg">
          {title}
        </h1>
        {active && view !== "sessions" ? (
          <p className="truncate text-xs text-fg-muted">{active.cwd}</p>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Open settings"
        onClick={() => useUi.getState().setSettingsOpen(true)}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-fg-muted active:bg-raised active:text-fg"
      >
        <Settings className="size-5" />
      </button>
    </header>
  );
}

/** Phone-first Command Deck; surfaces stay mounted so scroll, files, and PTYs persist. */
export function MobileShell() {
  const activeSessionId = useSessions((state) => state.activeSessionId);
  const [view, setView] = useState<MobileView>(() =>
    activeSessionId ? "chat" : "sessions",
  );
  const [workView, setWorkView] = useState<WorkView>("files");
  const previousSession = useRef(activeSessionId);
  const keyboardVisible = useSoftwareKeyboard();

  useEffect(() => {
    const openSource = (event: Event) => {
      const ref = (event as CustomEvent<SourceReference>).detail;
      if (!ref) return;
      if (ref.kind === "terminal") {
        setView("terminal");
        return;
      }
      if (ref.kind === "file") setWorkView("files");
      else if (ref.kind === "diff") {
        setWorkView(ref.changeGroupId ? "changes" : "diff");
      }
      setView("work");
    };
    window.addEventListener(OPEN_SOURCE_REFERENCE_EVENT, openSource);
    return () =>
      window.removeEventListener(OPEN_SOURCE_REFERENCE_EVENT, openSource);
  }, []);

  useEffect(() => {
    if (
      activeSessionId &&
      activeSessionId !== previousSession.current &&
      view === "sessions"
    ) {
      setView("chat");
    }
    previousSession.current = activeSessionId;
  }, [activeSessionId, view]);

  useEffect(() => {
    const openChanges = () => {
      setWorkView("changes");
      setView("work");
    };
    window.addEventListener(OPEN_SESSION_CHANGES_EVENT, openChanges);
    return () =>
      window.removeEventListener(OPEN_SESSION_CHANGES_EVENT, openChanges);
  }, []);

  return (
    <div className="agena-mobile flex h-full min-h-0 flex-col bg-canvas text-fg">
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
            view !== "chat" && "hidden",
          )}
        >
          <div className="relative min-h-0 flex-1">
            {activeSessionId ? (
              <>
                <AgenaChamberChat sessionId={activeSessionId} mobile />
                <SessionChangesPill sessionId={activeSessionId} />
              </>
            ) : (
              <div className="grid h-full place-items-center px-8 text-center text-sm text-fg-muted">
                Choose a session to start chatting.
              </div>
            )}
          </div>
          {activeSessionId ? (
            <div className="shrink-0 border-t border-border-subtle bg-surface px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
              <ComposerPane mobile />
            </div>
          ) : null}
        </section>
        <section
          className={cx(
            "absolute inset-0 flex min-h-0 flex-col",
            view !== "work" && "hidden",
          )}
        >
          <nav className="grid shrink-0 grid-cols-3 border-b border-border-subtle bg-surface p-1.5">
            {(
              [
                ["files", "Files", Folder],
                ["changes", "Changes", FileDiff],
                ["diff", "Edits", FileDiff],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                aria-current={workView === id ? "page" : undefined}
                onClick={() => setWorkView(id)}
                className={cx(
                  "flex min-h-11 items-center justify-center gap-2 rounded-lg text-sm font-medium",
                  workView === id
                    ? "bg-raised text-fg"
                    : "text-fg-muted active:text-fg",
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            ))}
          </nav>
          <div className="relative min-h-0 flex-1">
            <section
              className={cx(
                "absolute inset-0",
                workView !== "changes" && "hidden",
              )}
            >
              {activeSessionId ? (
                <SessionChangesWorkspace sessionId={activeSessionId} mobile />
              ) : null}
            </section>
            <section
              className={cx(
                "absolute inset-0",
                workView !== "files" && "hidden",
              )}
            >
              <FilesPane mobile />
            </section>
            <section
              className={cx(
                "absolute inset-0",
                workView !== "diff" && "hidden",
              )}
            >
              <DiffPane mobile />
            </section>
          </div>
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
          "agena-mobile-nav grid shrink-0 grid-cols-4 border-t border-border-subtle bg-surface px-2 pb-[env(safe-area-inset-bottom)]",
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
                "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium",
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
