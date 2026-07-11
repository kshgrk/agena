// Tooltip per design.md §16: bg-overlay, 500ms delay, instant for siblings.
import { Tooltip as RadixTooltip } from "radix-ui";
import type { ReactNode } from "react";
import { cx } from "./cx.ts";

/** Mount once near the app root; sets the shared 500ms delay. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={500} skipDelayDuration={300}>
      {children}
    </RadixTooltip.Provider>
  );
}

export type TooltipProps = {
  content: ReactNode;
  /** Optional shortcut rendered as a kbd chip after the content. */
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  /** Trigger — must accept a ref (plain elements or asChild-compatible). */
  children: ReactNode;
};

export function Tooltip({
  content,
  shortcut,
  side = "top",
  className,
  children,
}: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className={cx(
            "z-50 flex select-none items-center gap-1.5 rounded-md border border-border",
            "bg-overlay px-2 py-1 text-xs text-fg shadow-md animate-fade-in",
            className,
          )}
        >
          {content}
          {shortcut ? <kbd className="kbd">{shortcut}</kbd> : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
