import { create } from "zustand";
import type {
  BrowserNavAction,
  BrowserOpenOptions,
  BrowserState,
} from "../../../shared/bridge.ts";
import { peekBridge } from "../../lib/bridge.ts";
import { registerCommands } from "../../store/commands.ts";
import { useUi } from "../../store/ui.ts";

type BrowserStore = BrowserState & {
  address: string;
  focusNonce: number;
  setAddress: (address: string) => void;
  requestAddressFocus: () => void;
  open: (url: string, opts?: BrowserOpenOptions) => void;
  navigate: (action: BrowserNavAction) => void;
  openDevTools: () => void;
  openExternal: () => void;
  close: () => void;
};

const initial: BrowserState & { address: string; focusNonce: number } = {
  url: null,
  title: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  address: "",
  focusNonce: 0,
};

export const useBrowser = create<BrowserStore>((set) => ({
  ...initial,
  setAddress: (address) => set({ address }),
  requestAddressFocus: () => set((s) => ({ focusNonce: s.focusNonce + 1 })),
  open: (url, opts) => {
    set({ address: url });
    void peekBridge()?.browserOpen(url, opts);
  },
  navigate: (action) => {
    void peekBridge()?.browserNavigate(action);
  },
  openDevTools: () => {
    void peekBridge()?.browserOpenDevTools();
  },
  openExternal: () => {
    void peekBridge()?.browserOpenExternal();
  },
  close: () => {
    useUi.getState().setBrowserOpen(false);
    void peekBridge()?.browserClose();
  },
}));

let initialized = false;

/** Subscribe once for the renderer lifetime and register the browser commands. */
export function initBrowserStore(): void {
  if (initialized) return;
  initialized = true;
  const bridge = peekBridge();
  bridge?.onBrowserState((state) => {
    useBrowser.setState((current) => ({
      ...state,
      address: state.url !== current.url ? (state.url ?? "") : current.address,
    }));
    // Model-triggered visible_browser calls originate in main, so their state
    // event is the renderer's signal to create and size the browser dock.
    if (state.url) useUi.getState().setBrowserOpen(true);
  });
  registerCommands([
    {
      id: "browser.toggle",
      title: "Toggle Browser",
      group: "Browser",
      shortcut: "mod+shift+b",
      keywords: ["web", "preview", "url", "dock"],
      run: () => useUi.getState().toggleBrowser(),
    },
    {
      id: "browser.open",
      title: "Open URL in Browser",
      group: "Browser",
      keywords: ["web", "navigate", "address", "go"],
      run: () => {
        useUi.getState().setBrowserOpen(true);
        useBrowser.getState().requestAddressFocus();
      },
    },
  ]);
}
