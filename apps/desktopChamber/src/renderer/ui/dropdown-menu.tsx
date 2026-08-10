// Dropdown menu per design.md §16: bg-raised rounded-lg shadow-md p-1,
// 28px rows, destructive items text-danger. Class constants are shared with
// context-menu.tsx so the two menus stay pixel-identical.
import { Check } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";

export const menuContentCls =
  "z-50 min-w-40 rounded-lg border border-border bg-raised p-1 shadow-md animate-fade-in";

export const menuItemCls =
  "flex h-7 select-none items-center gap-2 rounded-md px-2 text-sm text-fg outline-none " +
  "data-[highlighted]:bg-fg/6 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 " +
  "[&>svg]:size-4 [&>svg]:text-fg-muted";

export const menuDangerItemCls =
  "text-danger data-[highlighted]:bg-danger/10 [&>svg]:text-danger";

export const menuSeparatorCls = "-mx-1 my-1 h-px bg-border-subtle";

export const menuLabelCls =
  "px-2 pb-1 pt-2 text-2xs font-medium uppercase tracking-wider text-fg-muted";

export const Menu = DropdownMenu.Root;

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
        className={cx(menuContentCls, className)}
        {...rest}
      />
    </DropdownMenu.Portal>
  );
}

export function MenuItem({
  className,
  danger,
  ...rest
}: ComponentProps<typeof DropdownMenu.Item> & { danger?: boolean }) {
  return (
    <DropdownMenu.Item
      className={cx(menuItemCls, danger && menuDangerItemCls, className)}
      {...rest}
    />
  );
}

export function MenuCheckboxItem({
  className,
  children,
  ...rest
}: ComponentProps<typeof DropdownMenu.CheckboxItem>) {
  return (
    <DropdownMenu.CheckboxItem
      className={cx(menuItemCls, "pr-8", className)}
      {...rest}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <DropdownMenu.ItemIndicator className="absolute right-2">
        <Check className="size-3.5 text-fg-muted" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.CheckboxItem>
  );
}

export function MenuSeparator({
  className,
  ...rest
}: ComponentProps<typeof DropdownMenu.Separator>) {
  return (
    <DropdownMenu.Separator
      className={cx(menuSeparatorCls, className)}
      {...rest}
    />
  );
}

export function MenuLabel({
  className,
  ...rest
}: ComponentProps<typeof DropdownMenu.Label>) {
  return (
    <DropdownMenu.Label className={cx(menuLabelCls, className)} {...rest} />
  );
}

/** Right-aligned shortcut chip inside a menu item. */
export function MenuShortcut({ children }: { children: ReactNode }) {
  return <kbd className="kbd ml-auto">{children}</kbd>;
}
