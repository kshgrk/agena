import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cx } from "./cx.ts";

const fieldBase =
  "w-full rounded border border-border bg-app text-[13px] text-ink placeholder:text-ink-mute " +
  "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent " +
  "disabled:pointer-events-none disabled:opacity-50";

export function TextInput({ className, ...rest }: ComponentProps<"input">) {
  return <input className={cx(fieldBase, "h-7 px-2", className)} {...rest} />;
}

export type TextAreaProps = ComponentProps<"textarea"> & {
  /** Grow with content (height tracks scrollHeight). */
  autoGrow?: boolean;
};

export function TextArea({
  autoGrow,
  className,
  onInput,
  ref,
  ...rest
}: TextAreaProps) {
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
        "px-2 py-1.5 leading-5",
        autoGrow ? "resize-none overflow-hidden" : "resize-y",
        className,
      )}
      {...rest}
    />
  );
}

/** A button styled like an input, with a trailing chevron (for pickers/menus). */
export function SelectLike({
  className,
  children,
  type,
  ...rest
}: ComponentProps<"button">) {
  return (
    <button
      type={type ?? "button"}
      className={cx(
        fieldBase,
        "inline-flex h-7 items-center justify-between gap-2 px-2 text-left",
        "focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent",
        className,
      )}
      {...rest}
    >
      <span className="truncate">{children}</span>
      <ChevronDown className="size-3.5 shrink-0 text-ink-mute" />
    </button>
  );
}
