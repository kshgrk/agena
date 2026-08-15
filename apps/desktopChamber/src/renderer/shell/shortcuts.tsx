// Renderless global shortcut host: registers the shell-owned commands and owns
// THE single window-level capture-phase keydown listener, driven entirely by
// the command registry (ARCHITECTURE contract 2). Rules ported from the old
// GlobalHotkeys: skip repeats/handled keys; shortcuts without `mod` never fire
// from editable targets; first matching registered command wins.
import { useEffect } from "react";
import {
  commandForShortcut,
  registerCommands,
  runCommand,
  useUi,
} from "../store/index.ts";
import { useShellUi } from "./panes.ts";

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("input, textarea, [contenteditable], .xterm") !== null
  );
}

export function GlobalShortcuts() {
  useEffect(() => {
    const unregister = registerCommands([
      {
        id: "palette.toggle",
        title: "Toggle Command Palette",
        group: "View",
        shortcut: "mod+k",
        run: () => useUi.getState().togglePalette(),
      },
      {
        id: "settings.toggle",
        title: "Toggle Settings",
        group: "View",
        shortcut: "mod+,",
        run: () => useUi.getState().toggleSettings(),
      },
      {
        id: "inspector.toggle",
        title: "Toggle Inspector",
        group: "View",
        shortcut: "mod+i",
        run: () => useUi.getState().toggleInspector(),
      },
      {
        id: "terminal.toggle",
        title: "Toggle Terminal",
        group: "View",
        shortcut: "mod+j",
        run: () => useUi.getState().toggleTerminal(),
      },
      {
        id: "sidebar.toggle",
        title: "Toggle Sidebar",
        group: "View",
        shortcut: "mod+b",
        run: () => useShellUi.getState().toggleSidebar(),
      },
      {
        id: "theme.toggle",
        title: "Toggle Theme",
        group: "View",
        keywords: ["dark", "light"],
        run: () => {
          const ui = useUi.getState();
          ui.setTheme({
            ...ui.theme,
            appearance: ui.theme.appearance === "light" ? "dark" : "light",
          });
        },
      },
      // session.new (mod+n, the new-session dialog) is owned by the
      // always-mounted SessionsRail — registering it here too would shadow
      // the dialog with a silent direct-create depending on mount order.
    ]);

    const onKeydown = (e: KeyboardEvent) => {
      if (e.repeat || e.defaultPrevented) return;
      const cmd = commandForShortcut(e);
      if (!cmd) return;
      // plain-key shortcuts must not steal typing from inputs/terminals
      if (!cmd.shortcut?.includes("mod") && isEditableTarget(e.target)) return;
      if (cmd.when && !cmd.when()) return;
      e.preventDefault();
      e.stopPropagation();
      runCommand(cmd.id);
    };
    window.addEventListener("keydown", onKeydown, true);
    return () => {
      unregister();
      window.removeEventListener("keydown", onKeydown, true);
    };
  }, []);
  return null;
}
