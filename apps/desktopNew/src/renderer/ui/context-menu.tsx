// Context menu — identical styling to dropdown-menu.tsx via the shared
// class constants.
import { ContextMenu as RadixContextMenu } from "radix-ui";
import type { ComponentProps } from "react";
import { cx } from "./cx.ts";
import {
  menuContentCls,
  menuDangerItemCls,
  menuItemCls,
  menuLabelCls,
  menuSeparatorCls,
} from "./dropdown-menu.tsx";

export const ContextMenu = RadixContextMenu.Root;

/** asChild by default — wraps the right-clickable region. */
export function ContextMenuTrigger(
  props: ComponentProps<typeof RadixContextMenu.Trigger>,
) {
  return <RadixContextMenu.Trigger asChild {...props} />;
}

export function ContextMenuContent({
  className,
  ...rest
}: ComponentProps<typeof RadixContextMenu.Content>) {
  return (
    <RadixContextMenu.Portal>
      <RadixContextMenu.Content
        className={cx(menuContentCls, className)}
        {...rest}
      />
    </RadixContextMenu.Portal>
  );
}

export function ContextMenuItem({
  className,
  danger,
  ...rest
}: ComponentProps<typeof RadixContextMenu.Item> & { danger?: boolean }) {
  return (
    <RadixContextMenu.Item
      className={cx(menuItemCls, danger && menuDangerItemCls, className)}
      {...rest}
    />
  );
}

export function ContextMenuSeparator({
  className,
  ...rest
}: ComponentProps<typeof RadixContextMenu.Separator>) {
  return (
    <RadixContextMenu.Separator
      className={cx(menuSeparatorCls, className)}
      {...rest}
    />
  );
}

export function ContextMenuLabel({
  className,
  ...rest
}: ComponentProps<typeof RadixContextMenu.Label>) {
  return (
    <RadixContextMenu.Label className={cx(menuLabelCls, className)} {...rest} />
  );
}
