import { cx } from "./cx.ts";

/** 12px inline spinner (pure CSS border animation). */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cx(
        "inline-block size-3 animate-spin rounded-full border border-ink-mute/40 border-t-accent",
        className,
      )}
    />
  );
}

/** "●●●" subtle pulse for streaming states. */
export function StreamingDots({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Streaming"
      className={cx(
        "inline-flex items-center gap-0.5 text-[8px] leading-none text-ink-mute",
        className,
      )}
    >
      <span className="animate-pulse">●</span>
      <span className="animate-pulse [animation-delay:200ms]">●</span>
      <span className="animate-pulse [animation-delay:400ms]">●</span>
    </span>
  );
}
