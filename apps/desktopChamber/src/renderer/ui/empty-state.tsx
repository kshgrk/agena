// Empty state per design.md §14: one icon, heading, one sentence, at most
// one action. Max width 320px. No illustrations.
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
        "flex h-full min-h-24 flex-col items-center justify-center p-6 text-center",
        className,
      )}
    >
      <div className="flex max-w-80 flex-col items-center gap-2">
        {Icon ? <Icon className="size-8 text-fg-faint" /> : null}
        <div className="text-xl font-semibold text-fg-secondary">{title}</div>
        {hint ? <div className="text-sm text-fg-muted">{hint}</div> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}
