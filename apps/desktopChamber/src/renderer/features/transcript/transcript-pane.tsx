// The transcript: virtualized block list (keyed by block.seq) + streaming
// tail, stick-to-bottom autoscroll with a jump-to-latest pill, backward
// paging on scroll-top, jump/flash from useUi, day/turn separators, and
// mount-once fade-slide-in (never re-animated by virtualizer re-mounts —
// design.md §6). Ported from apps/desktop transcript-pane.tsx; the pin/follow
// approach mirrors ai-elements conversation.tsx (use-stick-to-bottom) without
// the dependency. Programmatic scrolls are instant — smooth scroll fights the
// stream (design.md streaming rules).
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, MessageSquare } from "lucide-react";
import {
  type KeyboardEvent,
  type TouchEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import {
  activeBranchBlocks,
  needsRecentHistory,
  useSessions,
  useTranscripts,
  useUi,
} from "../../store/index.ts";
import type { Block } from "../../store/types.ts";
import { cx, EmptyState, Spinner } from "../../ui/index.ts";
import {
  bottomThreshold,
  type FollowState,
  nextFollowState,
} from "./auto-follow.ts";
import { BlockView } from "./blocks.tsx";
import {
  isCodexImportedSubagent,
  visibleCodexSubagentBlocks,
} from "./codex-subagent.ts";
import { rowMeta } from "./layout.ts";
import { TailView } from "./tail.tsx";
import { UserMessageRail } from "./user-message-rail.tsx";

const NO_BLOCKS: readonly Block[] = [];
const VIEWPORT_CACHE_MAX = 24;
const viewportCache = new Map<string, { top: number; follow: FollowState }>();

function rememberViewport(
  sessionId: string,
  top: number,
  follow: FollowState,
): void {
  viewportCache.delete(sessionId);
  viewportCache.set(sessionId, { top, follow });
  while (viewportCache.size > VIEWPORT_CACHE_MAX) {
    const oldest = viewportCache.keys().next().value;
    if (typeof oldest !== "string") break;
    viewportCache.delete(oldest);
  }
}

const GAP_CLS = {
  first: "pt-3",
  turn: "pt-5",
  block: "pt-3",
  flush: "pt-0",
} as const;

function Skeleton() {
  return (
    <div className="transcript-column space-y-5 py-6">
      {/* animate-pulse-soft: the only whitelisted continuous pulse (design.md §15) */}
      {[0, 1, 2].map((i) => (
        <div key={i} className="animate-pulse-soft space-y-2">
          <div className="h-3 w-24 rounded-md bg-raised" />
          <div className="h-3 w-full rounded-md bg-raised" />
          <div className="h-3 w-2/3 rounded-md bg-raised" />
        </div>
      ))}
    </div>
  );
}

function DayChip({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 pb-3">
      <div className="h-px flex-1 bg-border-subtle" />
      <span className="rounded-full border border-border-subtle bg-surface px-2 py-px text-2xs text-fg-muted">
        {label}
      </span>
      <div className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

export function Transcript({
  sessionId,
  workspaceGrid = false,
}: {
  sessionId: string;
  workspaceGrid?: boolean;
}) {
  const transcript = useTranscripts((s) => s.bySession[sessionId]);
  const session = useSessions((s) => s.byId[sessionId]);
  const loadingOlder = useTranscripts(
    (s) => s.loadingOlder[sessionId] ?? false,
  );
  const jump = useUi((s) => s.jump);

  const parentRef = useRef<HTMLDivElement>(null);
  const followRef = useRef<FollowState>("following");
  const previousTopRef = useRef(0);
  const userIntentUntilRef = useRef(0);
  const programmaticUntilRef = useRef(0);
  const touchYRef = useRef<number | null>(null);
  const readerAnchorRef = useRef<{ seq: number; offset: number } | null>(null);
  const lastLenRef = useRef(0);
  const firstSeqRef = useRef<number | null>(null);
  // mount-once animation guard: only blocks newer than the mount seq animate,
  // and each seq animates at most once (virtualizer re-mounts don't re-trigger)
  const animRef = useRef<{ mountSeq: number; seen: Set<number> } | null>(null);
  const [newCount, setNewCount] = useState(0);
  // State mirror so the jump pill reacts without making scroll events render.
  const [unpinned, setUnpinned] = useState(false);
  const [flashSeq, setFlashSeq] = useState<number | null>(null);

  const isOutputOnly = isCodexImportedSubagent(session);
  const blocks = activeBranchBlocks(
    transcript?.rawEvents ?? [],
    visibleCodexSubagentBlocks(session, transcript?.blocks ?? NO_BLOCKS),
  );
  const hasTail = !isOutputOnly && transcript?.inFlight != null;
  const count = blocks.length + (hasTail ? 1 : 0);

  animRef.current ??= {
    mountSeq: transcript?.lastSeq ?? Number.MAX_SAFE_INTEGER,
    seen: new Set(),
  };
  // transcript wasn't loaded at mount: arm the guard at the replay boundary so
  // replayed history never animates but genuinely new blocks do
  if (
    animRef.current.mountSeq === Number.MAX_SAFE_INTEGER &&
    transcript?.live
  ) {
    animRef.current.mountSeq = transcript.lastSeq;
  }

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 8,
    paddingStart: 12,
    paddingEnd: 16,
    getItemKey: (i) => blocks[i]?.seq ?? "tail",
  });
  const totalSize = virtualizer.getTotalSize();

  const captureReaderAnchor = () => {
    const el = parentRef.current;
    if (!el) return;
    const parentTop = el.getBoundingClientRect().top;
    const first = Array.from(
      el.querySelectorAll<HTMLElement>("[data-block-seq]"),
    ).find((node) => node.getBoundingClientRect().bottom > parentTop + 1);
    const seq = Number(first?.dataset.blockSeq);
    if (!first || !Number.isFinite(seq)) return;
    readerAnchorRef.current = {
      seq,
      offset: first.getBoundingClientRect().top - parentTop,
    };
  };

  const restoreReaderAnchor = (): boolean => {
    const el = parentRef.current;
    const anchor = readerAnchorRef.current;
    if (!el || !anchor) return false;
    const node = el.querySelector<HTMLElement>(
      `[data-block-seq="${anchor.seq}"]`,
    );
    if (!node) return false;
    const delta =
      node.getBoundingClientRect().top -
      el.getBoundingClientRect().top -
      anchor.offset;
    if (Math.abs(delta) > 0.5) {
      programmaticUntilRef.current = performance.now() + 100;
      el.scrollTop += delta;
    }
    return true;
  };

  const scrollToBottom = () => {
    if (count === 0) return;
    programmaticUntilRef.current = performance.now() + 250;
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(count - 1, { align: "end" });
      // Dynamic rows settle after the virtualizer's first measurement.
      requestAnimationFrame(() => {
        const el = parentRef.current;
        if (el) {
          // Overshoot clamps to the exact fractional maximum.
          el.scrollTop = el.scrollHeight + 4096;
          previousTopRef.current = el.scrollTop;
        }
      });
    });
  };

  const releaseFollow = () => {
    if (followRef.current === "released") return;
    followRef.current = "released";
    captureReaderAnchor();
    setUnpinned(true);
  };

  const markUserIntent = () => {
    userIntentUntilRef.current = performance.now() + 350;
  };

  // Dock splits resize this element without resizing the window. Remeasure the
  // wrapped rows and keep following only when the user was already at latest.
  // biome-ignore lint/correctness/useExhaustiveDependencies: virtualizer is the observer target
  useEffect(() => {
    const el = parentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      virtualizer.measure();
      if (followRef.current === "following") scrollToBottom();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [virtualizer]);

  // Measurements can change after the first paint (history fill, wrapping,
  // fonts). A pinned transcript must follow the measured bottom, not estimates.
  // biome-ignore lint/correctness/useExhaustiveDependencies: size/count are the triggers
  useLayoutEffect(() => {
    if (followRef.current === "following") scrollToBottom();
    else restoreReaderAnchor();
  }, [count, totalSize]);

  // reset per session
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger
  useEffect(() => {
    const saved = viewportCache.get(sessionId);
    followRef.current = saved?.follow ?? "following";
    lastLenRef.current = 0;
    firstSeqRef.current = null;
    animRef.current = {
      mountSeq:
        useTranscripts.getState().bySession[sessionId]?.lastSeq ??
        Number.MAX_SAFE_INTEGER,
      seen: new Set(),
    };
    setNewCount(0);
    setUnpinned(followRef.current === "released");
    if (saved?.follow === "released") {
      requestAnimationFrame(() => {
        const el = parentRef.current;
        if (!el) return;
        programmaticUntilRef.current = performance.now() + 100;
        el.scrollTop = saved.top;
        previousTopRef.current = saved.top;
        captureReaderAnchor();
      });
    } else {
      scrollToBottom();
    }
    return () => {
      const el = parentRef.current;
      if (el) rememberViewport(sessionId, el.scrollTop, followRef.current);
    };
  }, [sessionId]);

  // Initial history fill: a session resumed from its persisted cursor replays
  // nothing (subscribe fromSeq is exclusive), so a synced-but-empty transcript
  // would otherwise show "No messages yet" forever — scroll can't trigger
  // prependOlder when there's nothing to scroll. Load the newest page once.
  // Keyed on rawEvents (not blocks): a fetched page with zero visible blocks
  // (e.g. session.created only) still counts as filled.
  const needsInitialFill = needsRecentHistory(transcript);
  useEffect(() => {
    if (!needsInitialFill) return;
    void useTranscripts.getState().prependOlder(sessionId);
  }, [needsInitialFill, sessionId]);

  // pin-to-bottom / jump pill / prepend anchor preservation
  // biome-ignore lint/correctness/useExhaustiveDependencies: transcript is the trigger
  useLayoutEffect(() => {
    const len = blocks.length;
    const firstSeq = blocks[0]?.seq ?? null;
    const prevFirst = firstSeqRef.current;
    if (prevFirst !== null && firstSeq !== null && firstSeq < prevFirst) {
      // Keep the exact visible row/offset through an older-page prepend.
      if (!restoreReaderAnchor()) {
        const idx = blocks.findIndex((b) => b.seq === prevFirst);
        if (idx > 0) virtualizer.scrollToIndex(idx, { align: "start" });
      }
    } else if (followRef.current === "following") {
      scrollToBottom();
    } else if (len > lastLenRef.current && lastLenRef.current > 0) {
      setNewCount((c) => c + (len - lastLenRef.current));
    }
    lastLenRef.current = len;
    firstSeqRef.current = firstSeq;
  }, [transcript, blocks, virtualizer]);

  // jump-to-seq with flash highlight (nonce re-triggers on the same seq)
  useEffect(() => {
    if (!jump || jump.sessionId !== sessionId) return;
    const t = useTranscripts.getState().bySession[sessionId];
    if (!t) return;
    const idx = t.blocks.findIndex((b) => b.seq >= jump.seq);
    if (idx === -1) return;
    followRef.current = "released";
    setUnpinned(true);
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
    const now = performance.now();
    const next = nextFollowState({
      current: followRef.current,
      userIntent:
        now <= userIntentUntilRef.current && now > programmaticUntilRef.current,
      previousTop: previousTopRef.current,
      currentTop: el.scrollTop,
      distanceFromBottom: dist,
      bottomThreshold: bottomThreshold(el.clientHeight),
    });
    if (next !== followRef.current) {
      followRef.current = next;
      setUnpinned(next === "released");
      if (next === "following") setNewCount(0);
    }
    previousTopRef.current = el.scrollTop;
    if (followRef.current === "released") captureReaderAnchor();
    rememberViewport(sessionId, el.scrollTop, followRef.current);
    if (!isOutputOnly && el.scrollTop < 80) {
      captureReaderAnchor();
      const oldestSeq =
        useTranscripts.getState().bySession[sessionId]?.rawEvents[0]?.seq;
      if (oldestSeq !== undefined && oldestSeq > 1) {
        void useTranscripts.getState().prependOlder(sessionId);
      }
    }
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    markUserIntent();
    if (event.deltaY < 0) releaseFollow();
  };

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    markUserIntent();
    touchYRef.current = event.touches.item(0)?.clientY ?? null;
  };

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    markUserIntent();
    const nextY = event.touches.item(0)?.clientY ?? null;
    if (
      nextY !== null &&
      touchYRef.current !== null &&
      nextY > touchYRef.current + 2
    ) {
      releaseFollow();
    }
    touchYRef.current = nextY;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowUp", "PageUp", "Home", "End"].includes(event.key)) return;
    markUserIntent();
    if (event.key === "End") {
      followRef.current = "following";
      setUnpinned(false);
      setNewCount(0);
      scrollToBottom();
    } else {
      releaseFollow();
    }
  };

  if (
    !transcript ||
    needsInitialFill || // history page in flight — not "No messages yet"
    (!transcript.live && blocks.length === 0 && !hasTail)
  ) {
    return (
      <div
        className={cx(
          "min-h-0",
          workspaceGrid && "col-start-1 row-start-2 lg:col-start-2",
        )}
      >
        <Skeleton />
      </div>
    );
  }
  if (isOutputOnly && blocks.length === 0) {
    return (
      <div
        className={cx(
          "min-h-0",
          workspaceGrid && "col-start-1 row-start-2 lg:col-start-2",
        )}
      >
        <EmptyState
          icon={MessageSquare}
          title="No final response captured"
          hint="The full imported Codex context is retained for continuation."
        />
      </div>
    );
  }
  if (blocks.length === 0 && !hasTail) {
    return (
      <div
        className={cx(
          "min-h-0",
          workspaceGrid && "col-start-1 row-start-2 lg:col-start-2",
        )}
      >
        <EmptyState
          icon={MessageSquare}
          title="No messages yet"
          hint="Prompt below to start"
        />
      </div>
    );
  }

  // visible while scrolled up during a stream OR when settled blocks arrived
  const showPill = unpinned && (hasTail || newCount > 0);
  const anim = animRef.current;
  const virtualItems = virtualizer.getVirtualItems();
  const visibleUserSeqs = new Set(
    virtualItems.flatMap((item) => {
      const block = blocks[item.index];
      return block?.kind === "user" ? [block.seq] : [];
    }),
  );
  const userVersion = blocks.reduce(
    (latest, block) =>
      block.kind === "user" ? Math.max(latest, block.seq) : latest,
    0,
  );

  return (
    <div
      className={
        workspaceGrid
          ? "contents"
          : "relative grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)] bg-canvas lg:grid-cols-[28px_minmax(0,1fr)]"
      }
    >
      {!isOutputOnly ? (
        <UserMessageRail
          sessionId={sessionId}
          userVersion={userVersion}
          visibleSeqs={visibleUserSeqs}
          className={workspaceGrid ? "row-span-2 row-start-2" : undefined}
        />
      ) : null}
      <div
        className={cx(
          "relative min-h-0 min-w-0",
          workspaceGrid
            ? "col-start-1 row-start-2 lg:col-start-2"
            : "col-start-1 lg:col-start-2",
        )}
      >
        <section
          ref={parentRef}
          aria-label="Conversation transcript"
          onScroll={handleScroll}
          onWheel={handleWheel}
          onPointerDown={markUserIntent}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={() => {
            touchYRef.current = null;
          }}
          onKeyDown={handleKeyDown}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: scroll region needs keyboard focus for history navigation
          tabIndex={0}
          className="h-full overflow-y-auto"
        >
          <div className="relative w-full" style={{ height: totalSize }}>
            {virtualItems.map((vi) => {
              const block = blocks[vi.index];
              const meta = block ? rowMeta(blocks, vi.index) : null;
              let animate = false;
              if (block && anim) {
                animate =
                  block.seq > anim.mountSeq && !anim.seen.has(block.seq);
                if (animate) anim.seen.add(block.seq);
              }
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  {...(block ? { "data-block-seq": block.seq } : {})}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <div
                    className={cx(
                      "transcript-column",
                      meta ? GAP_CLS[meta.gap] : "pt-5",
                    )}
                  >
                    {meta?.dayLabel ? <DayChip label={meta.dayLabel} /> : null}
                    {block && meta ? (
                      // biome-ignore lint/a11y: selection convenience; the inspector is reachable elsewhere
                      <div
                        className={cx(
                          "rounded-lg transition-colors duration-[260ms]",
                          flashSeq === block.seq && "bg-accent/10",
                          animate && "animate-fade-slide-in",
                        )}
                        onClick={() =>
                          useUi
                            .getState()
                            .setSelected({ sessionId, seq: block.seq })
                        }
                      >
                        <BlockView
                          block={block}
                          sessionId={sessionId}
                          flushTop={meta.groupWithPrev}
                          flushBottom={meta.groupWithNext}
                        />
                      </div>
                    ) : (
                      <TailView transcript={transcript} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {loadingOlder ? (
          <div className="absolute inset-x-0 top-2 z-10 flex justify-center">
            <span className="flex items-center gap-1.5 rounded-full border border-border bg-overlay px-2.5 py-1 text-xs text-fg-secondary shadow-md">
              <Spinner className="size-3" /> loading older…
            </span>
          </div>
        ) : null}

        {showPill ? (
          <button
            type="button"
            onClick={() => {
              setNewCount(0);
              setUnpinned(false);
              followRef.current = "following";
              scrollToBottom();
            }}
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 animate-fade-slide-in items-center gap-1.5 rounded-full border border-border bg-overlay px-3 py-1 text-xs text-fg shadow-md transition-colors duration-100 hover:bg-raised"
          >
            Jump to latest
            {newCount > 0 ? (
              <span className="tabular-nums text-fg-muted">{newCount} new</span>
            ) : null}
            <ArrowDown className="size-3" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
