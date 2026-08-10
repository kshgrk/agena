// Badge per design.md §16: text-2xs rounded-full on /10 washes with matching
// text token. StatusDot pairs the .status-dot theme class with a bg-* utility.
import type { ReactNode } from "react";
import { cx } from "./cx.ts";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "success"
  | "warn"
  | "danger"
  | "info";

const toneCls: Record<BadgeTone, string> = {
  neutral: "bg-fg/10 text-fg-secondary",
  accent: "bg-accent/10 text-accent",
  success: "bg-success/10 text-success",
  warn: "bg-warn/10 text-warn",
  danger: "bg-danger/10 text-danger",
  info: "bg-info/10 text-info",
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
        "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-2xs font-medium",
        toneCls[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export type StatusDotProps = {
  /** bg-* token utility, e.g. "bg-success" or "bg-warn animate-pulse-soft". */
  className: string;
  /** Accessible label ("connected", "pending approval", …). */
  label?: string;
};

/** 6px status dot (sessions, MCP servers, statusbar). */
export function StatusDot({ className, label }: StatusDotProps) {
  return (
    <span
      className={cx("status-dot", className)}
      role={label ? "status" : undefined}
      aria-label={label}
      title={label}
    />
  );
}
