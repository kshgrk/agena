import { Terminal as TerminalIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { PtyPortMessage } from "../../../shared/bridge.ts";
import { formatBridgeError } from "../../lib/errors.ts";
import { pushToast, useSessions } from "../../store/index.ts";
import { Button, EmptyState } from "../../ui/index.ts";
import { useTerminals } from "./terminal-store.ts";
import { TerminalView } from "./terminal-view.tsx";

const encoder = new TextEncoder();

const EXTRA_KEYS = [
  ["Esc", "\u001b"],
  ["Ctrl-C", "\u0003"],
  ["Tab", "\t"],
  ["←", "\u001b[D"],
  ["↑", "\u001b[A"],
  ["↓", "\u001b[B"],
  ["→", "\u001b[C"],
] as const;

/** One visible PTY per active session; other sessions keep their scrollback. */
export function MobileTerminal() {
  const activeSession = useSessions((s) =>
    s.activeSessionId ? s.byId[s.activeSessionId] : undefined,
  );
  const tabs = useTerminals((s) => s.tabs);
  const setActive = useTerminals((s) => s.setActive);
  const [opening, setOpening] = useState(false);
  const tab = useMemo(
    () =>
      activeSession
        ? tabs.find(
            (candidate) => candidate.sessionId === activeSession.sessionId,
          )
        : undefined,
    [activeSession, tabs],
  );

  useEffect(() => {
    if (tab) setActive(tab.id);
  }, [setActive, tab]);

  const open = async () => {
    if (!activeSession || opening) return;
    setOpening(true);
    try {
      await useTerminals.getState().open({
        cwd: activeSession.cwd,
        sessionId: activeSession.sessionId,
      });
    } catch (error) {
      pushToast({
        kind: "err",
        title: "Could not open terminal",
        detail: formatBridgeError(error),
      });
    } finally {
      setOpening(false);
    }
  };

  if (!activeSession) {
    return (
      <EmptyState
        icon={TerminalIcon}
        title="No session selected"
        hint="Pick a session before opening its cloud terminal."
      />
    );
  }

  if (!tab) {
    return (
      <EmptyState
        icon={TerminalIcon}
        title="Cloud terminal"
        hint={`Open one terminal in ${activeSession.cwd}.`}
        action={
          <Button
            variant="primary"
            disabled={opening}
            onClick={() => void open()}
          >
            {opening ? "Opening…" : "Open terminal"}
          </Button>
        }
      />
    );
  }

  const send = (text: string) => {
    if (tab.exited) return;
    tab.port.postMessage({
      type: "data",
      data: encoder.encode(text).buffer as ArrayBuffer,
    } satisfies PtyPortMessage);
    tab.term.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-inset">
      <div className="flex min-h-13 shrink-0 items-center gap-1 overflow-x-auto border-b border-border-subtle px-2 scrollbar-none">
        {EXTRA_KEYS.map(([label, value]) => (
          <button
            key={label}
            type="button"
            disabled={tab.exited !== null}
            onClick={() => send(value)}
            className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-border bg-raised px-2 font-mono text-xs text-fg-secondary active:bg-overlay disabled:opacity-40"
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <TerminalView tab={tab} active />
      </div>
    </div>
  );
}
