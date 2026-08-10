// The shell's cross-feature contract (ARCHITECTURE contract 1): every feature
// directory exports `pane: PaneDefinition` from its index.ts; the shell
// composes the dockview layout, the sidebar, and the overlay hosts from those
// definitions only. This module stays pure/node-safe (plus one tiny zustand
// store) so it can be tested without a DOM.

import type { UsageTotals } from "@agena/protocol";
import type { SerializedDockview } from "dockview";
import type { LucideIcon } from "lucide-react";
import type { FC } from "react";
import { create } from "zustand";
import type { Block } from "../store/types.ts";

export type PaneDefinition = {
  /** Stable pane id — doubles as the dockview panel/component id. */
  id: string;
  /** Tab / palette label. */
  title: string;
  icon: LucideIcon;
  /** Rendered inside a dockview panel, the sidebar, or as an overlay host. */
  Component: FC;
};

// ---- window-level cross-feature events (shell-owned names) -------------------

/** detail: { approvalId } — approvals feature opens its modal, switching session. */
export const OPEN_APPROVAL_EVENT = "agena:open-approval";
/** Re-fired by the shell after the search pane is revealed so it can focus. */
export const OPEN_SEARCH_EVENT = "agena:open-search";

// ---- persisted layout blob ---------------------------------------------------

/** Bump to discard persisted layouts whose defaults no longer apply. */
export const LAYOUT_VERSION = 4;

export type SavedLayout = {
  dock: SerializedDockview | null;
  sidebarCollapsed: boolean;
};

/**
 * Parse the opaque `PersistedState.layout` blob. Anything unexpected (older
 * version, garbage, null) → null and the default layout is built instead.
 */
export function parseSavedLayout(raw: unknown): SavedLayout | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { v?: unknown; dock?: unknown; sidebarCollapsed?: unknown };
  if (r.v !== LAYOUT_VERSION) return null;
  return {
    dock:
      typeof r.dock === "object" && r.dock !== null
        ? (r.dock as SerializedDockview)
        : null,
    sidebarCollapsed: r.sidebarCollapsed === true,
  };
}

/** The blob written back through savePersisted({ layout }). */
export function buildSavedLayout(
  dock: SerializedDockview,
  sidebarCollapsed: boolean,
): SavedLayout & { v: number } {
  return { v: LAYOUT_VERSION, dock, sidebarCollapsed };
}

// ---- statusbar helpers (pure) --------------------------------------------------

/** Token usage of the most recent assistant block that reported any. */
export function latestUsage(
  blocks: readonly Block[] | undefined,
): UsageTotals | undefined {
  if (!blocks) return undefined;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b?.kind === "assistant" && b.usage) return b.usage;
  }
  return undefined;
}

// ---- shell-local view state ------------------------------------------------------

/** Sidebar collapse lives outside store/ui (that slice is foundation-owned);
 * persisted inside the layout blob. */
export type ShellUiStore = {
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
};

export const useShellUi = create<ShellUiStore>((set) => ({
  sidebarCollapsed: false,
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));
