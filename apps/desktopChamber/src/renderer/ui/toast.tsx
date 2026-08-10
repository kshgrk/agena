// Toast VIEW primitives per design.md §14 — presentation only. Queueing,
// auto-dismiss timing, and the max-3-visible rule live in store/ui.ts
// (pushToast); features never render their own floating notifications.
import type { LucideIcon } from "lucide-react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "./cx.ts";

export type ToastKind = "info" | "success" | "warn" | "danger";

const kindIcon: Record<ToastKind, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warn: TriangleAlert,
  danger: CircleAlert,
};

const kindCls: Record<ToastKind, string> = {
  info: "text-info",
  success: "text-success",
  warn: "text-warn",
  danger: "text-danger",
};

export type ToastViewProps = {
  kind: ToastKind;
  title: string;
  detail?: string;
  /** The single optional action a toast may carry (design.md §14). */
  onView?: () => void;
  viewLabel?: string;
  /** Plays the 140ms exit fade (design.md §14) while the store drops it. */
  closing?: boolean;
  onDismiss: () => void;
};

export function ToastView({
  kind,
  title,
  detail,
  onView,
  viewLabel = "View",
  closing = false,
  onDismiss,
}: ToastViewProps) {
  const Icon = kindIcon[kind];
  return (
    <div
      role="status"
      className={cx(
        "pointer-events-auto flex w-[340px] items-start gap-2 rounded-lg border",
        "border-border bg-overlay p-3 shadow-lg",
        closing ? "animate-toast-out" : "animate-fade-slide-in",
      )}
    >
      <Icon className={cx("mt-0.5 size-4 shrink-0", kindCls[kind])} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg">{title}</div>
        {detail ? (
          <div className="mt-0.5 break-words text-xs text-fg-muted">
            {detail}
          </div>
        ) : null}
        {onView ? (
          <button
            type="button"
            onClick={onView}
            className="mt-1 text-xs text-accent hover:underline"
          >
            {viewLabel}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0 rounded-sm text-fg-muted transition-colors hover:text-fg"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** Fixed bottom-right stack; mount once near the app root. */
export function ToastViewport({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-50 flex flex-col items-end gap-2">
      {children}
    </div>
  );
}
