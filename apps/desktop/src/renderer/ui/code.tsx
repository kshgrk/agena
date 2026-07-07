import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { createHighlighter, type Highlighter } from "shiki";
import { cx } from "./cx.ts";

const LANGS = [
  "ts",
  "tsx",
  "js",
  "json",
  "bash",
  "diff",
  "python",
  "css",
  "html",
  "md",
] as const;

const THEMES = {
  dark: "github-dark-default",
  light: "github-light-default",
} as const;

// Module-level singleton: themes + langs load exactly once, lazily.
let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: [THEMES.dark, THEMES.light],
    langs: [...LANGS],
  });
  return highlighterPromise;
}

/**
 * Dual-theme highlighted HTML (dark default; light via shiki CSS vars — the
 * theme stylesheet flips `--shiki-light` in light mode). Unknown langs fall
 * back to plaintext; never throws for bad input.
 */
export async function highlight(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter();
  const known = (LANGS as readonly string[]).includes(lang);
  return hl.codeToHtml(code, {
    lang: known ? lang : "text",
    themes: THEMES,
    defaultColor: "dark",
  });
}

export type CodeBlockProps = {
  code: string;
  lang: string;
  className?: string;
};

/** Highlighted block with copy button; plain <pre> while shiki loads. */
export function CodeBlock({ code, lang, className }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    highlight(code, lang).then(
      (h) => {
        if (alive) setHtml(h);
      },
      () => {
        // highlight failure -> keep the plain <pre> fallback
      },
    );
    return () => {
      alive = false;
    };
  }, [code, lang]);

  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      className={cx(
        "group relative overflow-hidden rounded border border-border bg-app",
        className,
      )}
    >
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy code"}
        onClick={copy}
        className={cx(
          "absolute right-1.5 top-1.5 z-10 rounded border border-border bg-raised p-1 text-ink-dim",
          "opacity-0 transition-opacity hover:text-ink group-hover:opacity-100",
          "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
        )}
      >
        {copied ? (
          <Check className="size-3 text-ok" />
        ) : (
          <Copy className="size-3" />
        )}
      </button>
      {/* fallback <pre> and shiki output share padding/size: no layout shift */}
      <div className="max-h-96 overflow-auto p-2 font-mono text-xs leading-5 [&_pre]:!bg-transparent [&_pre]:outline-none">
        {html !== null ? (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki-generated markup from our own highlighter
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>{code}</pre>
        )}
      </div>
    </div>
  );
}

export function InlineCode({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <code
      className={cx(
        "rounded border border-border bg-app px-1 py-px font-mono text-xs text-ink",
        className,
      )}
    >
      {children}
    </code>
  );
}
