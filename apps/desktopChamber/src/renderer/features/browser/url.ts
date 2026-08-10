import type { BrowserOpenOptions } from "../../../shared/bridge.ts";
import { useUi } from "../../store/ui.ts";
import { useBrowser } from "./store.ts";

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$|\?|#)/i;

/** Resolve user/model input to an http(s) URL; reject executable/local schemes. */
export function normalizeBrowserUrl(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;
  let candidate: string;
  if (LOOPBACK.test(input)) {
    candidate = `http://${input}`;
  } else {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(input)?.[1]?.toLowerCase();
    if (scheme) {
      if (scheme !== "http" && scheme !== "https") return null;
      candidate = input;
    } else if (/^[\w-]+(\.[\w-]+)+/.test(input)) {
      candidate = `https://${input}`;
    } else {
      return null;
    }
  }
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function openInAppBrowser(
  url: string,
  source: NonNullable<BrowserOpenOptions["source"]>,
): boolean {
  const resolved = normalizeBrowserUrl(url);
  if (!resolved) return false;
  useUi.getState().setBrowserOpen(true);
  useBrowser.getState().open(resolved, { source });
  return true;
}
