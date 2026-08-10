// Text fields per design.md §13: bg-inset trough, border shift on focus
// (border-accent/50 — no ring; the global :focus-visible outline covers
// keyboard navigation).
import type { ComponentProps } from "react";
import { cx } from "./cx.ts";

const fieldBase =
  "w-full rounded-md border border-border bg-inset text-sm text-fg " +
  "placeholder:text-fg-muted transition-colors focus:border-accent/50 " +
  "disabled:pointer-events-none disabled:opacity-50";

export type InputProps = Omit<ComponentProps<"input">, "size"> & {
  /** md = h-7 (inline chrome) · lg = h-8 (settings forms, default). */
  fieldSize?: "md" | "lg";
};

export function Input({ fieldSize = "lg", className, ...rest }: InputProps) {
  return (
    <input
      className={cx(
        fieldBase,
        fieldSize === "md" ? "h-7 px-2" : "h-8 px-2.5",
        className,
      )}
      {...rest}
    />
  );
}

export type TextareaProps = ComponentProps<"textarea"> & {
  /** Grow with content (height tracks scrollHeight). */
  autoGrow?: boolean;
};

export function Textarea({
  autoGrow,
  className,
  onInput,
  ref,
  ...rest
}: TextareaProps) {
  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  return (
    <textarea
      ref={(el) => {
        if (el && autoGrow) grow(el);
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      onInput={(e) => {
        if (autoGrow) grow(e.currentTarget);
        onInput?.(e);
      }}
      className={cx(
        fieldBase,
        "px-2.5 py-1.5",
        autoGrow ? "resize-none overflow-hidden" : "resize-y",
        className,
      )}
      {...rest}
    />
  );
}
