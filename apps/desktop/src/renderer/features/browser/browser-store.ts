// Renderer mirror of the native browser's BrowserState (bridge.onBrowserState),
// plus the editable URL-bar text and thin action wrappers over the bridge. The
// native WebContentsView is owned by main; this store is only the toolbar's view
// of it. Init subscribes once and registers the browser commands.
import { create } from "zustand";
import type {
  BrowserNavAction,
  BrowserOpenOptions,
  BrowserState,
} from "../../../shared/bridge.ts";
import { peekBridge } from "../../lib/bridge.ts";
import { useCommands } from "../../store/commands.ts";
import { useUi } from "../../store/ui.ts";

type BrowserStore = BrowserState & {
  /** URL-bar text: re-synced from state.url on navigation, locally editable. */
  address: string;
  /** Bumped by the "browser.open" command so the pane focuses its URL bar. */
  focusNonce: number;
  setAddress: (address: string) => void;
  requestAddressFocus: () => void;
  open: (url: string, opts?: BrowserOpenOptions) => void;
  navigate: (action: BrowserNavAction) => void;
  openDevTools: () => void;
  popOut: () => void;
  close: () => void;
};

const initial: BrowserState & { address: string; focusNonce: number } = {
  url: null,
  title: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  poppedOut: false,
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
  popOut: () => {
    void peekBridge()?.browserPopOut();
  },
  close: () => {
    useUi.getState().setBrowserOpen(false);
    void peekBridge()?.browserClose();
  },
}));

let unsub: (() => void) | null = null;

/** Idempotent: subscribe to the native state stream and register commands. */
export function initBrowserStore(): void {
  if (unsub) return;
  unsub = () => {}; // claim the slot before any await-free path re-enters
  const bridge = peekBridge();
  if (bridge && typeof bridge.onBrowserState === "function") {
    // Only re-sync the URL bar when the page URL actually changes, so a
    // loading/title-only push doesn't clobber what the user is typing.
    unsub = bridge.onBrowserState((state) =>
      useBrowser.setState((s) => ({
        ...state,
        address: state.url !== s.url ? (state.url ?? "") : s.address,
      })),
    );
  }
  useCommands.getState().register([
    {
      id: "browser.toggle",
      title: "Toggle Browser",
      group: "Browser",
      chord: "mod+shift+b",
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
