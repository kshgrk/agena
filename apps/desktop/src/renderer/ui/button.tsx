import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { Tooltip } from "./tooltip.tsx";

export type ButtonVariant = "solid" | "ghost" | "subtle" | "danger";
export type ButtonSize = "sm" | "md";

const base =
  "inline-flex items-center justify-center rounded font-medium select-none transition-colors " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent " +
  "disabled:pointer-events-none disabled:opacity-50";

const variantCls: Record<ButtonVariant, string> = {
  solid: "bg-accent text-on-accent hover:bg-accent-hi",
  ghost: "bg-transparent text-ink-dim hover:bg-raised hover:text-ink",
  subtle:
    "bg-raised text-ink border border-border hover:border-border-strong hover:bg-overlay",
  danger: "bg-err/10 text-err border border-err/30 hover:bg-err/20",
};

const sizeCls: Record<ButtonSize, string> = {
  sm: "h-6 gap-1 px-2 text-xs",
  md: "h-7 gap-1.5 px-3 text-[13px]",
};

export type ButtonProps = ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon node (sized to 14px). */
  icon?: ReactNode;
};

export function Button({
  variant = "subtle",
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
        <span className="shrink-0 [&>svg]:size-3.5">{icon}</span>
      ) : null}
      {children}
    </button>
  );
}

export type IconButtonProps = Omit<ComponentProps<"button">, "children"> & {
  /** Tooltip text + aria-label. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** The icon. */
  children: ReactNode;
};

export function IconButton({
  label,
  variant = "ghost",
  size = "md",
  className,
  children,
  type,
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip content={label}>
      <button
        type={type ?? "button"}
        aria-label={label}
        className={cx(
          base,
          variantCls[variant],
          size === "sm" ? "size-6" : "size-7",
          "p-0 [&>svg]:size-3.5",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
}
