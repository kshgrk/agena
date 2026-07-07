import { Tooltip as RadixTooltip } from "radix-ui";
import type { ReactNode } from "react";
import { cx } from "./cx.ts";

/** Mount once near the app root; sets the shared 150ms delay. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={150} skipDelayDuration={300}>
      {children}
    </RadixTooltip.Provider>
  );
}

export type TooltipProps = {
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  /** Trigger — must accept a ref (plain elements or asChild-compatible). */
  children: ReactNode;
};

export function Tooltip({
  content,
  side = "top",
  className,
  children,
}: TooltipProps) {
  return (
    <RadixTooltip.Root delayDuration={150}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className={cx(
            "z-50 select-none rounded border border-border bg-surface px-2 py-1 text-xs text-ink shadow-md",
            className,
          )}
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
