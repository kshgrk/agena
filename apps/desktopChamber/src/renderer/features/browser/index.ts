import { Globe } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { BrowserPane } from "./pane.tsx";

export const pane: PaneDefinition = {
  id: "browser",
  title: "Browser",
  icon: Globe,
  Component: BrowserPane,
};

export { initBrowserStore, useBrowser } from "./store.ts";
export { normalizeBrowserUrl, openInAppBrowser } from "./url.ts";
