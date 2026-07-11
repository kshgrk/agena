// Toast host — mounted ALWAYS by the shell. Renders the store's toast queue
// (store/ui pushToast, ARCHITECTURE contract 4) through the ui-kit viewport,
// adding hover-pause (hovered toasts outlive their store timer) and the one
// optional action button (push.ts). Features never render their own floating
// notifications.
import { useEffect, useState } from "react";
import type { Toast, ToastKind as StoreToastKind } from "../../store/index.ts";
import { useUi } from "../../store/index.ts";
import type { ToastKind as ViewToastKind } from "../../ui/index.ts";
import { ToastView, ToastViewport } from "../../ui/index.ts";
import { pruneToastActions, toastAction } from "./push.ts";

const KIND: Record<StoreToastKind, ViewToastKind> = {
  info: "info",
  ok: "success",
  warn: "warn",
  err: "danger",
};

const MAX_VISIBLE = 3; // design.md §14

export function ToastsHost() {
  const toasts = useUi((s) => s.toasts);
  const dismissToast = useUi((s) => s.dismissToast);
  // Hover-pause: while hovered we render this held snapshot, so toasts whose
  // store timer fires under the cursor stay visible; leaving drops them.
  // (null = not hovered.)
  const [held, setHeld] = useState<readonly Toast[] | null>(null);

  // New toasts arriving mid-hover still append to the held stack.
  useEffect(() => {
    setHeld((prev) => {
      if (prev === null) return null;
      const ids = new Set(prev.map((t) => t.id));
      const fresh = toasts.filter((t) => !ids.has(t.id));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }, [toasts]);

  const visible = (held ?? toasts).slice(-MAX_VISIBLE);

  // Housekeeping: drop action entries for toasts gone from every list.
  useEffect(() => {
    pruneToastActions(new Set([...toasts, ...(held ?? [])].map((t) => t.id)));
  }, [toasts, held]);

  const dismiss = (id: number) => {
    dismissToast(id);
    setHeld((prev) => (prev === null ? null : prev.filter((t) => t.id !== id)));
  };

  if (visible.length === 0) return null;
  return (
    <ToastViewport>
      <div
        className="pointer-events-auto flex flex-col items-end gap-2"
        onPointerEnter={() => setHeld(useUi.getState().toasts)}
        onPointerLeave={() => setHeld(null)}
      >
        {visible.map((t) => {
          const action = toastAction(t.id);
          return (
            <ToastView
              key={t.id}
              kind={KIND[t.kind]}
              title={t.title}
              {...(t.closing ? { closing: true } : {})}
              {...(t.detail !== undefined ? { detail: t.detail } : {})}
              {...(action
                ? {
                    viewLabel: action.label,
                    onView: () => {
                      action.run();
                      dismiss(t.id);
                    },
                  }
                : {})}
              onDismiss={() => dismiss(t.id)}
            />
          );
        })}
      </div>
    </ToastViewport>
  );
}
