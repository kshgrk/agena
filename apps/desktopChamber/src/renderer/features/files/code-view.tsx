// Adapted from Vercel ai-elements (https://github.com/vercel/ai-elements)
// commit 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b — Apache License 2.0,
// Copyright 2023 Vercel, Inc. See docs/oss/LICENSES.md.
//
// Changes: retyped for this codebase, rethemed to Agena tokens (line numbers
// text-2xs text-fg-faint, transparent bg over the pane's bg-inset), single
// theme per app theme (github-dark/github-light picked by [data-theme]),
// shadcn/select dependencies removed, oversized-content highlight skip added.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type {
  BundledLanguage,
  BundledTheme,
  HighlighterGeneric,
  ThemedToken,
} from "shiki";
import { createHighlighter } from "shiki";
// The app CSP has no 'wasm-unsafe-eval', so shiki's default oniguruma engine
// cannot instantiate — the JS regex engine highlights without WebAssembly.
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { cx } from "../../ui/index.ts";
import {
  SelectionActions,
  type SelectionActionsProps,
} from "../composer/source-reference-ui.tsx";

type Tokenized = { tokens: ThemedToken[][] };

// ponytail: skip syntax highlighting above 200 KB — shiki tokenization of a
// megabyte file janks the UI; plain text with line numbers still renders.
const MAX_HIGHLIGHT_CHARS = 200_000;

const SHIKI_THEME: Record<"dark" | "light", BundledTheme> = {
  dark: "github-dark",
  light: "github-light",
};

// ONE highlighter for the whole pane (ARCHITECTURE perf rule: one highlighter
// per surface — a fresh instance per language would re-parse both themes and
// build a new engine each time, and instances are never disposed). Grammars
// load on demand via loadLanguage, one load promise per language.
let highlighterPromise: Promise<
  HighlighterGeneric<BundledLanguage, BundledTheme>
> | null = null;
const langLoads = new Map<string, Promise<unknown>>();

async function getHighlighter(
  lang: string,
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> {
  highlighterPromise ??= createHighlighter({
    langs: [],
    themes: [SHIKI_THEME.dark, SHIKI_THEME.light],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  const hl = await highlighterPromise;
  if (lang !== "text") {
    let load = langLoads.get(lang);
    if (!load) {
      load = hl.loadLanguage(lang as BundledLanguage).catch(() => {
        // unknown grammar — codeToTokens falls back to "text" below
      });
      langLoads.set(lang, load);
    }
    await load;
  }
  return hl;
}

// Token cache — keyed on lang/theme/content signature (ai-elements scheme)
const tokenCache = new Map<string, Tokenized>();

function cacheKey(code: string, lang: string, theme: string): string {
  const head = code.slice(0, 100);
  const tail = code.length > 100 ? code.slice(-100) : "";
  return `${lang}:${theme}:${code.length}:${head}:${tail}`;
}

function rawTokens(code: string): Tokenized {
  return {
    tokens: code
      .split("\n")
      .map((line) =>
        line === "" ? [] : [{ content: line, offset: 0 } as ThemedToken],
      ),
  };
}

async function highlight(
  code: string,
  lang: string,
  theme: "dark" | "light",
): Promise<Tokenized> {
  const key = cacheKey(code, lang, theme);
  const cached = tokenCache.get(key);
  if (cached) return cached;
  const highlighter = await getHighlighter(lang);
  const loaded = highlighter.getLoadedLanguages();
  const result = highlighter.codeToTokens(code, {
    lang: (loaded.includes(lang) ? lang : "text") as BundledLanguage,
    theme: SHIKI_THEME[theme],
  });
  const tokenized: Tokenized = { tokens: result.tokens };
  tokenCache.set(key, tokenized);
  return tokenized;
}

// Shiki font-style bitflags: 1=italic, 2=bold, 4=underline
const isItalic = (f: number | undefined) => f !== undefined && (f & 1) !== 0;
const isBold = (f: number | undefined) => f !== undefined && (f & 2) !== 0;
const isUnderline = (f: number | undefined) => f !== undefined && (f & 4) !== 0;

const LINE_NUMBER_CLS =
  "block before:content-[counter(line)] before:[counter-increment:line] " +
  "before:inline-block before:w-10 before:pr-4 before:text-right " +
  "before:select-none before:text-2xs before:text-fg-faint";

const CodeLines = memo(function CodeLines({
  tokenized,
  showLineNumbers,
}: {
  tokenized: Tokenized;
  showLineNumbers: boolean;
}) {
  return (
    <code
      className={cx(
        "block font-mono text-sm",
        showLineNumbers && "[counter-reset:line]",
      )}
    >
      {tokenized.tokens.map((line, lineIdx) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: syntax-highlighted lines are positional and replaced as one token set.
          key={lineIdx}
          data-source-line={lineIdx + 1}
          className={showLineNumbers ? LINE_NUMBER_CLS : "block"}
        >
          {line.length === 0
            ? "\n"
            : line.map((token, tokenIdx) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: Shiki tokens have no stable identity beyond their position.
                  key={tokenIdx}
                  style={{
                    color: token.color,
                    fontStyle: isItalic(token.fontStyle) ? "italic" : undefined,
                    fontWeight: isBold(token.fontStyle) ? "bold" : undefined,
                    textDecoration: isUnderline(token.fontStyle)
                      ? "underline"
                      : undefined,
                  }}
                >
                  {token.content}
                </span>
              ))}
        </span>
      ))}
    </code>
  );
});

export type CodeViewProps = {
  code: string;
  /** shiki language id ("text" = plain). */
  lang: string;
  /** Resolved app theme (picks the shiki theme). */
  theme: "dark" | "light";
  showLineNumbers?: boolean;
  className?: string;
  selection?: Pick<SelectionActionsProps, "sessionId" | "makeReference">;
};

/** Shiki-highlighted read-only code body on a transparent background. */
export function CodeView({
  code,
  lang,
  theme,
  showLineNumbers = true,
  className,
  selection,
}: CodeViewProps) {
  const plain = useMemo(() => rawTokens(code), [code]);
  const [highlighted, setHighlighted] = useState<Tokenized | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    setHighlighted(null);
    if (lang === "text" || code.length > MAX_HIGHLIGHT_CHARS) return;
    const request = ++requestRef.current;
    highlight(code, lang, theme)
      .then((tokenized) => {
        if (requestRef.current === request) setHighlighted(tokenized);
      })
      .catch(() => {
        // unknown grammar / load failure → plain text stays up
      });
  }, [code, lang, theme]);

  const body = (
    <pre className={cx("m-0 overflow-x-auto p-3 text-fg", className)}>
      <CodeLines
        tokenized={highlighted ?? plain}
        showLineNumbers={showLineNumbers}
      />
    </pre>
  );
  return selection ? (
    <SelectionActions {...selection}>{body}</SelectionActions>
  ) : (
    body
  );
}
