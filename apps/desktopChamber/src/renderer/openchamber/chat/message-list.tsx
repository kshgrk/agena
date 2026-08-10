import {
  elementScroll,
  type ReactVirtualizer,
  useVirtualizer,
  type VirtualItem,
} from "@tanstack/react-virtual";
import {
  forwardRef,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { RevealDisabledProvider } from "./animations.tsx";
import { StreamingTail, TurnItem } from "./chat-message.tsx";
import type {
  ActivityRenderer,
  ChamberHistoryEntry,
  ChamberMessage,
  ChamberStreamingTail,
  ChatContentRenderer,
} from "./types.ts";

export type MessageListHandle = {
  scrollToTurn: (turnId: string, behavior?: ScrollBehavior) => boolean;
  scrollToMessage: (messageId: string, behavior?: ScrollBehavior) => boolean;
  scrollToEnd: () => void;
};

type MessageListProps = {
  sessionKey: string;
  history: readonly ChamberHistoryEntry[];
  tail: ChamberStreamingTail | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  mobile: boolean;
  stickyUserHeader?: boolean;
  renderContent: ChatContentRenderer;
  renderActivity?: ActivityRenderer;
  renderOrphan?: (
    entry: Extract<ChamberHistoryEntry, { kind: "orphan" }>,
  ) => ReactNode;
  renderUserActions?: (message: ChamberMessage) => ReactNode;
  animateUserMessageId?: string | null;
  animateActivityIds?: ReadonlySet<string>;
};

const ESTIMATE = 320;
const ESTIMATE_MIN_SAMPLES = 5;
const ESTIMATE_MIN = 120;
const ESTIMATE_MAX = 1200;
const AT_END_PX = 80;
const measurementCache = new Map<
  string,
  { keys: readonly string[]; items: VirtualItem[] }
>();

type ChamberVirtualizer = ReactVirtualizer<HTMLDivElement, HTMLDivElement>;

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

export const MessageList = memo(
  forwardRef<MessageListHandle, MessageListProps>(function MessageList(
    {
      sessionKey,
      history,
      tail,
      scrollRef,
      mobile,
      stickyUserHeader = true,
      renderContent,
      renderActivity,
      renderOrphan,
      renderUserActions,
      animateUserMessageId,
      animateActivityIds,
    },
    ref,
  ) {
    const shouldVirtualize = mobile || history.length >= 5;
    const keys = useMemo(() => history.map((entry) => entry.key), [history]);
    const keysRef = useRef(keys);
    keysRef.current = keys;
    const entriesRef = useRef(history);
    entriesRef.current = history;
    const sizeContainerRef = useRef<HTMLDivElement>(null);
    const estimatedSizeRef = useRef(ESTIMATE);
    const [initialMeasurements] = useState(() => {
      const cached = measurementCache.get(sessionKey);
      return cached && sameKeys(cached.keys, keys) ? cached.items : undefined;
    });

    const virtualizer: ChamberVirtualizer = useVirtualizer({
      count: history.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => estimatedSizeRef.current,
      overscan: mobile ? 16 : 8,
      getItemKey: (index) => keys[index] ?? index,
      scrollToFn: (offset, options, instance) => {
        if (sizeContainerRef.current)
          sizeContainerRef.current.style.height = `${instance.getTotalSize()}px`;
        elementScroll(offset, options, instance);
      },
      anchorTo: "end",
      initialOffset: () => Number.MAX_SAFE_INTEGER,
      ...(initialMeasurements
        ? { initialMeasurementsCache: initialMeasurements }
        : {}),
    });
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
      item,
      _delta,
      instance,
    ) => {
      if (instance.isAtEnd(AT_END_PX)) return false;
      const firstVisible = instance.range?.startIndex;
      return firstVisible !== undefined && item.index < firstVisible;
    };

    useEffect(() => {
      const sizes = virtualizer.itemSizeCache;
      if (sizes.size < ESTIMATE_MIN_SAMPLES) return;
      let total = 0;
      for (const size of sizes.values()) total += size;
      estimatedSizeRef.current = Math.min(
        ESTIMATE_MAX,
        Math.max(ESTIMATE_MIN, Math.round(total / sizes.size)),
      );
    });

    useEffect(
      () => () => {
        const currentKeys = keysRef.current;
        if (!shouldVirtualize || currentKeys.length === 0) return;
        measurementCache.delete(sessionKey);
        measurementCache.set(sessionKey, {
          keys: currentKeys.slice(),
          items: virtualizer.takeSnapshot(),
        });
        while (measurementCache.size > 16) {
          const oldest = measurementCache.keys().next().value;
          if (typeof oldest !== "string") break;
          measurementCache.delete(oldest);
        }
      },
      [sessionKey, shouldVirtualize, virtualizer],
    );

    const findEntryIndex = useCallback(
      (predicate: (entry: ChamberHistoryEntry) => boolean) =>
        history.findIndex(predicate),
      [history],
    );

    useImperativeHandle(
      ref,
      () => ({
        scrollToTurn(turnId, behavior = "auto") {
          const container = scrollRef.current;
          const node = container?.querySelector<HTMLElement>(
            `[data-turn-id="${CSS.escape(turnId)}"]`,
          );
          if (node) {
            node.scrollIntoView({ behavior, block: "start" });
            return true;
          }
          const index = findEntryIndex(
            (entry) => entry.kind === "turn" && entry.turn.id === turnId,
          );
          if (index < 0 || !shouldVirtualize) return false;
          virtualizer.scrollToIndex(index, {
            align: "start",
            behavior: "auto",
          });
          return true;
        },
        scrollToMessage(messageId, behavior = "auto") {
          const container = scrollRef.current;
          const node = container?.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(messageId)}"]`,
          );
          if (node) {
            node.scrollIntoView({ behavior, block: "start" });
            return true;
          }
          const index = findEntryIndex(
            (entry) =>
              entry.kind === "turn" &&
              (entry.turn.user.id === messageId ||
                entry.turn.entries.some(
                  (child) =>
                    child.kind === "assistant" &&
                    child.message.id === messageId,
                )),
          );
          if (index < 0 || !shouldVirtualize) return false;
          virtualizer.scrollToIndex(index, {
            align: "start",
            behavior: "auto",
          });
          return true;
        },
        scrollToEnd() {
          if (shouldVirtualize && history.length > 0)
            virtualizer.scrollToIndex(history.length - 1, { align: "end" });
          const container = scrollRef.current;
          if (container) container.scrollTop = container.scrollHeight + 4096;
        },
      }),
      [
        findEntryIndex,
        history.length,
        scrollRef,
        shouldVirtualize,
        virtualizer,
      ],
    );

    // Re-measure wrapped rows when a Dockview split changes this viewport.
    useEffect(() => {
      const container = scrollRef.current;
      if (!container || typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => virtualizer.measure());
      observer.observe(container);
      return () => observer.disconnect();
    }, [scrollRef, virtualizer]);

    const renderEntry = (entry: ChamberHistoryEntry) => {
      if (entry.kind === "orphan") return renderOrphan?.(entry) ?? null;
      return (
        <TurnItem
          turn={entry.turn}
          stickyUserHeader={stickyUserHeader}
          renderContent={renderContent}
          animateUser={entry.turn.user.id === animateUserMessageId}
          {...(renderActivity ? { renderActivity } : {})}
          {...(renderUserActions ? { renderUserActions } : {})}
          {...(animateActivityIds ? { animateActivityIds } : {})}
        />
      );
    };

    const virtualItems = virtualizer.getVirtualItems();
    const startOffset = virtualItems[0]?.start ?? 0;

    return (
      <div key={sessionKey} className="relative w-full">
        <RevealDisabledProvider disabled={shouldVirtualize}>
          {shouldVirtualize ? (
            <div
              ref={sizeContainerRef}
              className="relative w-full"
              style={{ height: virtualizer.getTotalSize() }}
            >
              <div style={{ paddingTop: startOffset }}>
                {virtualItems.map((item) => {
                  const entry = entriesRef.current[item.index];
                  if (!entry) return null;
                  return (
                    <div
                      key={item.key}
                      ref={virtualizer.measureElement}
                      data-index={item.index}
                      data-entry-key={entry.key}
                    >
                      {renderEntry(entry)}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            history.map((entry) => (
              <div key={entry.key} data-entry-key={entry.key}>
                {renderEntry(entry)}
              </div>
            ))
          )}
        </RevealDisabledProvider>
        {tail ? (
          <StreamingTail tail={tail} renderContent={renderContent} />
        ) : null}
      </div>
    );
  }),
);
