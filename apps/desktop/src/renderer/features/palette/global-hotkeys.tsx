// Global keyboard dispatch (plan §7.8): every chord routes through the command
// registry; this component registers the base commands and owns the one
// window-level keydown listener.
import { useEffect } from "react";
import {
  type CommandDef,
  chordMatches,
  useCommands,
} from "../../store/commands.ts";
import { useUi } from "../../store/index.ts";

const BASE_COMMANDS: CommandDef[] = [
  {
    id: "palette.toggle",
    title: "Toggle Command Palette",
    group: "View",
    chord: "mod+k",
    keywords: ["cmdk", "commands", "actions"],
    run: () => useUi.getState().togglePalette(),
  },
  {
    id: "settings.toggle",
    title: "Toggle Settings",
    group: "View",
    chord: "mod+,",
    keywords: ["preferences", "import", "options"],
    run: () => useUi.getState().toggleSettings(),
  },
  {
    id: "inspector.toggle",
    title: "Toggle Inspector",
    group: "View",
    chord: "mod+i",
    keywords: ["events", "raw", "timeline", "panel"],
    run: () => useUi.getState().toggleInspector(),
  },
  {
    id: "terminal.toggle",
    title: "Toggle Terminal",
    group: "View",
    chord: "mod+j",
    keywords: ["dock", "pty", "shell", "console"],
    run: () => useUi.getState().toggleTerminal(),
  },
  {
    id: "theme.toggle",
    title: "Toggle Theme",
    group: "View",
    keywords: ["dark", "light", "appearance", "color"],
    run: () => {
      const ui = useUi.getState();
      ui.setTheme(ui.theme === "dark" ? "light" : "dark");
    },
  },
  {
    id: "search.open",
    title: "Search Transcripts",
    group: "Search",
    chord: "mod+shift+f",
    keywords: ["find", "grep", "sessions"],
    run: () => window.dispatchEvent(new CustomEvent("agena:open-search")),
  },
];

/** True when the key press belongs to a text surface or a terminal. */
function isEditableTarget(e: KeyboardEvent): boolean {
  return (
    e.target instanceof Element &&
    e.target.closest("input, textarea, [contenteditable], .xterm") !== null
  );
}

/** Renderless: mount once in the app shell. */
export function GlobalHotkeys() {
  useEffect(() => useCommands.getState().register(BASE_COMMANDS), []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.defaultPrevented) return;
      for (const cmd of Object.values(useCommands.getState().byId)) {
        if (!cmd.chord || !chordMatches(cmd.chord, e)) continue;
        // Plain chords stay out of inputs/terminals; mod chords always fire.
        if (!cmd.chord.includes("mod") && isEditableTarget(e)) continue;
        e.preventDefault();
        e.stopPropagation();
        useCommands.getState().run(cmd.id);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return null;
}
