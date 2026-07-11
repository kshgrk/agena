// Terminal dock state (features.md §5.10). PTY/xterm lifecycles live HERE,
// not in React effects: tabs (and their xterm instances) survive dock
// unmount/remount and StrictMode double-mounting; everything is disposed on
// close(). PTY port protocol: docs/contracts/bridge.md §2.
import type { CreatePtyRequest } from "@agena/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { type ITheme, Terminal } from "@xterm/xterm";
import { create } from "zustand";
import type { PtyPortMessage } from "../../../shared/bridge.ts";
import { getBridge } from "../../lib/bridge.ts";
import { useConnection } from "../../store/index.ts";
import { buildXtermTheme, lostPtyIds, nextActiveId, normalizeLabel } from "./terminal-logic.ts";

const encoder = new TextEncoder();
const INITIAL_PTY_COLS = 80;
const INITIAL_PTY_ROWS = 24;

const MONO_FALLBACK =
  'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

// ---- theme -------------------------------------------------------------------

// ponytail: theme.css tokens are oklch(); xterm's own parser only takes
// hex/rgb (its canvas fallback throws on any alpha). One shared 1×1 canvas
// round-trips every var to rgb()/rgba() the parser accepts.
let probeCtx: CanvasRenderingContext2D | null | undefined;

function toXtermColor(css: string): string {
  if (css.startsWith("#") || css.startsWith("rgb")) return css;
  if (probeCtx === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    probeCtx = canvas.getContext("2d", { willReadFrequently: true });
  }
  const ctx = probeCtx;
  if (!ctx) return css;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data as unknown as [
    number,
    number,
    number,
    number,
  ];
  return a === 255
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

/** xterm theme from the --term-* design tokens (design.md §10). Read at each
 * terminal mount and re-read on data-theme mutation. */
export function readXtermTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  return buildXtermTheme((varName) => {
    const raw = css.getPropertyValue(varName).trim();
    return raw ? toXtermColor(raw) : "";
  });
}

function cssVar(name: string, fallback: string): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

// ---- store -------------------------------------------------------------------

export type TerminalTab = {
  id: string; // = ptyId
  cwd: string;
  /** Set when opened from a session (badges the tab). */
  sessionId: string | null;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  port: MessagePort;
  /** Current selection, falling back to the last non-empty one. */
  readSelection: () => string;
  /** Custom rename; null → derive from title/cwd (terminal-logic tabLabel). */
  label: string | null;
  /** Last OSC title reported by the shell. */
  title: string | null;
  /** Bell rang while the tab was inactive; cleared on activation. */
  bell: boolean;
  /** null while running. */
  exited: { code: number | null; reason: string | null } | null;
};

export type TerminalsStore = {
  tabs: readonly TerminalTab[];
  activeId: string | null;
  /** Tab id whose inline find bar is open (mod+f while focused). */
  findFor: string | null;
  open: (opts: { cwd?: string; sessionId?: string }) => Promise<void>;
  /** Replace an exited tab with a fresh PTY in the same cwd/session/slot. */
  restart: (id: string) => Promise<void>;
  close: (id: string) => void;
  setActive: (id: string) => void;
  rename: (id: string, label: string) => void;
  setFind: (id: string | null) => void;
  /** listPtys reconciliation: mark tabs whose PTY died with the daemon. */
  reconcile: () => Promise<void>;
};

type Patch = Partial<Pick<TerminalTab, "label" | "title" | "bell" | "exited">>;

