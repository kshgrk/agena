// One xterm surface per tab: attach (or re-attach) the terminal element, fit on
// resize (debounced → resize message to the port), webgl when available, inline
// find bar (mod+f), exit overlay. The Terminal itself is owned by the store.
import "@xterm/xterm/css/xterm.css";
import { WebglAddon } from "@xterm/addon-webgl";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PtyPortMessage } from "../../../shared/bridge.ts";
import { IconButton, TextInput } from "../../ui/index.ts";
import { type TerminalTab, useTerminals } from "./terminal-store.ts";

export function TerminalView({
  tab,
  active,
}: {
  tab: TerminalTab;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const findOpen = useTerminals((s) => s.findFor === tab.id);
  const [query, setQuery] = useState("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: term/fit/port are stable per tab.id
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const { term, fit, port } = tab;

    // Re-append the existing element when the dock remounts (scrollback kept).
    if (term.element) el.appendChild(term.element);
    else term.open(el);
    if (active && !tab.exited) term.focus();
    // FitAddon subtracts element padding
    if (term.element) term.element.style.padding = "4px 8px";

    let webgl: WebglAddon | null = null;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => addon.dispose());
      term.loadAddon(addon);
      webgl = addon;
    } catch {
      webgl = null; // no webgl — DOM renderer is fine
    }

    let timer = 0;
    const doFit = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      fit.fit();
      port.postMessage({
        type: "resize",
        cols: term.cols,
        rows: term.rows,
      } satisfies PtyPortMessage);
    };
    doFit();
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(doFit, 50);
    });
    ro.observe(el);

    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
      try {
        webgl?.dispose();
      } catch {
        // already disposed via context loss
      }
    };
    // term/fit/port are stable per tab id; the tab object identity may change.
  }, [tab.id]);

  useEffect(() => {
    if (active && !tab.exited) tab.term.focus();
  }, [active, tab.exited, tab.term]);

  const closeFind = () => {
    useTerminals.getState().setFind(null);
    tab.search.clearDecorations();
    tab.term.focus();
  };

  const focusTerminal = () => {
    if (!tab.exited) tab.term.focus();
  };

  return (
    <div
      role="application"
      aria-label="Terminal"
      className="relative h-full w-full bg-surface"
      onPointerDown={focusTerminal}
    >
      <div ref={containerRef} className="h-full w-full" />
      {findOpen ? (
        <div className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-md border border-border bg-raised p-1 shadow-lg">
          <TextInput
            autoFocus
            value={query}
            placeholder="Find"
            className="h-6 w-40 font-mono text-xs"
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value)
                tab.search.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (e.shiftKey) tab.search.findPrevious(query);
                else tab.search.findNext(query);
              } else if (e.key === "Escape") {
                closeFind();
              }
            }}
          />
          <IconButton
            label="Previous match"
            size="sm"
            onClick={() => tab.search.findPrevious(query)}
          >
            <ChevronUp />
          </IconButton>
          <IconButton
            label="Next match"
            size="sm"
            onClick={() => tab.search.findNext(query)}
          >
            <ChevronDown />
          </IconButton>
          <IconButton label="Close find" size="sm" onClick={closeFind}>
            <X />
          </IconButton>
        </div>
      ) : null}
      {tab.exited ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-border bg-surface/90 px-3 py-1 font-mono text-xs text-ink-mute">
          process exited (code {tab.exited.code ?? "?"})
          {tab.exited.reason ? ` — ${tab.exited.reason}` : ""}
        </div>
      ) : null}
    </div>
  );
}
