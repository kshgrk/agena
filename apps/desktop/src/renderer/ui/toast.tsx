import { X } from "lucide-react";
import { create } from "zustand";
import type { BadgeTone } from "./badge.tsx";
import { cx } from "./cx.ts";

type ToastEntry = { id: number; message: string; tone: BadgeTone };

const useToastStore = create<{ toasts: ToastEntry[] }>(() => ({ toasts: [] }));

let nextId = 0;

function dismiss(id: number) {
  useToastStore.setState((s) => ({
    toasts: s.toasts.filter((t) => t.id !== id),
  }));
}

/** Fire-and-forget toast; auto-dismisses after 4s. */
export function toast(message: string, opts?: { tone?: BadgeTone }): void {
  const id = nextId++;
  useToastStore.setState((s) => ({
    toasts: [...s.toasts, { id, message, tone: opts?.tone ?? "neutral" }],
  }));
  setTimeout(() => dismiss(id), 4000);
}

const toneCls: Record<BadgeTone, string> = {
  neutral: "border-border text-ink",
  accent: "border-accent/40 text-accent",
  ok: "border-ok/40 text-ok",
  warn: "border-warn/40 text-warn",
  err: "border-err/40 text-err",
  info: "border-info/40 text-info",
};

/** Mount once near the app root: bottom-right stack. */
export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-50 flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cx(
            "pointer-events-auto flex max-w-96 items-center gap-2 rounded-md border bg-surface px-3 py-2 text-xs shadow-lg",
            toneCls[t.tone],
          )}
        >
          <span className="min-w-0 break-words">{t.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
            className="shrink-0 rounded text-ink-mute hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
