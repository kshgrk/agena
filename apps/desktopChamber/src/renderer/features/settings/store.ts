// Settings-window view state + the deep-link entry point other features and
// the command registry use ("settings.open" with a section).
import { create } from "zustand";
import { useUi } from "../../store/index.ts";

export type SettingsSection =
  | "connection"
  | "appearance"
  | "providers"
  | "plugins"
  | "mcp"
  | "skills"
  | "import"
  | "about";

type SettingsViewStore = {
  section: SettingsSection;
  setSection: (section: SettingsSection) => void;
};

export const useSettingsView = create<SettingsViewStore>((set) => ({
  section: "connection",
  setSection: (section) => set({ section }),
}));

/** Open the settings window, optionally deep-linked to a section. */
export function openSettings(section?: SettingsSection): void {
  if (section) useSettingsView.setState({ section });
  useUi.getState().setSettingsOpen(true);
}
