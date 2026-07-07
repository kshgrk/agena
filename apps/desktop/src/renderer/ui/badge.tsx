import type { ReactNode } from "react";
import { cx } from "./cx.ts";

export type BadgeTone = "neutral" | "accent" | "ok" | "warn" | "err" | "info";

const toneCls: Record<BadgeTone, string> = {
  neutral: "border-border bg-raised text-ink-dim",
  accent: "border-accent/30 bg-accent/10 text-accent",
  ok: "border-ok/30 bg-ok/10 text-ok",
  warn: "border-warn/30 bg-warn/10 text-warn",
  err: "border-err/30 bg-err/10 text-err",
  info: "border-info/30 bg-info/10 text-info",
};

export type BadgeProps = {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
};

export function Badge({ tone = "neutral", className, children }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium leading-4",
        toneCls[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export type StatusDotStatus =
  | "active"
  | "idle"
  | "archived"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

const dotCls: Record<StatusDotStatus, string> = {
  active: "bg-ok",
  idle: "bg-ink-mute",
  archived: "bg-ink-mute/50",
  connecting: "bg-warn",
  connected: "bg-ok",
  reconnecting: "bg-warn",
  closed: "bg-err",
};

const PULSING: ReadonlySet<StatusDotStatus> = new Set([
  "active",
  "reconnecting",
]);

export type StatusDotProps = {
  status: StatusDotStatus;
  className?: string;
};

/** 6px status dot; pulses while active/reconnecting. */
export function StatusDot({ status, className }: StatusDotProps) {
  return (
    <span
      role="status"
      aria-label={status}
      title={status}
      className={cx(
        "inline-block size-1.5 shrink-0 rounded-full",
        dotCls[status],
        PULSING.has(status) && "animate-pulse",
        className,
      )}
    />
  );
}
