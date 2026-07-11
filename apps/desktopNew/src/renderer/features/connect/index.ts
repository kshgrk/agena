import { Plug } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { ConnectPane } from "./pane.tsx";

export const pane: PaneDefinition = {
  id: "connect",
  title: "Connect",
  icon: Plug,
  Component: ConnectPane,
};
