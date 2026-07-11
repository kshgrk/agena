import { Braces } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { InspectorPane } from "./pane.tsx";

export const pane: PaneDefinition = {
  id: "inspector",
  title: "Inspector",
  icon: Braces,
  Component: InspectorPane,
};
