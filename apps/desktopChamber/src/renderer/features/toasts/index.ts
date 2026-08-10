import { Bell } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { ToastsHost } from "./pane.tsx";

export const pane: PaneDefinition = {
  id: "toasts",
  title: "Notifications",
  icon: Bell,
  Component: ToastsHost,
};
