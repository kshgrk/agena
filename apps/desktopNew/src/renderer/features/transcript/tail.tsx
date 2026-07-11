// The one in-flight streaming tail: frame-fed text/thinking blocks with the
// stream caret (the ONLY streaming indicator besides shimmer — design.md §6),
// runtime status line. Rendered as the virtual row after the
// last settled block.

import type { TranscriptState } from "../../store/types.ts";
import { Markdown } from "./markdown.tsx";
import { ThinkingDisclosure } from "./thinking.tsx";

export function TailView({ transcript }: { transcript: TranscriptState }) {
  const tail = transcript.inFlight;
  const status = transcript.runtimeStatus;

  const blocks = tail?.blocks ?? [];
  let lastTextIndex = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.type === "text") {
      lastTextIndex = i;
      break;
    }
  }

  return (
    <div>
      {blocks.map((b, i) =>
        b.type === "thinking" ? (
          <ThinkingDisclosure
            // biome-ignore lint/suspicious/noArrayIndexKey: tail blocks are positional by frame blockIndex
            key={`t-${i}`}
            text={b.text}
            streaming={i === blocks.length - 1}
          />
        ) : (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: tail blocks are positional by frame blockIndex
            key={`b-${i}`}
            className={i === lastTextIndex ? "stream-caret" : undefined}
          >
            <Markdown text={b.text} />
          </div>
        ),
      )}
      {blocks.length === 0 && tail ? (
        // turn started, nothing streamed yet: bare caret keeps the row alive
        <span className="stream-caret" />
      ) : null}
      {status && status.state !== "idle" ? (
        <div className="mt-2 shimmer-text text-xs">
          {status.state}
          {status.detail ? ` — ${status.detail}` : ""}
        </div>
      ) : null}
    </div>
  );
}
