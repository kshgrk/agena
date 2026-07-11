import { Search } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { SearchPane } from "./pane.tsx";

export const pane: PaneDefinition = {
  id: "search",
  title: "Search",
  icon: Search,
  Component: SearchPane,
};
