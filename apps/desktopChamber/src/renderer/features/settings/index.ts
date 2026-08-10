// Settings feature entry: pane definition (mounted always by the shell as an
// overlay host) + commands registered at module init (ARCHITECTURE contract 2).
// `settings.open` deep-links to a section via openSettings(section).
import { Settings } from "lucide-react";
import type { PaneDefinition } from "../../shell/panes.ts";
import { registerCommands } from "../../store/index.ts";
import { openSettings } from "./store.ts";
import { SettingsWindow } from "./window.tsx";

export {
  openSettings,
  type SettingsSection,
  useSettingsView,
} from "./store.ts";

export const pane: PaneDefinition = {
  id: "settings",
  title: "Settings",
  icon: Settings,
  Component: SettingsWindow,
};

registerCommands([
  {
    id: "settings.open",
    title: "Open Settings",
    group: "Settings",
    keywords: ["preferences", "config"],
    run: () => openSettings(),
  },
  {
    id: "settings.open.connection",
    title: "Settings: Connection & Diagnostics",
    group: "Settings",
    keywords: ["daemon", "profile", "theme", "diagnostics"],
    run: () => openSettings("connection"),
  },
  {
    id: "settings.open.providers",
    title: "Settings: Providers",
    group: "Settings",
    keywords: ["models", "api key", "oauth", "subscription"],
    run: () => openSettings("providers"),
  },
  {
    id: "settings.open.plugins",
    title: "Settings: Plugins",
    group: "Settings",
    keywords: [
      "plugins",
      "integrations",
      "extensions",
      "skills",
      "mcp",
      "marketplace",
    ],
    run: () => openSettings("plugins"),
  },
  {
    id: "settings.open.mcp",
    title: "Settings: MCP Servers",
    group: "Settings",
    keywords: ["mcp", "model context protocol", "import", "oauth"],
    run: () => openSettings("mcp"),
  },
  {
    id: "settings.open.skills",
    title: "Settings: Skills",
    group: "Settings",
    keywords: ["skill", "import", "update"],
    run: () => openSettings("skills"),
  },
  {
    id: "settings.open.import",
    title: "Settings: Session Import",
    group: "Settings",
    keywords: ["claude", "codex", "pi", "sessions", "migrate"],
    run: () => openSettings("import"),
  },
  {
    id: "settings.open.about",
    title: "Settings: About",
    group: "Settings",
    keywords: ["version", "daemon"],
    run: () => openSettings("about"),
  },
]);
