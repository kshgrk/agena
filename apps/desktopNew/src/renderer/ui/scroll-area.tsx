// ponytail: native overflow scrolling — theme.css already themes scrollbars
// globally (thin, trackless, token-colored). Radix ScrollArea would fight
// that; swap only if overlay scrollbars become a real requirement.
import type { ComponentProps } from "react";
import { cx } from "./cx.ts";

export type ScrollAreaProps = ComponentProps<"div"> & {
  /** Scroll axis. Default "y". */
  axis?: "x" | "y" | "both";
};

export function ScrollArea({ axis = "y", className, ...rest }: ScrollAreaProps) {
  return (
    <div
      className={cx(
        "min-h-0",
        axis === "y" && "overflow-y-auto overflow-x-hidden",
        axis === "x" && "overflow-x-auto overflow-y-hidden",
        axis === "both" && "overflow-auto",
        className,
      )}
      {...rest}
    />
  );
}
