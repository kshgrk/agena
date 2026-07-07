import type { ReactNode } from "react";
import { cx } from "./cx.ts";

export type PanelHeaderProps = {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
};

/** Standard 32px pane header. */
export function PanelHeader({ title, actions, className }: PanelHeaderProps) {
  return (
    <div
      className={cx(
        "flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-3",
        className,
      )}
    >
      <div className="truncate text-[11px] font-medium uppercase tracking-wider text-ink-mute">
        {title}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      ) : null}
    </div>
  );
}

/** Pane wrapper: flex column, full height, scroll-safe. */
export function PanelShell({
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
