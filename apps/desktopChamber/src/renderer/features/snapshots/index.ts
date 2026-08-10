import { Camera } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { SnapshotsPane } from "./pane.tsx";

export const pane: PaneDefinition = {
  id: "snapshots",
  title: "Snapshots",
  icon: Camera,
  Component: SnapshotsPane,
};
