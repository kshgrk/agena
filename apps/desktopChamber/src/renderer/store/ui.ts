// Cross-pane UI state: selection, jump/insert requests (nonce-retriggerable),
// theme, pane toggles, overlay counting (D-INV-3), toasts (ARCHITECTURE
// contract 4), and persisted-state read/write through the bridge.

import { create } from "zustand";
import { EMPTY_PERSISTED, type PersistedState } from "../../shared/bridge.ts";
import { useSessions } from "./sessions.ts";
import type { SourceReference } from "./source-reference.ts";
import {
  DEFAULT_THEME,
  normalizeThemePreference,
  resolveAppearance,
} from "./theme.ts";
import { getBridge, useTranscripts } from "./transcript.ts";
import type { Toast, ToastKind, TranscriptState, UiSlice } from "./types.ts";

export type UiStore = UiSlice & {
  setSelected: (selected: { sessionId: string; seq: number } | null) => void;
  requestJump: (sessionId: string, seq: number) => void;
  requestComposerInsert: (text: string, sessionId?: string) => void;
  requestComposerReference: (
    reference: SourceReference,
    sessionId: string,
  ) => void;
  requestComposerContent: (
    text: string,
    references: SourceReference[],
    sessionId: string,
  ) => void;
  /** Applies the resolved theme to the document and persists (fire-and-forget). */
  setTheme: (theme: UiSlice["theme"]) => void;
  togglePalette: () => void;
  setPaletteOpen: (open: boolean) => void;
  toggleSettings: () => void;
  setSettingsOpen: (open: boolean) => void;
  toggleInspector: () => void;
  setInspectorOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
  toggleBrowser: () => void;
  setBrowserOpen: (open: boolean) => void;
  enterOverlay: () => void;
  exitOverlay: () => void;
  dismissToast: (id: number) => void;
};

export const uiInitial: UiSlice = {
  selected: null,
  jump: null,
  composerInsert: null,
  theme: DEFAULT_THEME,
  paletteOpen: false,
  settingsOpen: false,
  inspectorOpen: false,
  terminalOpen: false,
  browserOpen: false,
  overlayCount: 0,
  toasts: [],
};

/** The one signal the browser host hides the native view on (D-INV-3). */
export const hasOverlay = (s: UiSlice): boolean =>
  s.paletteOpen || s.overlayCount > 0;

// ---- theme --------------------------------------------------------------------

/** The family stays stable while "system" resolves through the OS appearance. */
export function applyThemeToDocument(theme: UiSlice["theme"]): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme.family;
  document.documentElement.dataset.appearance =
    theme.appearance === "dim" ? "dim" : resolveAppearance(theme.appearance);
}

let nonce = 0; // monotonically increasing so repeated requests re-trigger
let toastId = 0;

const TOAST_MS = 4000;
const TOAST_EXIT_MS = 140; // design.md §14: toast exit fade 140ms

export const useUi = create<UiStore>((set, get) => ({
  ...uiInitial,
  setSelected: (selected) => set({ selected }),
  requestJump: (sessionId, seq) =>
    set({ jump: { sessionId, seq, nonce: ++nonce } }),
  requestComposerInsert: (text, sessionId) =>
    set({
      composerInsert: {
        text,
        ...(sessionId ? { sessionId } : {}),
        nonce: ++nonce,
      },
    }),
  requestComposerReference: (reference, sessionId) =>
    set({
      composerInsert: { references: [reference], sessionId, nonce: ++nonce },
    }),
  requestComposerContent: (text, references, sessionId) =>
    set({ composerInsert: { text, references, sessionId, nonce: ++nonce } }),
  setTheme: (theme) => {
    const normalized = normalizeThemePreference(theme);
    applyThemeToDocument(normalized);
    set({ theme: normalized });
    savePersistedPatch({ prefs: { theme: normalized } });
  },
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setTerminalOpen: (terminalOpen) => set({ terminalOpen }),
  toggleBrowser: () => set((s) => ({ browserOpen: !s.browserOpen })),
  setBrowserOpen: (browserOpen) => set({ browserOpen }),
  enterOverlay: () => set((s) => ({ overlayCount: s.overlayCount + 1 })),
  exitOverlay: () =>
    set((s) => ({ overlayCount: Math.max(0, s.overlayCount - 1) })),
  // two-phase dismiss: mark closing (view plays the 140ms exit fade), then drop
  dismissToast: (id) => {
    const t = get().toasts.find((x) => x.id === id);
    if (!t || t.closing) return;
    set((s) => ({
      toasts: s.toasts.map((x) => (x.id === id ? { ...x, closing: true } : x)),
    }));
    setTimeout(
      () => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
      TOAST_EXIT_MS,
    );
  },
}));

