import { MessageSquare } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { TranscriptPane } from "./pane.tsx";

export const pane: PaneDefinition = {
  id: "transcript",
  title: "Session",
  icon: MessageSquare,
  Component: TranscriptPane,
};
