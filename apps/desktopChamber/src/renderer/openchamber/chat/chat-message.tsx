import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  LoaderCircle,
  X,
} from "lucide-react";
import {
  memo,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  dedupeMedia,
  mediaFromContent,
} from "../../features/transcript/media.ts";
import { MediaGallery } from "../../features/transcript/media-gallery.tsx";
import { ActivityReveal, BusyDots, UserSendReveal } from "./animations.tsx";
import { summarizeToolActivities } from "./project-turns.ts";
import type {
  ActivityRenderer,
  ChamberActivity,
  ChamberMessage,
  ChamberStreamingTail,
  ChamberTurn,
  ChatContentRenderer,
} from "./types.ts";
import { useStreamingText } from "./use-streaming-text.ts";

export function UserMessage({
  message,
  renderContent,
  actions,
  animate = false,
}: {
  message: ChamberMessage;
  renderContent: ChatContentRenderer;
  actions?: ReactNode;
  animate?: boolean;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || expanded) return;
    const measure = () =>
      setOverflowing(content.scrollHeight > content.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [expanded]);

  return (
    <UserSendReveal animate={animate}>
      <div
        className="group/user relative w-full py-4"
        data-message-id={message.id}
      >
        <div className="transcript-column px-4">
          <div className="flex justify-end">
            <div className="oc-user-prompt-card w-fit max-w-[92%] rounded-xl border px-4 py-3">
              <div className="relative">
                <div
                  ref={contentRef}
                  className={expanded ? "" : "line-clamp-3 overflow-hidden"}
                >
                  {renderContent({
                    content: message.content,
                    role: "user",
                    streaming: false,
                    message,
                  })}
                </div>
                {overflowing && !expanded ? (
                  <div className="oc-user-prompt-fade pointer-events-none absolute inset-x-0 bottom-0 h-10" />
                ) : null}
              </div>
              {overflowing ? (
                <button
                  type="button"
                  onClick={() => setExpanded((value) => !value)}
                  className="mt-2 flex items-center gap-1 text-xs font-medium text-accent hover:text-accent-hover"
                  aria-expanded={expanded}
                >
                  {expanded ? (
                    <ChevronUp className="size-3.5" />
                  ) : (
                    <ChevronDown className="size-3.5" />
                  )}
                  {expanded ? "Show less" : "Show full prompt"}
                </button>
              ) : null}
            </div>
          </div>
          {actions ? (
            <div className="mt-1 flex justify-end opacity-0 transition-opacity duration-100 group-hover/user:opacity-100 group-focus-within/user:opacity-100">
              {actions}
            </div>
          ) : null}
        </div>
      </div>
    </UserSendReveal>
  );
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  renderContent,
}: {
  message: ChamberMessage;
  renderContent: ChatContentRenderer;
}) {
  return (
    <div className="w-full" data-message-id={message.id}>
      <div className="transcript-column px-4 py-2">
        {renderContent({
          content: message.content,
          role: "assistant",
          streaming: false,
          message,
        })}
        {message.status === "failed" ? (
          <div className="mt-2 text-sm text-[var(--status-error)]">
            {message.error?.message ?? "The response failed."}
          </div>
        ) : null}
        {message.status === "aborted" ? (
          <div className="mt-2 text-xs text-muted-foreground">Stopped</div>
        ) : null}
      </div>
    </div>
  );
});

function ActivityRow({
  activity,
  renderActivity,
  animate,
  delayMs,
}: {
  activity: ChamberActivity;
  renderActivity: ActivityRenderer;
  animate: boolean;
  delayMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ActivityReveal animate={animate} delayMs={delayMs}>
      <div data-activity-id={activity.id}>
        {renderActivity({
          activity,
          expanded,
          toggleExpanded: () => setExpanded((value) => !value),
        })}
      </div>
    </ActivityReveal>
  );
}

