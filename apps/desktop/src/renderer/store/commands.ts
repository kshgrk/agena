// Command registry (desktop_plan.md §7.8): the single owner of every action.
// The palette, native menu, and keyboard chords are all projections of this.
import { create } from "zustand";

export type CommandDef = {
  id: string;
  title: string;
  group: string;
  /** e.g. "mod+n" (mod = ⌘ on mac, ctrl elsewhere), "mod+shift+f", "escape". */
  chord?: string;
  keywords?: string[];
  enabled?: () => boolean;
  run: () => void | Promise<void>;
};

type CommandsStore = {
  byId: Record<string, CommandDef>;
  register: (defs: CommandDef[]) => () => void;
  run: (id: string) => void;
};

export const useCommands = create<CommandsStore>((set, get) => ({
  byId: {},
  register: (defs) => {
    // Shadowed defs are restored on unregister so two owners of the same id
    // (e.g. terminal.toggle in GlobalHotkeys and TerminalDock) compose safely.
    const shadowed: Record<string, CommandDef | undefined> = {};
    set((s) => {
      const byId = { ...s.byId };
      for (const d of defs) {
        shadowed[d.id] = byId[d.id];
        byId[d.id] = d;
      }
      return { byId };
    });
    return () => {
      set((s) => {
        const byId = { ...s.byId };
        for (const d of defs) {
          const prev = shadowed[d.id];
          if (prev) byId[d.id] = prev;
          else delete byId[d.id];
        }
        return { byId };
      });
    };
  },
  run: (id) => {
    const cmd = get().byId[id];
    if (cmd && (cmd.enabled?.() ?? true)) void cmd.run();
  },
}));

export function allCommands(byId: Record<string, CommandDef>): CommandDef[] {
  return Object.values(byId).sort(
    (a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title),
  );
}

const IS_MAC =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

/** "mod+shift+f" → matches a KeyboardEvent. Single source for chord handling. */
export function chordMatches(chord: string, e: KeyboardEvent): boolean {
  const parts = chord.toLowerCase().split("+");
  const key = parts[parts.length - 1] ?? "";
  const mods = new Set(parts.slice(0, -1));
  const wantMod = mods.has("mod");
  const modOk = wantMod
    ? IS_MAC
      ? e.metaKey
      : e.ctrlKey
    : !(e.metaKey || e.ctrlKey);
  if (!modOk) return false;
  if (mods.has("shift") !== e.shiftKey) return false;
  if (mods.has("alt") !== e.altKey) return false;
  return e.key.toLowerCase() === key;
}

export function chordLabel(chord: string): string {
  return chord
    .split("+")
    .map((p) =>
      p === "mod"
        ? IS_MAC
          ? "⌘"
          : "Ctrl"
        : p === "shift"
          ? "⇧"
          : p === "alt"
            ? IS_MAC
              ? "⌥"
              : "Alt"
            : p === "escape"
              ? "Esc"
              : p.length === 1
                ? p.toUpperCase()
                : p[0]?.toUpperCase() + p.slice(1),
    )
    .join(IS_MAC ? "" : "+");
}
