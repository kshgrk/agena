import { Folder } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { FilesPane } from "./pane.tsx";

export const pane: PaneDefinition = {
  id: "files",
  title: "Files",
  icon: Folder,
  Component: FilesPane,
};
