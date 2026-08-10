// Pane contract (ARCHITECTURE contract 1): the shell composes the bottom dock
// from this definition only.
import { Terminal } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { TerminalDock } from "./terminal-dock.tsx";

export const pane: PaneDefinition = {
  id: "terminal",
  title: "Terminal",
  icon: Terminal,
  Component: TerminalDock,
};
