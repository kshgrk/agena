import { DropdownMenu } from "radix-ui";
import type { ComponentProps } from "react";
import { useUi } from "../store/ui.ts";
import { cx } from "./cx.ts";

/** Root: <Menu><MenuTrigger>…</MenuTrigger><MenuContent>…</MenuContent></Menu>
 * Bumps the overlay counter while open so the native browser view hides under
 * it (D-INV-3). ponytail: relies on Radix's balanced open→close onOpenChange;
 * a menu unmounted while open won't decrement — acceptable for transient menus. */
export function Menu({
  onOpenChange,
  ...rest
}: ComponentProps<typeof DropdownMenu.Root>) {
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        const ui = useUi.getState();
        if (open) ui.enterOverlay();
        else ui.exitOverlay();
        onOpenChange?.(open);
      }}
      {...rest}
    />
  );
}

/** asChild by default — pass a Button/IconButton as the single child. */
export function MenuTrigger(
  props: ComponentProps<typeof DropdownMenu.Trigger>,
) {
  return <DropdownMenu.Trigger asChild {...props} />;
}

export function MenuContent({
  className,
  sideOffset = 4,
  align = "start",
  ...rest
}: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={sideOffset}
        align={align}
        className={cx(
          "z-50 min-w-40 rounded-md border border-border bg-surface p-1 shadow-lg",
          className,
        )}
        {...rest}
      />
    </DropdownMenu.Portal>
  );
}

export function MenuItem({
  className,
  ...rest
}: ComponentProps<typeof DropdownMenu.Item>) {
  return (
    <DropdownMenu.Item
      className={cx(
        "flex cursor-default select-none items-center gap-2 rounded px-2 py-1 text-xs text-ink outline-none",
        "data-[highlighted]:bg-raised data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "[&>svg]:size-3.5 [&>svg]:text-ink-mute",
        className,
      )}
      {...rest}
    />
  );
}

export function MenuSeparator({
  className,
  ...rest
}: ComponentProps<typeof DropdownMenu.Separator>) {
  return (
    <DropdownMenu.Separator
      className={cx("my-1 h-px bg-border", className)}
      {...rest}
    />
  );
}
