// Dock pane chrome per design.md §5: panels sit on bg-surface, one 1px
// subtle divider, 32px header.
import type { ReactNode } from "react";
import { cx } from "./cx.ts";

/** Pane wrapper: flex column, full height, scroll-safe. */
export function Panel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("flex h-full min-h-0 flex-col bg-surface", className)}>
      {children}
    </div>
  );
}

export type PanelHeaderProps = {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
};

/** Standard 32px pane header: quiet label left, icon actions right. */
export function PanelHeader({ title, actions, className }: PanelHeaderProps) {
  return (
    <div
      className={cx(
        "flex h-8 shrink-0 items-center justify-between gap-2",
        "border-b border-border-subtle px-3",
        className,
      )}
    >
      <div className="truncate text-xs font-medium text-fg-secondary">
        {title}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      ) : null}
    </div>
  );
}

/** Scrollable pane body. Pass scroll={false} for panes that manage their own
 * scrolling (virtualized lists, xterm). */
export function PanelBody({
  className,
  scroll = true,
  children,
}: {
  className?: string;
  scroll?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "min-h-0 flex-1",
        scroll ? "overflow-auto" : "overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}
