// The transcript pane (plan §7.3): virtualized block list + in-flight tail,
// pin-to-bottom autoscroll, jump/flash, backward paging.
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, MessageSquare } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type Block, useTranscripts, useUi } from "../../store/index.ts";
import { cx, EmptyState, Spinner } from "../../ui/index.ts";
import { BlockView } from "./blocks.tsx";
import { TailView } from "./tail.tsx";

const NO_BLOCKS: readonly Block[] = [];

function Skeleton() {
  return (
    <div className="mx-auto w-full max-w-[52rem] space-y-5 px-4 py-6">
      {[0, 1, 2].map((i) => (
        <div key={i} className="animate-pulse space-y-2">
          <div className="h-3 w-24 rounded bg-raised" />
          <div className="h-3 w-full rounded bg-raised" />
          <div className="h-3 w-2/3 rounded bg-raised" />
        </div>
      ))}
    </div>
  );
}

export function TranscriptPane({ sessionId }: { sessionId: string }) {
  const transcript = useTranscripts((s) => s.bySession[sessionId]);
  const loadingOlder = useTranscripts(
    (s) => s.loadingOlder[sessionId] ?? false,
  );
  const jump = useUi((s) => s.jump);

  const parentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastLenRef = useRef(0);
  const firstSeqRef = useRef<number | null>(null);
  const [newCount, setNewCount] = useState(0);
  const [flashSeq, setFlashSeq] = useState<number | null>(null);

  const blocks = transcript?.blocks ?? NO_BLOCKS;
  const hasTail = transcript?.inFlight != null;
  const count = blocks.length + (hasTail ? 1 : 0);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 8,
    paddingStart: 12,
    paddingEnd: 16,
    getItemKey: (i) => blocks[i]?.seq ?? "tail",
  });

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      const el = parentRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  };

  // reset per session
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger; scrollToBottom is ref-stable
  useEffect(() => {
    pinnedRef.current = true;
    lastLenRef.current = 0;
    firstSeqRef.current = null;
    setNewCount(0);
    scrollToBottom();
  }, [sessionId]);

  // pin-to-bottom / new-content pill / prepend anchor preservation
  // biome-ignore lint/correctness/useExhaustiveDependencies: transcript is the trigger; scrollToBottom is ref-stable
  useLayoutEffect(() => {
    const len = blocks.length;
    const firstSeq = blocks[0]?.seq ?? null;
    const prevFirst = firstSeqRef.current;
    if (prevFirst !== null && firstSeq !== null && firstSeq < prevFirst) {
      // older page prepended: keep the previously-first block at the top
      // ponytail: index-anchored restore, not pixel-exact; fine with estimates
      const idx = blocks.findIndex((b) => b.seq === prevFirst);
      if (idx > 0) virtualizer.scrollToIndex(idx, { align: "start" });
    } else if (pinnedRef.current) {
      scrollToBottom();
    } else if (len > lastLenRef.current && lastLenRef.current > 0) {
      setNewCount((c) => c + (len - lastLenRef.current));
    }
    lastLenRef.current = len;
    firstSeqRef.current = firstSeq;
  }, [transcript, blocks, virtualizer]);

  // jump-to-seq with flash highlight
  useEffect(() => {
    if (!jump || jump.sessionId !== sessionId) return;
    const t = useTranscripts.getState().bySession[sessionId];
    if (!t) return;
    const idx = t.blocks.findIndex((b) => b.seq >= jump.seq);
    if (idx === -1) return;
    pinnedRef.current = false;
    virtualizer.scrollToIndex(idx, { align: "center" });
    const seq = t.blocks[idx]?.seq ?? null;
    setFlashSeq(seq);
    const timer = setTimeout(() => setFlashSeq(null), 1300);
    return () => clearTimeout(timer);
  }, [jump, sessionId, virtualizer]);

  const handleScroll = () => {
    const el = parentRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const pinned = dist <= 40;
    if (pinned && !pinnedRef.current) setNewCount(0);
    pinnedRef.current = pinned;
    if (el.scrollTop < 80) {
      const oldestSeq =
        useTranscripts.getState().bySession[sessionId]?.rawEvents[0]?.seq;
      if (oldestSeq !== undefined && oldestSeq > 1) {
        void useTranscripts.getState().prependOlder(sessionId);
      }
    }
  };

  if (!transcript || (!transcript.live && blocks.length === 0 && !hasTail)) {
    return <Skeleton />;
  }
  if (blocks.length === 0 && !hasTail) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No messages yet"
        hint="Prompt below to start"
      />
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={parentRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto"
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const block = blocks[vi.index];
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                <div className="mx-auto w-full max-w-[52rem] px-4 py-1.5">
                  {block ? (
                    // biome-ignore lint/a11y: selection convenience; inspector is reachable elsewhere
                    <div
                      className={cx(
                        "rounded",
                        flashSeq === block.seq && "flash-highlight",
                      )}
                      onClick={() =>
                        useUi
                          .getState()
                          .setSelected({ sessionId, seq: block.seq })
                      }
                    >
                      <BlockView block={block} sessionId={sessionId} />
                    </div>
                  ) : transcript ? (
                    <TailView transcript={transcript} />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {loadingOlder ? (
        <div className="absolute inset-x-0 top-2 z-10 flex justify-center">
          <span className="flex items-center gap-1.5 rounded-full border border-border bg-raised px-2.5 py-1 text-[11px] text-ink-dim">
            <Spinner /> loading older…
          </span>
        </div>
      ) : null}

      {newCount > 0 ? (
        <button
          type="button"
          onClick={() => {
            setNewCount(0);
            pinnedRef.current = true;
            scrollToBottom();
          }}
          className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-raised px-2.5 py-1 text-[11px] text-ink shadow-sm hover:bg-overlay focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <ArrowDown className="size-3" />
          {newCount} new
        </button>
      ) : null}
    </div>
  );
}
