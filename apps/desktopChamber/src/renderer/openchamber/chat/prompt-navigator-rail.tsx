import type { UserMessageAnchor } from "@agena/protocol";
import { ArrowUp, LoaderCircle } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  promptIndexAtOffset,
  promptTickTop,
  promptTickWidth,
} from "./prompt-navigator-logic.ts";
import type { ChamberHistoryEntry } from "./types.ts";

export type PromptNavigatorPrompt = UserMessageAnchor & {
  loaded?: boolean;
};

export type PromptNavigatorRailProps = {
  /** Complete session prompt index. Prefer this over deriving from loaded history. */
  prompts?: readonly PromptNavigatorPrompt[];
  /** Temporary compatibility path while the compact transcript store lands. */
  history?: readonly ChamberHistoryEntry[];
  activeTurnId: string | null;
  loadingPromptId?: string | null;
  onSelectTurn?: (messageId: string) => void;
  onSelect?: (messageId: string) => void;
  canLoadEarlier?: boolean;
  isLoadingOlder?: boolean;
  onLoadEarlier?: () => void;
  keyboardNavigationOpen?: boolean;
  onKeyboardNavigationOpenChange?: (open: boolean) => void;
};

const GUTTER_WIDTH_PX = 28;
const GUTTER_NARROW_WIDTH_PX = 12;
const GUTTER_RIGHT_OFFSET_PX = 6;
const TICK_PITCH_PX = 12;
const GUTTER_MAX_HEIGHT_PX = 360;
const TICK_OVERSCAN = 4;
const PANEL_ROW_HEIGHT_PX = 54;
const PANEL_ROW_INSET_Y_PX = 4;
const PANEL_MAX_ROWS = 8;
const PANEL_SCROLL_MARGIN_ROWS = 2;
const PANEL_HIDE_DELAY_MS = 160;

type PromptEntry = PromptNavigatorPrompt;

function loadedHistoryPrompts(
  history: readonly ChamberHistoryEntry[],
): PromptEntry[] {
  return history.flatMap((entry) =>
    entry.kind === "turn"
      ? [
          {
            messageId: entry.turn.id,
            seq: entry.turn.user.sourceSeq,
            preview:
              entry.turn.user.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join(" ")
                .trim()
                .slice(0, 160) || "No text content",
            createdAt: entry.turn.user.at,
            loaded: true,
          },
        ]
      : [],
  );
}

