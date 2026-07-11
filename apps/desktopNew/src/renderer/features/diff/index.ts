import { FileDiff } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { DiffPane } from "./pane.tsx";

export const pane: PaneDefinition = {
  id: "diff",
  title: "Diff",
  icon: FileDiff,
  Component: DiffPane,
};
