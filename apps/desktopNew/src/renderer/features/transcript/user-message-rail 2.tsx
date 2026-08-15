import type { UserMessageAnchor } from "@agena/protocol";
import { useEffect, useRef, useState } from "react";
import { getBridge, useTranscripts, useUi } from "../../store/index.ts";
import { cx, Popover, PopoverAnchor, PopoverContent } from "../../ui/index.ts";
import {
  messageIndexAtPosition,
  messagePositionCss,
  messageRailLayout,
} from "./user-message-rail-logic.ts";

const MIN_MESSAGES = 4;

export function UserMessageRail({
  sessionId,
  userVersion,
  visibleSeqs,
  className,
}: {
  sessionId: string;
  userVersion: number;
  visibleSeqs: ReadonlySet<number>;
  className?: string | undefined;
}) {
  const [messages, setMessages] = useState<readonly UserMessageAnchor[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const dragging = useRef(false);
  const lastSeq = useRef<number | null>(null);
  const railRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: userVersion refetches after a newly ingested prompt
  useEffect(() => {
    let alive = true;
    void getBridge()
      ?.listUserMessages(sessionId)
      .then((next) => {
        if (alive) setMessages(next);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, userVersion]);

  if (messages.length < MIN_MESSAGES) return null;

  const reveal = (message: UserMessageAnchor) => {
    if (lastSeq.current === message.seq) return;
    lastSeq.current = message.seq;
    void useTranscripts
      .getState()
      .revealSeq(sessionId, message.seq)
      .then(() => useUi.getState().requestJump(sessionId, message.seq));
  };

  const previewAt = (clientY: number) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return null;
    const index = messageIndexAtPosition(
      clientY - rect.top,
      messages.length,
      messageRailLayout(messages.length, rect.height),
    );
    if (index === null) return null;
    const message = messages[index] ?? null;
    if (message) setPreviewIndex(index);
    return message;
  };

  const selectedIndex = messages.findIndex((message) =>
    visibleSeqs.has(message.seq),
  );
  const activeIndex = previewIndex ?? selectedIndex;
  const preview =
    previewIndex === null
      ? null
      : { index: previewIndex, message: messages[previewIndex] ?? null };
  const railBounds = preview ? railRef.current?.getBoundingClientRect() : null;
  const previewCollisionPadding = railBounds
    ? {
        top: railBounds.top + 12,
        right: 12,
        bottom: window.innerHeight - railBounds.bottom + 12,
        left: 12,
      }
    : 12;
  const selectIndex = (index: number) => {
    const message = messages[index];
    if (!message) return;
    setPreviewIndex(index);
    reveal(message);
  };
  return (
    <div
      ref={railRef}
      role="slider"
      aria-label="User message timeline"
      aria-valuemin={1}
      aria-valuemax={messages.length}
      aria-valuenow={Math.max(1, activeIndex + 1)}
      aria-valuetext={
        preview
          ? `${preview.index + 1} of ${messages.length}: ${preview.message?.preview ?? "User message"}`
          : undefined
      }
      tabIndex={0}
      className={cx(
        "relative z-20 hidden min-h-0 w-7 self-stretch cursor-ns-resize touch-none lg:block",
        className,
      )}
      onPointerDown={(event) => {
        dragging.current = true;
        lastSeq.current = null;
        event.currentTarget.setPointerCapture(event.pointerId);
        const message = previewAt(event.clientY);
        if (message) reveal(message);
      }}
      onPointerMove={(event) => {
        const message = previewAt(event.clientY);
        if (dragging.current && message) reveal(message);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
        lastSeq.current = null;
      }}
      onPointerLeave={() => {
        if (!dragging.current) setPreviewIndex(null);
      }}
      onKeyDown={(event) => {
        const current = Math.max(0, activeIndex);
        let next: number | null = null;
        if (event.key === "ArrowUp") next = current - 1;
        else if (event.key === "ArrowDown") next = current + 1;
        else if (event.key === "PageUp") next = current - 10;
        else if (event.key === "PageDown") next = current + 10;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = messages.length - 1;
        if (next === null) return;
        event.preventDefault();
        selectIndex(Math.min(messages.length - 1, Math.max(0, next)));
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-3"
      >
        <span className="absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-border-subtle" />
        {messages.map((message, index) => (
          <span
            key={message.messageId}
            style={{ top: messagePositionCss(index, messages.length) }}
            className={cx(
              "absolute right-0 h-px w-3 -translate-y-1/2 rounded-full bg-fg-muted/45",
              activeIndex === index && "bg-accent",
            )}
          />
        ))}
      </div>
      {preview ? (
        <Popover key={preview.index} open>
          <PopoverAnchor asChild>
            <span
              aria-hidden
              className="pointer-events-none absolute right-0 size-px"
              style={{
                top: messagePositionCss(preview.index, messages.length),
              }}
            />
          </PopoverAnchor>
          <PopoverContent
            side="right"
            align="center"
            sideOffset={8}
            collisionPadding={previewCollisionPadding}
            onOpenAutoFocus={(event) => event.preventDefault()}
            className="pointer-events-none w-80 bg-surface px-3 py-2 text-sm text-fg shadow-lg"
          >
            <span role="status">
              <span className="mr-2 text-fg-muted tabular-nums">
                {preview.index + 1}/{messages.length}
              </span>
              {preview.message?.preview || "User message"}
            </span>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
