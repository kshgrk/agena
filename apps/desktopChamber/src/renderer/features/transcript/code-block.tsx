// Code block + inline code per design.md §4: bg-inset well, 28px header with
// language label and hover-revealed copy button, shiki body, horizontal
// scroll (never wrap). Streaming-safe: cached highlights render synchronously;
// a cache miss shows the identical plain <pre> (same metrics, zero layout
// shift) until shiki resolves — colors pop in, nothing moves.
// Adapted from ai-elements code-block.tsx
// (https://github.com/vercel/ai-elements, Apache-2.0, © Vercel, Inc. —
// see docs/oss/LICENSES.md): kept the sync-cache/async-subscribe pattern,
// replaced tokens-as-React-spans with codeToHtml, shadcn cn → ui/cx,
// restyled to theme tokens.
import { Check, Copy } from "lucide-react";
import { memo, type ReactNode, useEffect, useReducer, useState } from "react";
import { cx } from "../../ui/index.ts";
import { cachedHighlight, highlight } from "./highlighter.ts";

// Dual-theme shiki output carries colors as vars; these classes pick the side
// matching the app theme. Backgrounds stay ours (bg-inset), never shiki's.
// Longer than one animation frame so per-frame streaming re-renders always
// cancel the pending highlight before it runs; short enough to be invisible
// on settled-block first mount (cache hits render synchronously anyway).
const HIGHLIGHT_DEBOUNCE_MS = 150;

const SHIKI_CLS =
  "[&_pre]:!bg-transparent [&_code]:whitespace-pre " +
  "[&_.shiki_span]:text-(--shiki-dark) light:[&_.shiki_span]:text-(--shiki-light)";

function CopyButton({ code, className }: { code: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={() => {
        void navigator.clipboard?.writeText(code).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={cx(
        "flex size-6 items-center justify-center rounded-md text-fg-muted",
        "opacity-0 transition-opacity duration-100 hover:bg-fg/6 hover:text-fg-secondary",
        "focus-visible:opacity-100 group-hover/code:opacity-100",
        className,
      )}
    >
      {copied ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}

export type CodeBlockProps = {
  code: string;
  language: string;
  /**
   * Bare well (tool-card input/output sections): rounded-md, p-2.5, no header,
   * capped height with inner scroll. Default: full card with header.
   */
  bare?: boolean;
  className?: string;
};

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  bare = false,
  className,
}: CodeBlockProps) {
  // The cache is the source of truth; state is only a re-render signal.
  const [, bump] = useReducer((c: number) => c + 1, 0);
  const html = cachedHighlight(code, language);

  useEffect(() => {
    if (html !== null) return;
    let alive = true;
    // Debounced: while a fence streams in the tail, `code` changes every rAF
    // flush — the timer resets each time, so partial code is never tokenized
    // (main-thread jank) and never pollutes the highlight cache (which would
    // evict settled blocks). Only content stable for a beat gets highlighted.
    const timer = setTimeout(() => {
      highlight(code, language).then(
        () => {
          if (alive) bump();
        },
        () => {
          // highlight failure → keep the plain <pre>; never crash the transcript
        },
      );
    }, HIGHLIGHT_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [code, language, html]);

  const body = (
    <div
      className={cx(
        "overflow-auto font-mono text-sm",
        bare ? "max-h-60 p-2.5" : "p-3",
        SHIKI_CLS,
      )}
    >
      {html !== null ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: markup from our own shiki singleton
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="whitespace-pre">{code}</pre>
      )}
    </div>
  );

  if (bare) {
    return (
      <div className={cx("group/code relative rounded-md bg-inset", className)}>
        <CopyButton code={code} className="absolute right-1.5 top-1.5 z-10" />
        {body}
      </div>
    );
  }

  return (
    <div
      className={cx(
        "group/code overflow-hidden rounded-lg border border-border-subtle bg-inset",
        className,
      )}
    >
      <div className="flex h-7 items-center justify-between border-b border-border-subtle px-3">
        <span className="text-2xs text-fg-muted">{language || "text"}</span>
        <CopyButton code={code} className="-mr-1.5" />
      </div>
      {body}
    </div>
  );
});

/** Inline code per design.md §4. */
export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-xs bg-inset px-1 py-px font-mono text-[0.9em] text-fg">
      {children}
    </code>
  );
}
