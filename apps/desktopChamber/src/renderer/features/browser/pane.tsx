import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Plus,
  RotateCw,
  SquareCode,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { peekBridge } from "../../lib/bridge.ts";
import { EmptyState, IconButton, Input, Panel } from "../../ui/index.ts";
import { useBrowser } from "./store.ts";
import { normalizeBrowserUrl } from "./url.ts";

export function BrowserPane() {
  const address = useBrowser((s) => s.address);
  const loading = useBrowser((s) => s.loading);
  const tabs = useBrowser((s) => s.tabs);
  const activeTabId = useBrowser((s) => s.activeTabId);
  const url = useBrowser((s) => s.url);
  const canGoBack = useBrowser((s) => s.canGoBack);
  const canGoForward = useBrowser((s) => s.canGoForward);
  const focusNonce = useBrowser((s) => s.focusNonce);
  const navigate = useBrowser((s) => s.navigate);
  const setAddress = useBrowser((s) => s.setAddress);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [newTab, setNewTab] = useState(false);

  const reportBounds = useCallback(() => {
    const rect = placeholderRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    void peekBridge()?.browserSetBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }, []);

  useEffect(() => {
    const element = placeholderRef.current;
    if (!element) return;
    const frame = requestAnimationFrame(reportBounds);
    const observer = new ResizeObserver(reportBounds);
    observer.observe(element);
    window.addEventListener("resize", reportBounds);
    window.addEventListener("scroll", reportBounds, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", reportBounds);
      window.removeEventListener("scroll", reportBounds, true);
    };
  }, [reportBounds]);

  useEffect(() => {
    void peekBridge()?.browserSetVisible(true);
    reportBounds();
    return () => {
      void peekBridge()?.browserSetVisible(false);
    };
  }, [reportBounds]);

  useEffect(() => {
    if (!focusNonce) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  return (
    <Panel>
      <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-border-subtle px-1.5">
        {tabs.map((tab) => (
          <div
            key={tab.tabId}
            className={`flex h-6 w-36 shrink-0 items-center rounded-md ${
              tab.tabId === activeTabId
                ? "bg-raised text-fg"
                : "text-fg-muted hover:bg-raised/60 hover:text-fg-secondary"
            }`}
          >
            <button
              type="button"
              className="min-w-0 flex-1 truncate px-2 text-left text-xs"
              title={tab.title || tab.url}
              onClick={() => navigate({ kind: "activate", tabId: tab.tabId })}
            >
              {tab.title || tab.url || "New tab"}
            </button>
            <button
              type="button"
              className="mr-1 rounded p-0.5 hover:bg-fg/10"
              aria-label={`Close ${tab.title || "browser tab"}`}
              onClick={() => navigate({ kind: "close", tabId: tab.tabId })}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <IconButton
          size="sm"
          label="New browser tab"
          onClick={() => {
            setNewTab(true);
            setAddress("");
            useBrowser.getState().requestAddressFocus();
          }}
        >
          <Plus />
        </IconButton>
      </div>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
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
        <Input
          ref={inputRef}
          fieldSize="md"
          value={address}
          spellCheck={false}
          placeholder="Enter a URL"
          className="h-6 min-w-0 flex-1 font-mono text-xs"
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const resolved = normalizeBrowserUrl(address);
            if (!resolved) return;
            useBrowser.getState().open(resolved, { source: "user", newTab });
            setNewTab(false);
            event.currentTarget.blur();
          }}
          onFocus={(event) => event.currentTarget.select()}
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
      <div ref={placeholderRef} className="relative min-h-0 flex-1 bg-canvas">
        {url === null ? (
          <EmptyState
            icon={Globe}
            title="No page open"
            hint="Enter a URL, open a transcript link, or ask the agent to preview a page."
          />
        ) : null}
      </div>
    </Panel>
  );
}
