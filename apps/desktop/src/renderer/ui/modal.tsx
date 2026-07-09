import { Dialog } from "radix-ui";
import { type ReactNode, useEffect } from "react";
import { useUi } from "../store/ui.ts";
import { cx } from "./cx.ts";

export type ModalSize = "sm" | "md" | "lg";

const sizeCls: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
};

export type ModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  size?: ModalSize;
  className?: string;
  /** Include a <ModalTitle> for accessibility. */
  children: ReactNode;
};

export function Modal({
  open,
  onOpenChange,
  size = "md",
  className,
  children,
}: ModalProps) {
  // D-INV-3: a modal is an overlay — the native browser WebContentsView must
  // hide while it's up (it paints above ALL DOM, incl. the approval modal).
  useEffect(() => {
    if (!open) return;
    const ui = useUi.getState();
    ui.enterOverlay();
    return () => ui.exitOverlay();
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in" />
        <Dialog.Content
          className={cx(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
            "rounded-lg border border-border bg-raised p-4 shadow-xl focus:outline-none",
            sizeCls[size],
            className,
          )}
        >
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ModalTitle({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Title className={cx("text-sm font-semibold text-ink", className)}>
      {children}
    </Dialog.Title>
  );
}

export function ModalDescription({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Description className={cx("mt-1 text-xs text-ink-dim", className)}>
      {children}
    </Dialog.Description>
  );
}

export function ModalFooter({
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

/** Radix close-on-click wrapper (wrap a Button with asChild semantics). */
export const ModalClose = Dialog.Close;