export const useTerminals = create<TerminalsStore>((set, get) => {
  const patchTab = (id: string, patch: Patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));

  /** openPty + xterm wiring; the caller decides where the tab goes. */
  const createTab = async (opts: {
    cwd?: string;
    sessionId?: string;
    label?: string | null;
  }): Promise<TerminalTab> => {
    const req: Partial<CreatePtyRequest> = {
      cols: INITIAL_PTY_COLS,
      rows: INITIAL_PTY_ROWS,
    };
    if (opts.cwd !== undefined) req.cwd = opts.cwd;
    if (opts.sessionId !== undefined) req.sessionId = opts.sessionId;
    const { ptyId, port } = await getBridge().openPty(req);

    const term = new Terminal({
      fontFamily: cssVar("--font-mono", MONO_FALLBACK),
      fontSize: 13, // design.md §2: all mono text is 13px
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: readXtermTheme(),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);

    let lastSelection = "";
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) lastSelection = sel;
    });
    term.onData((text) => {
      const buf = encoder.encode(text).buffer as ArrayBuffer;
      // BINDING (bridge.md §2): postMessage(msg) only — NEVER a transfer
      // list; Electron IPC-bridged ports throw DataCloneError on ArrayBuffer
      // transfers (pure DOM ports in the mock accept it, hiding the bug).
      port.postMessage({ type: "data", data: buf } satisfies PtyPortMessage);
    });
    term.onTitleChange((title) => patchTab(ptyId, { title: title || null }));
    term.onBell(() => {
      if (get().activeId !== ptyId) patchTab(ptyId, { bell: true });
    });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || e.altKey || !(e.metaKey || e.ctrlKey))
        return true;
      const key = e.key.toLowerCase();
      if (key === "f" && !e.shiftKey) {
        e.preventDefault();
        set({ findFor: ptyId });
        return false;
      }
      // Copy only when a selection exists — a bare ctrl+c stays SIGINT.
      if (key === "c" && !e.shiftKey) {
        const sel = term.getSelection();
        if (!sel) return true;
        e.preventDefault();
        void navigator.clipboard?.writeText(sel).catch(() => {});
        return false;
      }
      // Paste through xterm (bracketed paste) instead of the hidden textarea.
      if (key === "v" && !e.shiftKey) {
        e.preventDefault();
        void navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch(() => {});
        return false;
      }
      return true;
    });

    port.onmessage = (e: MessageEvent) => {
      const msg = e.data as PtyPortMessage;
      if (msg.type === "data") {
        // Straight to xterm — never through React state (ARCHITECTURE perf).
        term.write(new Uint8Array(msg.data));
      } else if (msg.type === "exit") {
        // The port is dead after exit: stop stdin, render the exit state.
        term.options.disableStdin = true;
        patchTab(ptyId, {
          exited: { code: msg.exitCode, reason: msg.reason ?? null },
        });
      }
    };

    return {
      id: ptyId,
      cwd: opts.cwd ?? "",
      sessionId: opts.sessionId ?? null,
      term,
      fit,
      search,
      port,
      readSelection: () => term.getSelection() || lastSelection,
      label: opts.label ?? null,
      title: null,
      bell: false,
      exited: null,
    };
  };

  const teardown = (tab: TerminalTab) => {
    try {
      tab.port.postMessage({ type: "close" } satisfies PtyPortMessage);
    } catch {
      // port already dead — nothing to tell it
    }
    tab.port.close();
  };

  return {
    tabs: [],
    activeId: null,
    findFor: null,

    open: async (opts) => {
      const tab = await createTab(opts);
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
    },

    restart: async (id) => {
      const old = get().tabs.find((t) => t.id === id);
      if (!old) return;
      const fresh = await createTab({
        ...(old.cwd ? { cwd: old.cwd } : {}),
        ...(old.sessionId ? { sessionId: old.sessionId } : {}),
        label: old.label,
      });
      const current = get().tabs.find((t) => t.id === id);
      if (!current) {
        // tab was closed while the new PTY opened — don't leak it
        teardown(fresh);
        fresh.term.dispose();
        return;
      }
      teardown(old);
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id ? fresh : t)),
        activeId: s.activeId === id ? fresh.id : s.activeId,
        findFor: s.findFor === id ? null : s.findFor,
      }));
      old.term.dispose();
    },

    close: (id) => {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return;
      teardown(tab);
      tab.term.dispose();
      set((s) => ({
        tabs: s.tabs.filter((t) => t.id !== id),
        activeId: nextActiveId(
          s.tabs.map((t) => t.id),
          s.activeId,
          id,
        ),
        findFor: s.findFor === id ? null : s.findFor,
      }));
    },

    setActive: (id) =>
      set((s) => ({
        activeId: id,
        tabs: s.tabs.some((t) => t.id === id && t.bell)
          ? s.tabs.map((t) => (t.id === id ? { ...t, bell: false } : t))
          : s.tabs,
      })),

    rename: (id, label) => patchTab(id, { label: normalizeLabel(label) }),

    setFind: (findFor) => set({ findFor }),

    reconcile: async () => {
      if (!get().tabs.some((t) => !t.exited)) return;
      let live: string[];
      try {
        live = (await getBridge().listPtys()).map((p) => p.ptyId);
      } catch {
        return; // can't tell — leave tabs alone; exit still arrives via ports
      }
      const lost = new Set(lostPtyIds(get().tabs, live));
      if (lost.size === 0) return;
      for (const tab of get().tabs) {
        if (!lost.has(tab.id)) continue;
        tab.term.options.disableStdin = true;
        tab.port.close();
      }
      set((s) => ({
        tabs: s.tabs.map((t) =>
          lost.has(t.id) && !t.exited
            ? { ...t, exited: { code: null, reason: "pty lost on reconnect" } }
            : t,
        ),
      }));
    },
  };
});

// listPtys reconciliation on reconnect: PTYs die with the daemon but the SDK
// reconnect only replays session events — ports for dead PTYs may never see
// an exit. Runs at module scope so it works even while the dock is hidden.
useConnection.subscribe((s, prev) => {
  if (s.state === "connected" && prev.state !== "connected")
    void useTerminals.getState().reconcile();
});