/** Fire-and-forget toast; auto-dismisses after 4s. Features never render their
 * own floating notifications (ARCHITECTURE cross-feature contract 4). */
export function pushToast(input: {
  kind: ToastKind;
  title: string;
  detail?: string;
}): void {
  const t: Toast = { id: ++toastId, ...input };
  useUi.setState((s) => ({ toasts: [...s.toasts, t] }));
  setTimeout(() => useUi.getState().dismissToast(t.id), TOAST_MS);
}

// ---- persisted state (bridge-backed) --------------------------------------------

/** Full persisted state; missing bridge / failed read → EMPTY_PERSISTED. */
export async function loadPersistedState(): Promise<PersistedState> {
  try {
    const bridge = getBridge();
    if (!bridge) return EMPTY_PERSISTED;
    return await bridge.loadPersisted();
  } catch {
    return EMPTY_PERSISTED;
  }
}

/**
 * Fire-and-forget shallow top-level merge. savePersisted replaces WHOLE
 * top-level records — callers must pass complete `cursors`/`drafts` maps,
 * never a single-entry patch (that would wipe every sibling key).
 */
export function savePersistedPatch(patch: Partial<PersistedState>): void {
  void getBridge()
    ?.savePersisted(patch)
    .catch(() => {});
}

// Mirror of the on-disk cursors record. savePersisted({ cursors }) replaces
// the WHOLE record, and this run only loads a few sessions' transcripts — so
// every write must be seeded from what disk already holds, or sessions not
// opened this run would lose their cursors (unbounded replay next open).
let diskCursors: Record<string, { branchId: string; seq: number }> = {};

/** Seed theme (and document attribute) + cursor mirror from disk without
 * re-persisting. */
export function hydrateUiFromPersisted(persisted: PersistedState): void {
  diskCursors = { ...persisted.cursors };
  const theme = normalizeThemePreference(persisted.prefs.theme);
  useUi.setState({ theme });
  applyThemeToDocument(theme);
}

/**
 * The FULL cursor record for savePersisted({ cursors }): the on-disk record
 * (`base`) with sessions the daemon lost deleted, overlaid with every session
 * we have durably applied events for this run.
 */
export function buildCursorRecord(
  bySession: Readonly<Record<string, TranscriptState>>,
  lost: readonly string[],
  base: Readonly<Record<string, { branchId: string; seq: number }>> = {},
): Record<string, { branchId: string; seq: number }> {
  const cursors: Record<string, { branchId: string; seq: number }> = {
    ...base,
  };
  const lostSet = new Set(lost);
  for (const sessionId of lostSet) delete cursors[sessionId];
  for (const [sessionId, t] of Object.entries(bySession)) {
    if (t.lastSeq <= 0 || lostSet.has(sessionId)) continue;
    cursors[sessionId] = { branchId: t.branchId ?? "", seq: t.lastSeq };
  }
  return cursors;
}

const CURSOR_DEBOUNCE_MS = 800;
let cursorTimer: ReturnType<typeof setTimeout> | null = null;
let lastCursorWrite = "";

/** Write the full cursor record now (skips when unchanged since last write). */
export function persistCursorsNow(): void {
  cursorTimer = null;
  const cursors = buildCursorRecord(
    useTranscripts.getState().bySession,
    useSessions.getState().lost,
    diskCursors,
  );
  const key = JSON.stringify(cursors);
  if (key === lastCursorWrite) return;
  lastCursorWrite = key;
  diskCursors = cursors;
  savePersistedPatch({ cursors });
}

/** Debounced full-record cursor write (losing it only costs a fuller replay). */
export function schedulePersistCursors(): void {
  if (cursorTimer !== null) return;
  cursorTimer = setTimeout(persistCursorsNow, CURSOR_DEBOUNCE_MS);
}
