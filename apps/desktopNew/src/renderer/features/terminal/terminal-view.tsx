// One xterm surface per tab: attach (or re-attach) the terminal element, fit
// on resize (debounced → resize message on the port), webgl with DOM-renderer
// fallback, inline find bar (mod+f), exit strip with a restart affordance.
// The Terminal itself is owned by terminal-store — it survives dock remounts.
import "@xterm/xterm/css/xterm.css";
import { WebglAddon } from "@xterm/addon-webgl";
import { ChevronDown, ChevronUp, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PtyPortMessage } from "../../../shared/bridge.ts";
import { formatBridgeError } from "../../lib/errors.ts";
import { pushToast } from "../../store/index.ts";
import { IconButton, Input } from "../../ui/index.ts";
import { exitText } from "./terminal-logic.ts";
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

  // Attach effect keyed by tab.id — term/fit/port are stable per pty; the tab
  // OBJECT identity changes on patches, so depending on `tab` would re-run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by tab.id on purpose
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const { term, fit, port } = tab;

    // Reattach guard: re-append the existing element when the dock remounts
    // (StrictMode double-mount included) — scrollback and state are kept.
    if (term.element) el.appendChild(term.element);
    else term.open(el);
    // design.md §10: xterm on bg-inset with 12px padding, no inner border.
    // FitAddon subtracts element padding from the grid.
    if (term.element) term.element.style.padding = "12px";
    if (active && !tab.exited) term.focus();

    let webgl: WebglAddon | null = null;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => addon.dispose());
      term.loadAddon(addon);
      webgl = addon;
    } catch {
      webgl = null; // no webgl — xterm's canvas/DOM renderer is fine
    }

    let timer = 0;
    const doFit = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      fit.fit();
      try {
        port.postMessage({
          type: "resize",
          cols: term.cols,
          rows: term.rows,
        } satisfies PtyPortMessage);
      } catch {
        // port dead after exit — the local grid still fits
      }
    };
    doFit();
    // Covers window resizes AND dockview panel drags — dockview resizes this
    // panel's DOM, which the observer sees; 50ms debounce collapses drags.
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
  }, [tab.id]);

  useEffect(() => {
    if (active && !tab.exited) tab.term.focus();
  }, [active, tab.exited, tab.term]);

  const closeFind = () => {
    useTerminals.getState().setFind(null);
    tab.search.clearDecorations();
    tab.term.focus();
  };

  const restart = () => {
    useTerminals
      .getState()
      .restart(tab.id)
      .catch((err: unknown) => {
        pushToast({
          kind: "err",
          title: "Could not restart terminal",
          detail: formatBridgeError(err),
        });
      });
  };

  return (
    <div
      role="application"
      aria-label="Terminal"
      className="relative h-full w-full bg-inset"
      onPointerDown={() => {
        if (!tab.exited) tab.term.focus();
      }}
    >
      <div ref={containerRef} className="h-full w-full" />
      {findOpen ? (
        <div className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-md border border-border bg-raised p-1 shadow-md">
          <Input
            autoFocus
            fieldSize="md"
            value={query}
            placeholder="Find"
            aria-label="Find in terminal"
            className="w-44 font-mono"
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
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 border-t border-border bg-surface/90 py-1 pl-3 pr-2">
          <span className="truncate font-mono text-sm text-fg-muted">
            {exitText(tab.exited)}
          </span>
          <IconButton label="Restart terminal" size="sm" onClick={restart}>
            <RotateCcw />
          </IconButton>
        </div>
      ) : null}
    </div>
  );
}
