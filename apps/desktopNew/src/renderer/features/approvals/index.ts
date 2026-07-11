import { ShieldAlert } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { ApprovalsHost } from "./pane.tsx";

export const pane: PaneDefinition = {
  id: "approvals",
  title: "Approvals",
  icon: ShieldAlert,
  Component: ApprovalsHost,
};
