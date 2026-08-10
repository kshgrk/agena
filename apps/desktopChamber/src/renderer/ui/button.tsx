// Buttons per design.md §16. Heights: h-6 inline (sm) · h-7 default (md) ·
// h-8 settings forms (lg). Focus rings come from the global :focus-visible
// style in theme.css — never add per-component focus styles.
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { Tooltip } from "./tooltip.tsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger-ghost";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 " +
  "rounded-md text-sm font-medium transition-colors " +
  "disabled:pointer-events-none disabled:opacity-50";

const variantCls: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-active",
  secondary:
    "border border-border bg-raised text-fg hover:border-border-strong",
  ghost: "text-fg-secondary hover:bg-fg/6",
  "danger-ghost": "text-danger hover:bg-danger/10",
};

const sizeCls: Record<ButtonSize, string> = {
  sm: "h-6 px-2 text-xs",
  md: "h-7 px-3",
  lg: "h-8 px-3",
};

export type ButtonProps = ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon node (sized to 16px; icon color follows text). */
  icon?: ReactNode;
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  type,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cx(base, variantCls[variant], sizeCls[size], className)}
      {...rest}
    >
      {icon != null ? (
        <span className="shrink-0 [&>svg]:size-4">{icon}</span>
      ) : null}
      {children}
    </button>
  );
}

const iconSizeCls: Record<ButtonSize, string> = {
  sm: "size-6 [&>svg]:size-3.5",
  md: "size-7 [&>svg]:size-4",
  lg: "size-8 [&>svg]:size-4",
};

export type IconButtonProps = Omit<ComponentProps<"button">, "children"> & {
  /** Tooltip text + aria-label. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Skip the tooltip (label still becomes the aria-label). */
  noTooltip?: boolean;
  /** The icon. */
  children: ReactNode;
};

export function IconButton({
  label,
  variant = "ghost",
  size = "md",
  noTooltip,
  className,
  children,
  type,
  ...rest
}: IconButtonProps) {
  const btn = (
    <button
      type={type ?? "button"}
      aria-label={label}
      className={cx(
        base,
        variantCls[variant],
        iconSizeCls[size],
        "p-0",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  return noTooltip ? btn : <Tooltip content={label}>{btn}</Tooltip>;
}
