import { PenLine } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { ComposerPane } from "./pane.tsx";

export const pane: PaneDefinition = {
  id: "composer",
  title: "Composer",
  icon: PenLine,
  Component: ComposerPane,
};
