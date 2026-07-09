// Transcript markdown: react-markdown + gfm, code fences → ui CodeBlock,
// inline code → InlineCode, links open externally, no raw HTML (skipHtml).
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, InlineCode } from "../../ui/index.ts";
import { openInAppBrowser } from "../browser/index.ts";

const REMARK_PLUGINS = [remarkGfm];

const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent hover:underline"
      onClick={(e) => {
        e.preventDefault();
        if (!href) return;
        // http/https/localhost → embedded pane; mailto:/tel:/etc. → OS handler.
        if (!openInAppBrowser(href, "agent")) {
          window.open(href, "_blank", "noopener");
        }
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
        <CodeBlock code={text} lang={match?.[1] ?? "text"} className="my-2" />
      );
    }
    return <InlineCode>{text}</InlineCode>;
  },
};

const PROSE =
  "min-w-0 break-words text-[13px] leading-relaxed text-ink " +
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 " +
  "[&_p]:my-1.5 [&_hr]:my-3 [&_hr]:border-border " +
  "[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-[15px] [&_h1]:font-semibold " +
  "[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-[14px] [&_h2]:font-semibold " +
  "[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold " +
  "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 " +
  "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 " +
  "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-ink-dim " +
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs " +
  "[&_th]:border [&_th]:border-border [&_th]:bg-raised [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium " +
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top";

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className={PROSE}>
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
