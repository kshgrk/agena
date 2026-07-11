import { Progress as RadixProgress } from "radix-ui";
import { cx } from "./cx.ts";

export type ProgressProps = {
  /** 0–100. Omit for indeterminate. */
  value?: number;
  className?: string;
};

export function Progress({ value, className }: ProgressProps) {
  const clamped =
    value === undefined ? null : Math.min(100, Math.max(0, value));
  return (
    <RadixProgress.Root
      value={clamped}
      className={cx(
        "relative h-1 w-full overflow-hidden rounded-full bg-fg/10",
        className,
      )}
    >
      <RadixProgress.Indicator
        className={cx(
          "h-full rounded-full bg-accent transition-transform",
          clamped === null && "w-1/3 animate-pulse-soft",
        )}
        style={
          clamped === null
            ? undefined
            : { transform: `translateX(-${100 - clamped}%)` }
        }
      />
    </RadixProgress.Root>
  );
}
