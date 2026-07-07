// The one in-flight streaming tail (plan §7.3): frame-fed text under a live
// accent border, plus runtime status line and queue chips.
import type { TranscriptState } from "../../store/index.ts";
import { Badge, StreamingDots } from "../../ui/index.ts";
import { ThinkingDisclosure } from "./blocks.tsx";
import { Markdown } from "./markdown.tsx";

export function TailView({ transcript }: { transcript: TranscriptState }) {
  const tail = transcript.inFlight;
  const status = transcript.runtimeStatus;
  const { steerCount, followUpCount } = transcript.queue;
  return (
    <div className="border-l-[1.5px] border-accent pl-3">
      {tail?.blocks.map((b, i) =>
        b.type === "thinking" ? (
          <ThinkingDisclosure key={`t-${String(i)}`} text={b.text} />
        ) : (
          <Markdown key={`b-${String(i)}`} text={b.text} />
        ),
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <StreamingDots />
        {status && status.state !== "idle" ? (
          <span className="text-[11px] text-ink-dim">
            {status.state}
            {status.detail ? ` — ${status.detail}` : ""}
          </span>
        ) : null}
        {steerCount > 0 ? (
          <Badge tone="accent">
            {steerCount} steer{steerCount > 1 ? "s" : ""} queued
          </Badge>
        ) : null}
        {followUpCount > 0 ? (
          <Badge>
            {followUpCount} follow-up{followUpCount > 1 ? "s" : ""} queued
          </Badge>
        ) : null}
      </div>
    </div>
  );
}
