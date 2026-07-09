// THE entry point for opening a URL in the embedded browser pane. Transcript
// links, terminal detections, and the URL bar all route through here so the
// normalize/validate rule lives in one place. Platform-portable: no electron
// refs, just the ui store + the browser store (which calls the bridge).
import type { BrowserOpenOptions } from "../../../shared/bridge.ts";
import { useUi } from "../../store/ui.ts";
import { useBrowser } from "./browser-store.ts";

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$|\?|#)/i;

/**
 * Resolve a user/agent-supplied string to a safe http(s) URL, or null to reject.
 * - loopback (`localhost:3000`, `127.0.0.1/foo`) → http:// (checked before the
 *   scheme test so "localhost:3000" isn't parsed as scheme "localhost").
 * - explicit http/https → kept; any other scheme (javascript:, data:, file:) → null.
 * - scheme-less but domain-shaped (`example.com/x`) → https://.
 */
export function normalizeBrowserUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let candidate: string;
  if (LOOPBACK.test(s)) {
    candidate = `http://${s}`;
  } else {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase();
    if (scheme) {
      if (scheme !== "http" && scheme !== "https") return null;
      candidate = s;
    } else if (/^[\w-]+(\.[\w-]+)+/.test(s)) {
      candidate = `https://${s}`;
    } else {
      return null;
    }
  }
  try {
    const u = new URL(candidate);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Returns true if the URL was accepted and opened; false to let the caller fall back. */
export function openInAppBrowser(
  url: string,
  source: NonNullable<BrowserOpenOptions["source"]>,
): boolean {
  const resolved = normalizeBrowserUrl(url);
  if (resolved === null) return false;
  useUi.getState().setBrowserOpen(true);
  useBrowser.getState().open(resolved, { source });
  return true;
}
