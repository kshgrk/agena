// The embedded browser pane: a toolbar the renderer owns + a placeholder rect
// the native WebContentsView composites over. The renderer never touches the
// page — it streams the placeholder's viewport bounds to main and hides the
// view whenever an overlay is up (D-INV-3: the native view paints above ALL
// DOM, incl. the approval modal).
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  RotateCw,
  SquareCode,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { peekBridge } from "../../lib/bridge.ts";
import { hasOverlay, useUi } from "../../store/ui.ts";
import { EmptyState, IconButton, TextInput } from "../../ui/index.ts";
import { useBrowser } from "./browser-store.ts";

export function BrowserPane() {
  const address = useBrowser((s) => s.address);
  const loading = useBrowser((s) => s.loading);
  const url = useBrowser((s) => s.url);
  const canGoBack = useBrowser((s) => s.canGoBack);
  const canGoForward = useBrowser((s) => s.canGoForward);
  const focusNonce = useBrowser((s) => s.focusNonce);
  const navigate = useBrowser((s) => s.navigate);
  const setAddress = useBrowser((s) => s.setAddress);
  const overlay = useUi(hasOverlay);

  const placeholderRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reportBounds = useCallback(() => {
    const el = placeholderRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    void peekBridge()?.browserSetBounds({
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }, []);

  // Stream the placeholder's rect on every layout change so main keeps the
  // native view aligned. rAF on mount catches the first post-layout frame.
  useEffect(() => {
    const el = placeholderRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(reportBounds);
    const ro = new ResizeObserver(reportBounds);
    ro.observe(el);
    window.addEventListener("resize", reportBounds);
    window.addEventListener("scroll", reportBounds, true);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", reportBounds);
      window.removeEventListener("scroll", reportBounds, true);
    };
  }, [reportBounds]);

  // Visibility: hidden under any overlay. Re-report bounds
  // when re-shown (layout may have shifted while hidden). Hide on unmount.
  const visible = !overlay;
  useEffect(() => {
    void peekBridge()?.browserSetVisible(visible);
    if (visible) reportBounds();
    return () => {
      void peekBridge()?.browserSetVisible(false);
    };
  }, [visible, reportBounds]);

  // "browser.open" command focuses + selects the URL bar.
  useEffect(() => {
    if (focusNonce === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
        <IconButton
          size="sm"
          label="Back"
          disabled={!canGoBack}
          onClick={() => navigate({ kind: "back" })}
        >
          <ArrowLeft />
        </IconButton>
        <IconButton
          size="sm"
          label="Forward"
          disabled={!canGoForward}
          onClick={() => navigate({ kind: "forward" })}
        >
          <ArrowRight />
        </IconButton>
        <IconButton
          size="sm"
          label={loading ? "Stop" : "Reload"}
          onClick={() => navigate({ kind: loading ? "stop" : "reload" })}
        >
          {loading ? <X /> : <RotateCw />}
        </IconButton>
        <TextInput
          ref={inputRef}
          value={address}
          spellCheck={false}
          placeholder="Enter a URL"
          className="h-6 min-w-0 flex-1 font-mono text-xs"
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && address.trim()) {
              navigate({ kind: "url", url: address.trim() });
              e.currentTarget.blur();
            }
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
        <IconButton
          size="sm"
          label="Open developer tools"
          onClick={() => useBrowser.getState().openDevTools()}
        >
          <SquareCode />
        </IconButton>
        <IconButton
          size="sm"
          label="Open in system browser"
          onClick={() => useBrowser.getState().openExternal()}
        >
          <ExternalLink />
        </IconButton>
        <IconButton
          size="sm"
          label="Close browser"
          onClick={() => useBrowser.getState().close()}
        >
          <X />
        </IconButton>
      </div>

      {/* The native WebContentsView composites over this rect. Keep it a plain
          positioned div — no children the view would hide, no layout shift. */}
      <div ref={placeholderRef} className="relative min-h-0 flex-1 bg-app">
        {url === null ? (
          <EmptyState
            icon={Globe}
            title="No page open"
            hint="Enter a URL above, or click a link in the transcript. Workspace localhost URLs load like local."
          />
        ) : null}
      </div>
    </div>
  );
}
