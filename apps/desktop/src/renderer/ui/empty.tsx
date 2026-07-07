import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./cx.ts";

export type EmptyStateProps = {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
};

/** Centered muted layout for empty/error/loading surfaces. */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        "flex h-full min-h-24 flex-col items-center justify-center gap-1.5 p-6 text-center",
        className,
      )}
    >
      {Icon ? <Icon className="mb-1 size-5 text-ink-mute" /> : null}
      <div className="text-[13px] text-ink-dim">{title}</div>
      {hint ? (
        <div className="max-w-64 text-xs text-ink-mute">{hint}</div>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
