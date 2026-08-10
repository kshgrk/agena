// Cross-feature command registry (ARCHITECTURE contract 2): the single owner
// of every action. The palette, menus, and keyboard shortcuts are all
// projections of this — nobody imports a feature to invoke another feature.
import { create } from "zustand";

export type Command = {
  id: string;
  title: string;
  group: string;
  /** e.g. "mod+n" (mod = ⌘ on mac, ctrl elsewhere), "mod+shift+f", "escape". */
  shortcut?: string;
  /** Extra palette match terms. */
  keywords?: string[];
  /** Disabled (dimmed in the palette, shortcut inert) when this returns false. */
  when?: () => boolean;
  run: () => void | Promise<void>;
};

type CommandsStore = {
  byId: Readonly<Record<string, Command>>;
  register: (defs: Command[]) => () => void;
  run: (id: string) => void;
};

export const useCommands = create<CommandsStore>((set, get) => ({
  byId: {},
  register: (defs) => {
    // Shadowed defs are restored on unregister so two owners of the same id
    // (e.g. terminal.toggle in GlobalHotkeys and TerminalDock) compose safely.
    const shadowed: Record<string, Command | undefined> = {};
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
    if (cmd && (cmd.when?.() ?? true)) void cmd.run();
  },
}));

/** Register commands at module/mount time; returns the unregister function. */
export function registerCommands(cmds: Command[]): () => void {
  return useCommands.getState().register(cmds);
}

/** Run a command by id (respects `when`). */
export function runCommand(id: string): void {
  useCommands.getState().run(id);
}

/** Palette order: group, then title. */
export function allCommands(
  byId: Readonly<Record<string, Command>>,
): Command[] {
  return Object.values(byId).sort(
    (a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title),
  );
}

const IS_MAC =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

/** "mod+shift+f" → matches a KeyboardEvent. Single source for shortcut handling.
 * A shortcut without `mod` requires meta AND ctrl to be up. */
export function shortcutMatches(shortcut: string, e: KeyboardEvent): boolean {
  const parts = shortcut.toLowerCase().split("+");
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

/** First registered command whose shortcut matches the event (shell keydown). */
export function commandForShortcut(
  e: KeyboardEvent,
  byId: Readonly<Record<string, Command>> = useCommands.getState().byId,
): Command | null {
  for (const cmd of Object.values(byId)) {
    if (cmd.shortcut && shortcutMatches(cmd.shortcut, e)) return cmd;
  }
  return null;
}

/** "mod+shift+f" → "⌘⇧F" on mac, "Ctrl+Shift+F" elsewhere. */
export function shortcutLabel(shortcut: string): string {
  return shortcut
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
