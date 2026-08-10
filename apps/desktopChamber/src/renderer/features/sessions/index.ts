import { PanelLeft } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { SessionsRail } from "./sessions-rail.tsx";

export const pane: PaneDefinition = {
  id: "sessions",
  title: "Sessions",
  icon: PanelLeft,
  Component: SessionsRail,
};