function DefaultActivity({
  activity,
  expanded,
  toggleExpanded,
}: Parameters<ActivityRenderer>[0]) {
  const running =
    activity.status === "running" || activity.status === "pending";
  return (
    <div className="transcript-column px-4">
      <button
        type="button"
        onClick={toggleExpanded}
        className="flex min-h-6 w-full items-center gap-2 text-left text-sm text-muted-foreground"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <span className="truncate font-medium text-foreground">
          {activity.title}
        </span>
        {running ? <BusyDots /> : null}
      </button>
      {expanded ? (
        <pre
          data-scrollable
          className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--interactive-hover)] p-3 text-xs text-muted-foreground"
        >
          {JSON.stringify(activity.block, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function ToolActivityGroup({
  activities,
  renderActivity,
  animate,
  delayMs,
}: {
  activities: readonly ChamberActivity[];
  renderActivity: ActivityRenderer;
  animate: boolean;
  delayMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeToolActivities(activities);
  const media = useMemo(
    () =>
      dedupeMedia(
        activities.flatMap((activity) => {
          if (activity.block.kind !== "tool") return [];
          return mediaFromContent(
            activity.block.result ?? activity.block.partialOutput ?? [],
          );
        }),
      ),
    [activities],
  );

  return (
    <ActivityReveal animate={animate} delayMs={delayMs}>
      <div className="transcript-column px-4 py-1">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-h-10 w-full items-start gap-2 rounded-md px-1 py-1.5 text-left text-sm text-muted-foreground hover:bg-[var(--interactive-hover)]"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              {summary.state === "running" ? (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin text-tool-running" />
              ) : summary.state === "issue" ? (
                <X className="size-3.5 shrink-0 text-tool-error" />
              ) : (
                <Check className="size-3.5 shrink-0 text-tool-success" />
              )}
              <span className="truncate">{summary.title}</span>
            </span>
            <span
              className={
                summary.state === "issue"
                  ? "mt-0.5 block truncate text-xs text-tool-error"
                  : "mt-0.5 block truncate text-xs text-muted-foreground"
              }
            >
              {summary.detail}
            </span>
          </span>
          <span className="mt-0.5 shrink-0 text-xs">
            {summary.state === "running" ? (
              <>active</>
            ) : summary.state === "issue" ? (
              "review"
            ) : (
              "details"
            )}
          </span>
        </button>
        <MediaGallery items={media} className="mt-1" />
        {expanded ? (
          <div className="mt-1 border-l border-border-subtle pl-2">
            {activities.map((activity) => (
              <ActivityRow
                key={`${activity.id}:${activity.seq}`}
                activity={activity}
                renderActivity={renderActivity}
                animate={false}
                delayMs={0}
              />
            ))}
          </div>
        ) : null}
      </div>
    </ActivityReveal>
  );
}

export const TurnItem = memo(function TurnItem({
  turn,
  stickyUserHeader,
  renderContent,
  renderActivity = DefaultActivity,
  renderUserActions,
  animateUser,
  animateActivityIds,
}: {
  turn: ChamberTurn;
  stickyUserHeader: boolean;
  renderContent: ChatContentRenderer;
  renderActivity?: ActivityRenderer;
  renderUserActions?: (message: ChamberMessage) => ReactNode;
  animateUser?: boolean;
  animateActivityIds?: ReadonlySet<string>;
}) {
  const body = useMemo(
    () =>
      turn.entries.map((entry, index) =>
        entry.kind === "assistant" ? (
          <AssistantMessage
            key={entry.key}
            message={entry.message}
            renderContent={renderContent}
          />
        ) : entry.kind === "tool-group" ? (
          <ToolActivityGroup
            key={entry.key}
            activities={entry.activities}
            renderActivity={renderActivity}
            animate={entry.activities.some((activity) =>
              Boolean(animateActivityIds?.has(activity.id)),
            )}
            delayMs={Math.min(index * 35, 210)}
          />
        ) : (
          <ActivityRow
            key={entry.key}
            activity={entry.activity}
            renderActivity={renderActivity}
            animate={animateActivityIds?.has(entry.activity.id) ?? false}
            delayMs={Math.min(index * 35, 210)}
          />
        ),
      ),
    [animateActivityIds, renderActivity, renderContent, turn.entries],
  );
  const user = (
    <UserMessage
      message={turn.user}
      renderContent={renderContent}
      {...(renderUserActions ? { actions: renderUserActions(turn.user) } : {})}
      {...(animateUser !== undefined ? { animate: animateUser } : {})}
    />
  );
  return (
    <section
      className="relative w-full"
      id={`turn-${turn.id}`}
      data-turn-id={turn.id}
    >
      {stickyUserHeader ? (
        <div className="sticky top-0 z-20 bg-background [overflow-anchor:none]">
          <div className="relative z-10">{user}</div>
          <div className="pointer-events-none absolute inset-x-0 top-full h-8 bg-gradient-to-b from-background to-transparent" />
        </div>
      ) : (
        user
      )}
      <div className="relative z-0 pt-2">{body}</div>
    </section>
  );
});

export function StreamingTail({
  tail,
  renderContent,
}: {
  tail: ChamberStreamingTail;
  renderContent: ChatContentRenderer;
}) {
  const rawText = tail.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  const text = useStreamingText(rawText, true, tail.messageId);
  const content = text ? [{ type: "text" as const, text }] : [];
  return (
    <div
      className="animate-fade-in transcript-column px-4 py-2"
      data-message-id={tail.messageId}
    >
      {content.length > 0 ? (
        <div className="stream-caret">
          {renderContent({ content, role: "assistant", streaming: true })}
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">
          Working
          <BusyDots />
        </span>
      )}
    </div>
  );
}
