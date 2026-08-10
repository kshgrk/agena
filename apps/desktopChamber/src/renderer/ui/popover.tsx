// Popover per design.md §16: bg-raised border rounded-lg shadow-md p-1.
import { Popover as RadixPopover } from "radix-ui";
import type { ComponentProps } from "react";
import { cx } from "./cx.ts";

export const Popover = RadixPopover.Root;
export const PopoverClose = RadixPopover.Close;
export const PopoverAnchor = RadixPopover.Anchor;

/** asChild by default — pass a Button/IconButton as the single child. */
export function PopoverTrigger(
  props: ComponentProps<typeof RadixPopover.Trigger>,
) {
  return <RadixPopover.Trigger asChild {...props} />;
}

export function PopoverContent({
  className,
  sideOffset = 6,
  align = "start",
  ...rest
}: ComponentProps<typeof RadixPopover.Content>) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        sideOffset={sideOffset}
        align={align}
        className={cx(
          "z-50 rounded-lg border border-border bg-raised p-1 shadow-md",
          "animate-fade-in",
          className,
        )}
        {...rest}
      />
    </RadixPopover.Portal>
  );
}
