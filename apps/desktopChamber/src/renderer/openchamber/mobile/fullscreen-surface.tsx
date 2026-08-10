// Source-derived from OpenChamber apps/MobileFullscreenSurface.tsx (MIT).
import { ArrowLeft, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

const ENTER_DELAY_MS = 16;
const ENTER_DURATION_MS = 200;

export type MobileFullscreenSurfaceProps = {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  headerless?: boolean;
  disableEscapeDismiss?: boolean;
  variant?: "fullscreen" | "dialog";
  ariaLabel?: string;
};

export function OpenChamberMobileFullscreenSurface({
  open,
  onClose,
  title,
  subtitle,
  trailing,
  children,
  headerless = false,
  disableEscapeDismiss = false,
  variant = "fullscreen",
  ariaLabel,
}: MobileFullscreenSurfaceProps) {
  const [entered, setEntered] = useState(false);
  const [contentReady, setContentReady] = useState(false);
  const surface = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) {
      setEntered(false);
      setContentReady(false);
      return;
    }
    const enter = window.setTimeout(() => setEntered(true), ENTER_DELAY_MS);
    const fallback = window.setTimeout(
      () => setContentReady(true),
      ENTER_DELAY_MS + ENTER_DURATION_MS + 80,
    );
    return () => {
      window.clearTimeout(enter);
      window.clearTimeout(fallback);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => {
      const first = surface.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (first ?? surface.current)?.focus({ preventScroll: true });
    }, ENTER_DELAY_MS);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !disableEscapeDismiss) {
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !surface.current) return;
      const focusable = Array.from(
        surface.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", keydown);
      previousFocus.current?.focus({ preventScroll: true });
      previousFocus.current = null;
    };
  }, [disableEscapeDismiss, open]);

  if (!open) return null;
  const dialog = variant === "dialog";
  const body = (
    <section
      ref={surface}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      className={
        dialog
          ? "flex h-[min(88dvh,860px)] w-full max-w-[720px] flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl"
          : "oc-keyboard-inset-surface fixed inset-0 z-50 flex flex-col bg-background text-foreground"
      }
      style={
        dialog
          ? {
              opacity: entered ? 1 : 0,
              transform: entered ? "none" : "scale(0.97)",
              transition: `opacity ${ENTER_DURATION_MS}ms ease-out, transform ${ENTER_DURATION_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
            }
          : {
              paddingTop:
                "var(--oc-safe-area-top, env(safe-area-inset-top, 0px))",
              transform: entered ? "none" : "translateX(100%)",
              transition: `transform ${ENTER_DURATION_MS}ms cubic-bezier(0.32, 0.72, 0, 1)`,
            }
      }
      onTransitionEnd={(event) => {
        if (
          entered &&
          event.target === event.currentTarget &&
          event.propertyName === "transform"
        ) {
          setContentReady(true);
        }
      }}
    >
      {!headerless ? (
        <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 border-b border-border px-3">
          <button
            type="button"
            onClick={onClose}
            className="-ml-1 flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
            aria-label="Close"
          >
            {dialog ? (
              <X className="size-5" />
            ) : (
              <ArrowLeft className="size-5" />
            )}
          </button>
          <div className="min-w-0 flex-1 px-1">
            {title ? (
              <h2 className="truncate text-sm font-semibold">{title}</h2>
            ) : null}
            {subtitle ? (
              <p className="truncate text-xs text-muted-foreground">
                {subtitle}
              </p>
            ) : null}
          </div>
          {trailing}
        </header>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {contentReady ? (
          <div className="h-full animate-fade-in">{children}</div>
        ) : null}
      </div>
    </section>
  );
  if (!dialog) return body;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 transition-opacity duration-200"
      style={{ opacity: entered ? 1 : 0 }}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close dialog"
      />
      <div className="relative flex w-full max-w-[720px] justify-center">
        {body}
      </div>
    </div>
  );
}
