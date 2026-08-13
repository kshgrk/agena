// The message list is deliberately NOT virtualized. History is already
// paginated (chat-surface loads older turns on demand), so the DOM stays
// bounded without a second visibility system.
//
// The previous @tanstack/react-virtual implementation was the root cause of
// the chamber chat bugs: dockview hides inactive tabs with display:none,
// which zeroes the scroll element and starved the virtualizer (blank pane
// until a click), its size estimates left phantom blank space below the
// streaming tail, and row remount/measure loops caused flicker and lost
// expanded-tool state. CSS `content-visibility: auto` has the same stale-paint
// failure when focus switches between visible Dockview splits: the DOM and
// scroll offset survive, but Chromium paints no turns until the next scroll.
// Plain DOM + native anchoring has neither failure mode.
import {
  forwardRef,
  memo,
  type ReactNode,
  type RefObject,
  useImperativeHandle,
} from "react";
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
  scrollToEnd: (behavior?: ScrollBehavior) => void;
};

type MessageListProps = {
  history: readonly ChamberHistoryEntry[];
  tail: ChamberStreamingTail | null;
  scrollRef: RefObject<HTMLDivElement | null>;
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

export const MessageList = memo(
  forwardRef<MessageListHandle, MessageListProps>(function MessageList(
    {
      history,
      tail,
      scrollRef,
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
    useImperativeHandle(ref, () => {
      const scrollTo = (selector: string, behavior: ScrollBehavior) => {
        const node = scrollRef.current?.querySelector<HTMLElement>(selector);
        if (!node) return false;
        node.scrollIntoView({ behavior, block: "start" });
        return true;
      };
      return {
        scrollToTurn: (turnId, behavior = "auto") =>
          scrollTo(`[data-turn-id="${CSS.escape(turnId)}"]`, behavior),
        scrollToMessage: (messageId, behavior = "auto") =>
          scrollTo(`[data-message-id="${CSS.escape(messageId)}"]`, behavior),
        scrollToEnd(behavior = "auto") {
          const container = scrollRef.current;
          if (!container) return;
          // Overshoot clamps to the exact fractional maximum.
          container.scrollTo({
            top: container.scrollHeight + 4096,
            behavior,
          });
        },
      };
    }, [scrollRef]);

    return (
      <div className="relative w-full">
        {history.map((entry) => (
          <div key={entry.key} data-entry-key={entry.key}>
            {entry.kind === "orphan" ? (
              (renderOrphan?.(entry) ?? null)
            ) : (
              <TurnItem
                turn={entry.turn}
                stickyUserHeader={stickyUserHeader}
                renderContent={renderContent}
                animateUser={entry.turn.user.id === animateUserMessageId}
                {...(renderActivity ? { renderActivity } : {})}
                {...(renderUserActions ? { renderUserActions } : {})}
                {...(animateActivityIds ? { animateActivityIds } : {})}
              />
            )}
          </div>
        ))}
        {tail ? (
          <StreamingTail tail={tail} renderContent={renderContent} />
        ) : null}
      </div>
    );
  }),
);
