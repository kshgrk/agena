import type { ReactNode } from "react";
import { cx } from "./cx.ts";

/** 11px mono keycap chip (palette + tooltips). */
export function Kbd({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <kbd
      className={cx(
        "inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-raised px-1",
        "font-mono text-[11px] leading-none text-ink-dim",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
