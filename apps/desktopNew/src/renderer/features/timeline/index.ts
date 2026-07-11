import { History } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { TimelinePane } from "./pane.tsx";

export const pane: PaneDefinition = {
  id: "timeline",
  title: "Timeline",
  icon: History,
  Component: TimelinePane,
};
