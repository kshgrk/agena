// Tabs per design.md §5 (dockview tab spec): 32px tall, text-xs, active tab
// text-fg with a 1px accent underline. No tab backgrounds.
import { Tabs as RadixTabs } from "radix-ui";
import type { ComponentProps } from "react";
import { cx } from "./cx.ts";

export const Tabs = RadixTabs.Root;

export function TabsList({
  className,
  ...rest
}: ComponentProps<typeof RadixTabs.List>) {
  return (
    <RadixTabs.List
      className={cx(
        "flex h-8 shrink-0 items-center gap-1 border-b border-border-subtle",
        className,
      )}
      {...rest}
    />
  );
}

export function TabsTrigger({
  className,
  ...rest
}: ComponentProps<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cx(
        "relative flex h-8 select-none items-center gap-1.5 px-2 text-xs text-fg-muted",
        "transition-colors hover:text-fg-secondary data-[state=active]:text-fg",
        "after:absolute after:inset-x-0 after:bottom-0 after:h-px",
        "data-[state=active]:after:bg-accent",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...rest}
    />
  );
}

export function TabsContent({
  className,
  ...rest
}: ComponentProps<typeof RadixTabs.Content>) {
  return (
    <RadixTabs.Content
      className={cx("min-h-0 flex-1 outline-none", className)}
      {...rest}
    />
  );
}
