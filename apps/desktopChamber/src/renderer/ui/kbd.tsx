import type { ReactNode } from "react";
import { cx } from "./cx.ts";

/** Keyboard shortcut chip — the .kbd component class from theme.css. */
export function Kbd({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <kbd className={cx("kbd", className)}>{children}</kbd>;
}