export function PromptNavigatorRail({
  prompts: indexedPrompts,
  history = [],
  activeTurnId,
  loadingPromptId = null,
  onSelectTurn,
  onSelect,
  canLoadEarlier = false,
  isLoadingOlder = false,
  onLoadEarlier,
  keyboardNavigationOpen = false,
  onKeyboardNavigationOpenChange,
}: PromptNavigatorRailProps) {
  const prompts = useMemo(
    () => indexedPrompts?.slice() ?? loadedHistoryPrompts(history),
    [history, indexedPrompts],
  );
  const selectPrompt = onSelectTurn ?? onSelect;
  const gutterRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [highlightedIndex, setHighlightedIndex] = useState<number | null>(null);
  const [isNarrowGutter, setIsNarrowGutter] = useState(false);

  useEffect(() => {
    const container = navRef.current?.parentElement;
    if (!container || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const column = container.querySelector(".transcript-column");
      if (!column) return setIsNarrowGutter(false);
      const containerRect = container.getBoundingClientRect();
      const columnRect = column.getBoundingClientRect();
      const fullGutterLeft =
        containerRect.right - GUTTER_RIGHT_OFFSET_PX - GUTTER_WIDTH_PX;
      setIsNarrowGutter(columnRect.right > fullGutterLeft);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const gutterHeight = Math.min(
    prompts.length * TICK_PITCH_PX,
    GUTTER_MAX_HEIGHT_PX,
  );
  const activeIndex = activeTurnId
    ? prompts.findIndex((prompt) => prompt.messageId === activeTurnId)
    : -1;

  const promptsLengthRef = useRef(prompts.length);
  promptsLengthRef.current = prompts.length;

  const firstPromptIdRef = useRef(prompts[0]?.messageId);
  const previousLengthRef = useRef(prompts.length);
  useLayoutEffect(() => {
    const previousFirst = firstPromptIdRef.current;
    const added = prompts.length - previousLengthRef.current;
    if (
      added > 0 &&
      previousLengthRef.current > 0 &&
      previousFirst &&
      prompts[0]?.messageId !== previousFirst
    ) {
      setHighlightedIndex((index) => (index === null ? null : index + added));
    }
    firstPromptIdRef.current = prompts[0]?.messageId;
    previousLengthRef.current = prompts.length;
  }, [prompts]);

  const indexFromPointer = useCallback((clientY: number) => {
    const gutter = gutterRef.current;
    if (!gutter) return null;
    const rect = gutter.getBoundingClientRect();
    return promptIndexAtOffset(
      clientY - rect.top,
      rect.height,
      promptsLengthRef.current,
    );
  }, []);

  const hideTimerRef = useRef<number | null>(null);
  const cancelScheduledHide = useCallback(() => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);
  const scheduleHide = useCallback(() => {
    cancelScheduledHide();
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setHighlightedIndex(null);
    }, PANEL_HIDE_DELAY_MS);
  }, [cancelScheduledHide]);
  useEffect(
    () => () => {
      if (hideTimerRef.current !== null)
        window.clearTimeout(hideTimerRef.current);
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      cancelScheduledHide();
      setHighlightedIndex(indexFromPointer(event.clientY));
    },
    [cancelScheduledHide, indexFromPointer],
  );

  const handlePointerLeave = useCallback(() => {
    scheduleHide();
  }, [scheduleHide]);

  const closeKeyboardNavigation = useCallback(
    () => onKeyboardNavigationOpenChange?.(false),
    [onKeyboardNavigationOpenChange],
  );
  const handleSelect = useCallback(
    (index: number | null) => {
      const prompt = index === null ? undefined : prompts[index];
      if (!prompt || !selectPrompt) return;
      selectPrompt(prompt.messageId);
      setHighlightedIndex(null);
      closeKeyboardNavigation();
      gutterRef.current?.blur();
    },
    [closeKeyboardNavigation, prompts, selectPrompt],
  );

  const handleGutterClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      handleSelect(indexFromPointer(event.clientY));
    },
    [handleSelect, indexFromPointer],
  );

  const focusCurrentPrompt = useCallback(() => {
    setHighlightedIndex((current) => {
      if (current !== null) return current;
      return activeIndex >= 0 ? activeIndex : prompts.length - 1;
    });
  }, [activeIndex, prompts.length]);

  useEffect(() => {
    if (!keyboardNavigationOpen || !gutterRef.current) return;
    gutterRef.current.focus();
    focusCurrentPrompt();
  }, [focusCurrentPrompt, keyboardNavigationOpen]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (prompts.length === 0) return;
      const current =
        highlightedIndex ??
        (activeIndex >= 0 ? activeIndex : prompts.length - 1);
      const moveTo = (index: number) => {
        const next = Math.max(0, Math.min(prompts.length - 1, index));
        setHighlightedIndex(next);
      };
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        moveTo(current + (event.key === "ArrowUp" ? -1 : 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        moveTo(0);
      } else if (event.key === "End") {
        event.preventDefault();
        moveTo(prompts.length - 1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleSelect(current);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setHighlightedIndex(null);
        closeKeyboardNavigation();
        gutterRef.current?.blur();
      }
    },
    [
      activeIndex,
      closeKeyboardNavigation,
      handleSelect,
      highlightedIndex,
      prompts.length,
    ],
  );

  const panelRef = useRef<HTMLDivElement>(null);
  const highlightedIndexRef = useRef(highlightedIndex);
  highlightedIndexRef.current = highlightedIndex;
  const wheelRemainderRef = useRef(0);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || highlightedIndex === null) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      wheelRemainderRef.current += event.deltaY;
      const steps = Math.trunc(wheelRemainderRef.current / PANEL_ROW_HEIGHT_PX);
      if (steps === 0) return;
      wheelRemainderRef.current -= steps * PANEL_ROW_HEIGHT_PX;
      const current = highlightedIndexRef.current;
      if (current === null) return;
      const next = Math.max(
        0,
        Math.min(promptsLengthRef.current - 1, current + steps),
      );
      if (next === current) return;
      setHighlightedIndex(next);
    };
    panel.addEventListener("wheel", handleWheel, { passive: false });
    return () => panel.removeEventListener("wheel", handleWheel);
  }, [highlightedIndex]);

  const highlightedPrompt =
    highlightedIndex === null ? undefined : prompts[highlightedIndex];
  const panelVisibleRows = Math.min(prompts.length, PANEL_MAX_ROWS);
  const panelHeight = panelVisibleRows * PANEL_ROW_HEIGHT_PX;
  const panelMaxOffset = prompts.length * PANEL_ROW_HEIGHT_PX - panelHeight;
  const clampPanelOffset = (offset: number) =>
    Math.max(0, Math.min(panelMaxOffset, offset));
  const panelOffsetRef = useRef<number | null>(null);
  let panelScrollOffset = 0;
  if (highlightedIndex === null) {
    panelOffsetRef.current = null;
  } else if (panelOffsetRef.current === null) {
    panelScrollOffset = clampPanelOffset(
      highlightedIndex * PANEL_ROW_HEIGHT_PX -
        (panelHeight - PANEL_ROW_HEIGHT_PX) / 2,
    );
    panelOffsetRef.current = panelScrollOffset;
  } else {
    let offset = panelOffsetRef.current;
    const highestAllowed =
      (highlightedIndex - PANEL_SCROLL_MARGIN_ROWS) * PANEL_ROW_HEIGHT_PX;
    const lowestAllowed =
      (highlightedIndex + 1 + PANEL_SCROLL_MARGIN_ROWS) * PANEL_ROW_HEIGHT_PX -
      panelHeight;
    if (offset > highestAllowed) offset = highestAllowed;
    else if (offset < lowestAllowed) offset = lowestAllowed;
    panelScrollOffset = clampPanelOffset(offset);
    panelOffsetRef.current = panelScrollOffset;
  }

  const panelFirstVisibleRow = Math.floor(
    panelScrollOffset / PANEL_ROW_HEIGHT_PX,
  );
  const panelSliceStart = Math.max(0, panelFirstVisibleRow - TICK_OVERSCAN);
  const panelSliceEnd = Math.min(
    prompts.length,
    panelFirstVisibleRow + panelVisibleRows + TICK_OVERSCAN,
  );
  const panelClippedAbove = panelScrollOffset > 0;
  const panelClippedBelow = panelScrollOffset < panelMaxOffset;
  const panelMask =
    panelClippedAbove || panelClippedBelow
      ? `linear-gradient(to bottom, ${panelClippedAbove ? "transparent, black 10%" : "black"}, ${panelClippedBelow ? "black 90%, transparent" : "black"})`
      : undefined;
  if (prompts.length < 2) return null;

  return (
    <nav
      ref={navRef}
      aria-label="Prompts"
      className="pointer-events-none absolute right-1.5 top-1/2 z-20 -translate-y-1/2"
    >
      <div className="pointer-events-auto flex flex-col items-end">
        {canLoadEarlier && onLoadEarlier ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Load earlier prompts"
            title="Load earlier prompts"
            disabled={isLoadingOlder}
            onClick={(event) => {
              event.stopPropagation();
              if (!isLoadingOlder) onLoadEarlier();
            }}
            className={`-mr-px mb-1.5 flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground ${isLoadingOlder ? "cursor-wait opacity-70" : ""}`}
          >
            {isLoadingOlder ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <ArrowUp className="size-3.5" />
            )}
          </button>
        ) : null}
        <div
          ref={gutterRef}
          role="listbox"
          tabIndex={0}
          aria-activedescendant={
            highlightedPrompt
              ? `prompt-rail-tick-${highlightedPrompt.messageId}`
              : undefined
          }
          className="relative cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
          style={{
            width: isNarrowGutter ? GUTTER_NARROW_WIDTH_PX : GUTTER_WIDTH_PX,
            height: gutterHeight,
          }}
          onFocus={focusCurrentPrompt}
          onMouseMove={handlePointerMove}
          onMouseLeave={handlePointerLeave}
          onClick={handleGutterClick}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            setHighlightedIndex(null);
            closeKeyboardNavigation();
          }}
        >
          <div className="absolute inset-y-1 inset-x-0">
            {prompts.map((prompt, index) => {
              const active = prompt.messageId === activeTurnId;
              const highlighted = highlightedIndex === index;
              return (
                <div
                  key={prompt.messageId}
                  id={`prompt-rail-tick-${prompt.messageId}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={highlighted}
                  aria-current={active ? "true" : undefined}
                  aria-label={prompt.preview.trim() || "No text content"}
                  data-loaded={prompt.loaded ?? undefined}
                  className="pointer-events-none absolute right-1 flex items-center justify-end"
                  style={{
                    top: promptTickTop(index, prompts.length),
                    height: 2,
                    transform: "translateY(-50%)",
                  }}
                >
                  <span
                    aria-hidden="true"
                    className={`block h-0.5 rounded-full transition-all duration-200 ease-out ${active ? "bg-foreground" : highlighted ? "bg-foreground/80" : prompt.loaded === false ? "bg-muted-foreground/20" : "bg-muted-foreground/40"}`}
                    style={{
                      width: promptTickWidth(index, highlightedIndex, active),
                    }}
                  />
                </div>
              );
            })}
          </div>
          {highlightedPrompt && highlightedIndex !== null ? (
            <div
              ref={panelRef}
              role="listbox"
              tabIndex={-1}
              className="pointer-events-auto absolute right-full top-1/2 z-30 mr-3 w-[min(20rem,calc(100vw-6rem))] -translate-y-1/2 overflow-hidden rounded-xl border border-border bg-raised py-1 shadow-lg"
              onMouseEnter={cancelScheduledHide}
              onMouseLeave={scheduleHide}
              onMouseMove={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <div
                className="relative overflow-hidden"
                style={{
                  height: panelVisibleRows * PANEL_ROW_HEIGHT_PX,
                  maskImage: panelMask,
                  WebkitMaskImage: panelMask,
                }}
              >
                <div
                  className="absolute inset-x-0 top-0 transition-transform duration-200 ease-out"
                  style={{
                    height: prompts.length * PANEL_ROW_HEIGHT_PX,
                    transform: `translateY(-${panelScrollOffset}px)`,
                  }}
                >
                  {prompts
                    .slice(panelSliceStart, panelSliceEnd)
                    .map((prompt, slot) => {
                      const index = panelSliceStart + slot;
                      const active = prompt.messageId === activeTurnId;
                      const highlighted = highlightedIndex === index;
                      const loading = prompt.messageId === loadingPromptId;
                      return (
                        <button
                          type="button"
                          key={prompt.messageId}
                          role="option"
                          tabIndex={-1}
                          aria-selected={highlighted}
                          aria-current={active ? "true" : undefined}
                          aria-busy={loading || undefined}
                          title={active ? "Current prompt" : undefined}
                          className="absolute inset-x-0 cursor-pointer px-1.5"
                          style={{
                            top:
                              index * PANEL_ROW_HEIGHT_PX +
                              PANEL_ROW_INSET_Y_PX,
                            height:
                              PANEL_ROW_HEIGHT_PX - PANEL_ROW_INSET_Y_PX * 2,
                          }}
                          onMouseMove={() => {
                            cancelScheduledHide();
                            if (highlightedIndexRef.current !== index) {
                              setHighlightedIndex(index);
                            }
                          }}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleSelect(index);
                          }}
                        >
                          <div
                            className={`flex h-full items-center gap-2 rounded-lg border px-2 transition-colors ${active ? "border-transparent bg-interactive-active text-foreground" : highlighted ? "border-border-strong bg-interactive-hover" : "border-border"}`}
                          >
                            <span className="min-w-0 flex-1 line-clamp-2 overflow-wrap-anywhere text-xs leading-4 text-muted-foreground">
                              {prompt.preview.trim() || "No text content"}
                            </span>
                            {loading ? (
                              <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" />
                            ) : prompt.loaded === false ? (
                              <span className="shrink-0 text-[10px] text-fg-faint">
                                Load
                              </span>
                            ) : null}
                          </div>
                        </button>
                      );
                    })}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </nav>
  );
}
