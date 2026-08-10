// Composed radix Select: trigger styled as an input trough, popper content
// styled per the menu/popover spec (design.md §16).
import { Check, ChevronDown } from "lucide-react";
import { Select as RadixSelect } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";

export type SelectOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
};

export type SelectProps = ComponentProps<typeof RadixSelect.Root> & {
  options: readonly SelectOption[];
  placeholder?: ReactNode;
  /** md = h-7 (inline chrome) · lg = h-8 (settings forms, default). */
  fieldSize?: "md" | "lg";
  /** Trigger className. */
  className?: string;
  /** Accessible name for the trigger when no visible label is associated. */
  ariaLabel?: string;
};

export function Select({
  options,
  placeholder,
  fieldSize = "lg",
  className,
  ariaLabel,
  ...root
}: SelectProps) {
  return (
    <RadixSelect.Root {...root}>
      <RadixSelect.Trigger
        aria-label={ariaLabel}
        className={cx(
          "inline-flex w-full items-center justify-between gap-2 rounded-md border",
          "border-border bg-inset text-sm text-fg transition-colors",
          "focus:border-accent/50 data-[placeholder]:text-fg-muted",
          "disabled:pointer-events-none disabled:opacity-50",
          fieldSize === "md" ? "h-7 px-2" : "h-8 px-2.5",
          className,
        )}
      >
        <span className="truncate">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon asChild>
          <ChevronDown className="size-3.5 shrink-0 text-fg-muted" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className={cx(
            "z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden",
            "rounded-lg border border-border bg-raised p-1 shadow-md animate-fade-in",
          )}
        >
          <RadixSelect.Viewport>
            {options.map((opt) => (
              <RadixSelect.Item
                key={opt.value}
                value={opt.value}
                {...(opt.disabled ? { disabled: true } : {})}
                className={cx(
                  "relative flex h-7 select-none items-center rounded-md pl-2 pr-8",
                  "text-sm text-fg outline-none data-[highlighted]:bg-fg/6",
                  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                )}
              >
                <RadixSelect.ItemText>
                  <span className="truncate">{opt.label}</span>
                </RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="absolute right-2">
                  <Check className="size-3.5 text-fg-muted" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
