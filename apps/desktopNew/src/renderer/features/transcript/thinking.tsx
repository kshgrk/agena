// Reasoning/thinking disclosure per design.md §6: 28px row (chevron +
// "Thinking" label, shimmer while streaming, duration when done), body =
// muted markdown behind a 2px left border. Auto-opens while streaming,
// auto-collapses once when the stream ends; user clicks pin it either way.
// Behavior adapted from ai-elements reasoning.tsx
// (https://github.com/vercel/ai-elements, Apache-2.0, © Vercel, Inc. —
// see docs/oss/LICENSES.md): kept the auto-open/auto-close-once + duration
// tracking, dropped Streamdown/motion for our Markdown + theme animations.
import { Brain, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx } from "../../ui/index.ts";
import { Markdown } from "./markdown.tsx";

export type ThinkingDisclosureProps = {
  text: string;
  streaming?: boolean;
};

export function ThinkingDisclosure({
  text,
  streaming = false,
}: ThinkingDisclosureProps) {
  // null = follow the stream (open while streaming); boolean = user pinned.
  const [pinned, setPinned] = useState<boolean | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (streaming) {
      startRef.current ??= Date.now();
    } else if (startRef.current !== null) {
      setDuration(Math.max(1, Math.round((Date.now() - startRef.current) / 1000)));
      startRef.current = null;
    }
  }, [streaming]);

  const open = pinned ?? streaming;
  // Lazy-mount the markdown body until first open: settled collapsed blocks
  // must not pay a full react-markdown parse per virtualizer row mount. Once
  // opened it stays mounted so the collapse animation keeps its content.
  const openedRef = useRef(false);
  if (open) openedRef.current = true;

  return (
    <div className="not-first:mt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setPinned(!open)}
        className="flex h-7 items-center gap-1.5 text-xs text-fg-muted transition-colors duration-100 hover:text-fg-secondary"
      >
        <Brain className="size-3.5 shrink-0" />
        {streaming ? (
          <span className="shimmer-text">Thinking…</span>
        ) : (
          <span>
            {duration !== null ? `Thought for ${duration}s` : "Thinking"}
          </span>
        )}
        <ChevronDown
          className={cx(
            "size-3.5 shrink-0 text-fg-faint transition-transform duration-[140ms]",
            open && "rotate-180",
          )}
        />
      </button>
      <div
        className={cx(
          "grid transition-[grid-template-rows] duration-[180ms] ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-l-2 border-l-border py-1 pl-3">
            {openedRef.current ? <Markdown text={text} muted /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
