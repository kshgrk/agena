import { Command } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { CommandPalette } from "./pane.tsx";

export const pane: PaneDefinition = {
  id: "palette",
  title: "Command Palette",
  icon: Command,
  Component: CommandPalette,
};
