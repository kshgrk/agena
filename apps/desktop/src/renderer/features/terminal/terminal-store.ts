// Terminal dock state (plan §7.9). Terminal/port lifecycles live HERE, not in
// React effects: tabs (and their xterm instances) survive dock unmount/remount
// and StrictMode double-mounting; everything is disposed on close().
import type { CreatePtyRequest } from "@agena/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { type ITheme, Terminal } from "@xterm/xterm";
import { create } from "zustand";
import type { PtyPortMessage } from "../../../shared/bridge.ts";
import { getBridge } from "../../lib/bridge.ts";

const encoder = new TextEncoder();
const INITIAL_PTY_COLS = 80;
const INITIAL_PTY_ROWS = 24;

const MONO_FALLBACK =
  'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

function cssVar(name: string, fallback: string): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  );
}

/** xterm theme from the design tokens (re-read on data-theme mutation). */
export function readXtermTheme(): ITheme {
  const bg = cssVar("--surface", "#12141b");
  const accent = cssVar("--accent", "#8f8ff7");
  return {
    background: bg,
    foreground: cssVar("--ink", "#e6e9f2"),
    cursor: accent,
    cursorAccent: bg,
    // 30% alpha when the token is #rrggbb; otherwise use it as-is.
    selectionBackground: /^#[0-9a-f]{6}$/i.test(accent)
      ? `${accent}4d`
      : accent,
  };
}

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
  /** Custom rename; null → derive from cwd tail. */
  label: string | null;
  /** null while running. */
  exited: { code: number | null; reason: string | null } | null;
};

export type TerminalsStore = {
  tabs: readonly TerminalTab[];
  activeId: string | null;
  /** Tab id whose inline find bar is open (mod+f while focused). */
  findFor: string | null;
  open: (opts: { cwd?: string; sessionId?: string }) => Promise<void>;
  close: (id: string) => void;
  setActive: (id: string) => void;
  rename: (id: string, label: string) => void;
  setFind: (id: string | null) => void;
};

export const useTerminals = create<TerminalsStore>((set, get) => ({
  tabs: [],
  activeId: null,
  findFor: null,

  open: async (opts) => {
    const req: Partial<CreatePtyRequest> = {
      cols: INITIAL_PTY_COLS,
      rows: INITIAL_PTY_ROWS,
    };
    if (opts.cwd !== undefined) req.cwd = opts.cwd;
    if (opts.sessionId !== undefined) req.sessionId = opts.sessionId;
    const { ptyId, port } = await getBridge().openPty(req);

    const term = new Terminal({
      fontFamily: cssVar("--font-mono", MONO_FALLBACK),
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
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
      // no transfer list: Electron IPC MessagePorts clone-only (see contract)
      port.postMessage({ type: "data", data: buf } satisfies PtyPortMessage);
    });
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        e.key.toLowerCase() === "f" &&
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        set({ findFor: ptyId });
        return false;
      }
      return true;
    });

    port.onmessage = (e: MessageEvent) => {
      const msg = e.data as PtyPortMessage;
      if (msg.type === "data") {
        term.write(new Uint8Array(msg.data));
      } else if (msg.type === "exit") {
        term.options.disableStdin = true;
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === ptyId
              ? {
                  ...t,
                  exited: { code: msg.exitCode, reason: msg.reason ?? null },
                }
              : t,
          ),
        }));
      }
    };

    const tab: TerminalTab = {
      id: ptyId,
      cwd: opts.cwd ?? "",
      sessionId: opts.sessionId ?? null,
      term,
      fit,
      search,
      port,
      readSelection: () => term.getSelection() || lastSelection,
      label: null,
      exited: null,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeId: ptyId }));
  },

  close: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    try {
      tab.port.postMessage({ type: "close" } satisfies PtyPortMessage);
    } catch {
      // port already dead — nothing to tell it
    }
    tab.port.close();
    tab.term.dispose();
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeId =
        s.activeId === id
          ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null)
          : s.activeId;
      return { tabs, activeId, findFor: s.findFor === id ? null : s.findFor };
    });
  },

  setActive: (id) => set({ activeId: id }),

  rename: (id, label) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, label: label.trim() || null } : t,
      ),
    })),

  setFind: (findFor) => set({ findFor }),
}));
