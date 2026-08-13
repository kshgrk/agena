import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { distanceFromBottom } from "./auto-follow-logic.ts";
import { MessageList, type MessageListHandle } from "./message-list.tsx";
import { MobilePromptNavigator } from "./mobile-prompt-navigator.tsx";
import {
  type PromptNavigatorPrompt,
  PromptNavigatorRail,
} from "./prompt-navigator-rail.tsx";
import { ScrollToBottomButton } from "./scroll-to-bottom-button.tsx";
import type {
  ActivityRenderer,
  ChamberHistoryEntry,
  ChamberMessage,
  ChamberTimeline,
  ChatContentRenderer,
} from "./types.ts";
import { useChatAutoFollow } from "./use-chat-auto-follow.ts";

export type ChamberChatSurfaceProps = {
  sessionKey: string;
  timeline: ChamberTimeline;
  working: boolean;
  mobile: boolean;
  renderContent: ChatContentRenderer;
  renderActivity?: ActivityRenderer;
  renderOrphan?: (
    entry: Extract<ChamberHistoryEntry, { kind: "orphan" }>,
  ) => ReactNode;
  renderUserActions?: (message: ChamberMessage) => ReactNode;
  stickyUserHeader?: boolean;
  promptNavigator?: boolean;
  canLoadEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  prompts?: readonly PromptNavigatorPrompt[];
  loadingPromptId?: string | null;
  onSelectPrompt?: (messageId: string) => Promise<void>;
  hasNewer?: boolean;
  onLoadLatest?: () => Promise<void>;
  animateUserMessageId?: string | null;
  animateActivityIds?: ReadonlySet<string>;
};

export function ChamberChatSurface({
  sessionKey,
  timeline,
  working,
  mobile,
  renderContent,
  renderActivity,
  renderOrphan,
  renderUserActions,
  stickyUserHeader = true,
  promptNavigator = true,
  canLoadEarlier = false,
  loadingEarlier = false,
  onLoadEarlier,
  prompts,
  loadingPromptId = null,
  onSelectPrompt,
  hasNewer = false,
  onLoadLatest,
  animateUserMessageId,
  animateActivityIds,
}: ChamberChatSurfaceProps) {
  const listRef = useRef<MessageListHandle>(null);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const messageCount = useMemo(
    () =>
      timeline.history.reduce(
        (count, entry) =>
          count + (entry.kind === "turn" ? entry.turn.entries.length + 1 : 1),
        timeline.tail ? 1 : 0,
      ),
    [timeline],
  );
  const autoFollow = useChatAutoFollow({
    sessionKey,
    messageCount,
    working,
    mobile,
    onActiveTurnChange: setActiveTurnId,
  });
  const loadingRef = useRef(loadingEarlier);
  loadingRef.current = loadingEarlier;

  useEffect(() => {
    const container = autoFollow.scrollRef.current;
    if (!container || mobile || !onLoadEarlier) return;
    const handleScroll = () => {
      if (
        container.scrollTop < container.clientHeight * 1.5 &&
        canLoadEarlier &&
        !loadingRef.current
      ) {
        onLoadEarlier();
      }
    };
    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [autoFollow.scrollRef, canLoadEarlier, mobile, onLoadEarlier]);

  const selectTurn = useCallback(
    (turnId: string) => {
      autoFollow.releaseAutoFollow();
      if (listRef.current?.scrollToTurn(turnId, "smooth")) return;
      if (!onSelectPrompt) return;
      void onSelectPrompt(turnId).then(() => {
        requestAnimationFrame(() => {
          listRef.current?.scrollToTurn(turnId, "auto");
        });
      });
    },
    [autoFollow, onSelectPrompt],
  );

  return (
    <div className="relative h-full min-h-0 w-full bg-background">
      <section
        ref={autoFollow.scrollRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scroll region needs keyboard history controls
        tabIndex={0}
        aria-label="Conversation transcript"
        className="chat-scroll h-full overflow-y-auto overflow-x-hidden outline-none"
        // Native scroll anchoring keeps the viewport stable through
        // older-history prepends and content-visibility re-measures; the
        // auto-follow hook's explicit pins run after layout and win while
        // following, so the two never fight.
        style={{ overscrollBehavior: "contain" }}
      >
        {mobile && canLoadEarlier ? (
          <div className="flex justify-center py-3">
            <button
              type="button"
              disabled={loadingEarlier}
              onClick={onLoadEarlier}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground disabled:opacity-50"
            >
              {loadingEarlier ? "Loading…" : "Load earlier"}
            </button>
          </div>
        ) : null}
        <MessageList
          key={sessionKey}
          ref={listRef}
          history={timeline.history}
          tail={timeline.tail}
          scrollRef={autoFollow.scrollRef}
          stickyUserHeader={stickyUserHeader}
          renderContent={renderContent}
          {...(renderActivity ? { renderActivity } : {})}
          {...(renderOrphan ? { renderOrphan } : {})}
          {...(renderUserActions ? { renderUserActions } : {})}
          {...(animateUserMessageId !== undefined
            ? { animateUserMessageId }
            : {})}
          {...(animateActivityIds ? { animateActivityIds } : {})}
        />
        <div
          className="shrink-0"
          style={{ height: mobile ? 40 : "10vh" }}
          aria-hidden="true"
        />
      </section>

      <ScrollToBottomButton
        visible={autoFollow.showScrollButton || hasNewer}
        onClick={() => {
          if (hasNewer && onLoadLatest) {
            void onLoadLatest().then(() => {
              requestAnimationFrame(() => listRef.current?.scrollToEnd());
            });
            return;
          }
          // Glide when close; long distances jump (smooth over thousands of
          // pixels reads as lag, not polish).
          const el = autoFollow.scrollRef.current;
          const smooth = el && distanceFromBottom(el) < el.clientHeight * 3;
          listRef.current?.scrollToEnd(smooth ? "smooth" : "auto");
        }}
      />
      {!mobile && promptNavigator ? (
        <PromptNavigatorRail
          {...(prompts ? { prompts } : { history: timeline.history })}
          activeTurnId={activeTurnId}
          loadingPromptId={loadingPromptId}
          onSelectTurn={selectTurn}
        />
      ) : null}
      {mobile && promptNavigator && prompts ? (
        <MobilePromptNavigator
          prompts={prompts}
          activeTurnId={activeTurnId}
          loadingPromptId={loadingPromptId}
          onSelectTurn={selectTurn}
        />
      ) : null}
    </div>
  );
}
