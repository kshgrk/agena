// Segmented control: single-select chip row on an inset trough. Selected
// segment lifts to bg-raised (one layer above its parent, per design.md §3).
import { ToggleGroup } from "radix-ui";
import type { ReactNode } from "react";
import { cx } from "./cx.ts";

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  disabled?: boolean;
};

export type SegmentedProps<T extends string> = {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** Accessible name for the group. */
  ariaLabel?: string;
  className?: string;
};

export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  ariaLabel,
  className,
}: SegmentedProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => {
        // radix emits "" when the active item is re-clicked; single-select
        // segmented controls never deselect.
        if (v) onValueChange(v as T);
      }}
      aria-label={ariaLabel}
      className={cx(
        "inline-flex items-center gap-0.5 rounded-md border border-border-subtle bg-inset p-0.5",
        className,
      )}
    >
      {options.map((opt) => (
        <ToggleGroup.Item
          key={opt.value}
          value={opt.value}
          disabled={opt.disabled}
          className={cx(
            "flex h-6 select-none items-center rounded-sm px-2 text-xs text-fg-muted",
            "transition-colors hover:text-fg-secondary",
            "data-[state=on]:bg-raised data-[state=on]:text-fg",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          {opt.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
