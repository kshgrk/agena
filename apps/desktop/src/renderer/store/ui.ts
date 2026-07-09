// Cross-pane UI state: selection, jump/insert requests (nonce-retriggerable),
// theme, pane toggles (plan §7).
import { create } from "zustand";
import { getBridge } from "./transcript.ts";
import type { UiSlice } from "./types.ts";

export type UiStore = UiSlice & {
  setSelected: (selected: { sessionId: string; seq: number } | null) => void;
  requestJump: (sessionId: string, seq: number) => void;
  requestComposerInsert: (text: string) => void;
  /** Applies documentElement.dataset.theme and persists (fire-and-forget). */
  setTheme: (theme: UiSlice["theme"]) => void;
  togglePalette: () => void;
  setPaletteOpen: (open: boolean) => void;
  toggleInspector: () => void;
  setInspectorOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
  toggleBrowser: () => void;
  setBrowserOpen: (open: boolean) => void;
  enterOverlay: () => void;
  exitOverlay: () => void;
};

export const uiInitial: UiSlice = {
  selected: null,
  jump: null,
  composerInsert: null,
  theme: "dark",
  paletteOpen: false,
  inspectorOpen: false,
  terminalOpen: false,
  browserOpen: false,
  overlayCount: 0,
};

/** The one signal the browser host hides the native view on (D-INV-3). */
export const hasOverlay = (s: UiSlice): boolean =>
  s.paletteOpen || s.overlayCount > 0;

let nonce = 0; // monotonically increasing so repeated requests re-trigger

export const useUi = create<UiStore>((set) => ({
  ...uiInitial,
  setSelected: (selected) => set({ selected }),
  requestJump: (sessionId, seq) =>
    set({ jump: { sessionId, seq, nonce: ++nonce } }),
  requestComposerInsert: (text) =>
    set({ composerInsert: { text, nonce: ++nonce } }),
  setTheme: (theme) => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = theme;
    }
    set({ theme });
    void getBridge()
      ?.savePersisted({ prefs: { theme } })
      .catch(() => {});
  },
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setTerminalOpen: (terminalOpen) => set({ terminalOpen }),
  toggleBrowser: () => set((s) => ({ browserOpen: !s.browserOpen })),
  setBrowserOpen: (browserOpen) => set({ browserOpen }),
  enterOverlay: () => set((s) => ({ overlayCount: s.overlayCount + 1 })),
  exitOverlay: () =>
    set((s) => ({ overlayCount: Math.max(0, s.overlayCount - 1) })),
}));
