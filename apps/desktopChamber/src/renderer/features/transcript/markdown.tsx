// Transcript markdown: react-markdown + gfm, fences → CodeBlock (shared shiki
// singleton), inline code → InlineCode, links route to the embedded browser,
// no raw HTML (skipHtml). Prose rules from design.md §4/§6. Memoized so
// settled blocks keep stable identity while the tail streams.
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "../../ui/index.ts";
import { openInAppBrowser } from "../browser/url.ts";
import { CodeBlock, InlineCode } from "./code-block.tsx";

const REMARK_PLUGINS = [remarkGfm];

/**
 * Web links open in Agena's browser; unsupported schemes are left to the
 * platform only after the shared URL guard rejects them.
 */
function openTranscriptLink(href: string): void {
  if (!openInAppBrowser(href, "agent")) return;
}

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent hover:underline"
      onClick={(e) => {
        e.preventDefault();
        if (href) openTranscriptLink(href);
      }}
    >
      {children}
    </a>
  ),
  // fences render our CodeBlock directly; drop the wrapping <pre>
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const match = /language-(\S+)/.exec(className ?? "");
    const text = String(children ?? "").replace(/\n$/, "");
    if (match || text.includes("\n")) {
      return (
        <CodeBlock
          code={text}
          language={match?.[1] ?? "text"}
          className="my-3"
        />
      );
    }
    return <InlineCode>{text}</InlineCode>;
  },
};

// design.md §4: headings max 1.125em semibold; blockquote 2px border-l-strong;
// tables compact; hr quiet. First/last child margins collapse against the row.
const PROSE =
  "min-w-0 break-words " +
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 " +
  "[&_p]:my-2 [&_hr]:my-4 [&_hr]:border-border " +
  "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-[1.125em] [&_h1]:font-semibold [&_h1]:text-fg " +
  "[&_h2]:mt-4 [&_h2]:mb-1.5 [&_h2]:text-[1.06em] [&_h2]:font-semibold [&_h2]:text-fg " +
  "[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-[1em] [&_h3]:font-semibold [&_h3]:text-fg " +
  "[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-[1em] [&_h4]:font-medium [&_h4]:text-fg " +
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 " +
  "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 " +
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-l-border-strong " +
  "[&_blockquote]:pl-3 [&_blockquote]:text-fg-secondary " +
  "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm " +
  "[&_th]:border [&_th]:border-border [&_th]:bg-surface [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium " +
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top";

export type MarkdownProps = {
  text: string;
  /** Muted rendering for thinking bodies (design.md §6): everything inherits muted. */
  muted?: boolean;
};

export const Markdown = memo(function Markdown({ text, muted }: MarkdownProps) {
  return (
    <div
      className={cx(
        PROSE,
        muted
          ? "text-sm text-fg-muted [&_a]:text-fg-muted [&_h1]:text-fg-muted [&_h2]:text-fg-muted [&_h3]:text-fg-muted [&_h4]:text-fg-muted [&_blockquote]:text-fg-muted"
          : "text-base text-fg",
      )}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={components}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
