import { Check, Minus } from "lucide-react";
import { Checkbox as RadixCheckbox } from "radix-ui";
import type { ComponentProps } from "react";
import { cx } from "./cx.ts";

export type CheckboxProps = ComponentProps<typeof RadixCheckbox.Root>;

export function Checkbox({ className, checked, ...rest }: CheckboxProps) {
  return (
    <RadixCheckbox.Root
      // conditional spread keeps uncontrolled usage valid under
      // exactOptionalPropertyTypes
      {...(checked === undefined ? {} : { checked })}
      className={cx(
        "flex size-4 shrink-0 items-center justify-center rounded-sm border",
        "border-border bg-inset transition-colors",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        "data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      <RadixCheckbox.Indicator className="text-accent-fg">
        {checked === "indeterminate" ? (
          <Minus className="size-3" strokeWidth={3} />
        ) : (
          <Check className="size-3" strokeWidth={3} />
        )}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}
