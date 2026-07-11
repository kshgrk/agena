// Toggle per design.md §13: 32×18, checked bg-accent, unchecked bg-fg/15.
import { Switch as RadixSwitch } from "radix-ui";
import type { ComponentProps } from "react";
import { cx } from "./cx.ts";

export type SwitchProps = ComponentProps<typeof RadixSwitch.Root>;

export function Switch({ className, ...rest }: SwitchProps) {
  return (
    <RadixSwitch.Root
      className={cx(
        // 32×18 per design.md §13 (doc-specified pixel values)
        "relative h-[18px] w-8 shrink-0 rounded-full bg-fg/15 transition-colors",
        "data-[state=checked]:bg-accent",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      <RadixSwitch.Thumb
        className={cx(
          "block size-3.5 translate-x-[2px] rounded-full bg-accent-fg shadow-sm",
          "transition-transform data-[state=checked]:translate-x-[16px]",
        )}
      />
    </RadixSwitch.Root>
  );
}
