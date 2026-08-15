// Dialog per design.md §12/§14: bg-overlay surface, rounded-xl,
// shadow-overlay, bg-canvas/60 backdrop (no blur — banned app-wide).
import { Dialog as RadixDialog } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";

export type DialogSize = "sm" | "md" | "lg";

const sizeCls: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
};

export type DialogProps = ComponentProps<typeof RadixDialog.Root> & {
  size?: DialogSize;
  bottomSheet?: boolean;
  /** Content className. */
  className?: string;
  /** Include a <DialogTitle> for accessibility. */
  children: ReactNode;
};

export function Dialog({
  size = "md",
  bottomSheet = false,
  className,
  children,
  ...root
}: DialogProps) {
  return (
    <RadixDialog.Root {...root}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-canvas/60 animate-fade-in" />
        <RadixDialog.Content
          className={cx(
            "fixed left-1/2 z-50 w-[calc(100vw-32px)] -translate-x-1/2",
            bottomSheet ? "bottom-0" : "top-1/2 -translate-y-1/2",
            "rounded-xl border border-border bg-overlay p-4 shadow-overlay",
            "max-md:bottom-0 max-md:top-auto max-md:w-full max-md:max-w-none max-md:translate-y-0 max-md:rounded-b-none max-md:pb-[max(1rem,env(safe-area-inset-bottom))]",
            "animate-fade-in",
            sizeCls[size],
            className,
          )}
        >
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export function DialogTitle({
  className,
  ...rest
}: ComponentProps<typeof RadixDialog.Title>) {
  return (
    <RadixDialog.Title
      className={cx("text-lg font-semibold text-fg", className)}
      {...rest}
    />
  );
}

export function DialogDescription({
  className,
  ...rest
}: ComponentProps<typeof RadixDialog.Description>) {
  return (
    <RadixDialog.Description
      className={cx("mt-1 text-sm text-fg-muted", className)}
      {...rest}
    />
  );
}

export function DialogFooter({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("mt-4 flex items-center justify-end gap-2", className)}>
      {children}
    </div>
  );
}

/** Radix close-on-click wrapper (use asChild around a Button). */
export const DialogClose = RadixDialog.Close;
