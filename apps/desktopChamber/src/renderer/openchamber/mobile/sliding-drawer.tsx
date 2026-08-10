// Source-derived from OpenChamber MobileSessionsSheet/MobileWorkspaceDrawer (MIT).
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

const ENTER_DELAY_MS = 16;
const DURATION_MS = 320;
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

export type SlidingDrawerProps = {
  open: boolean;
  side: "left" | "right";
  onClose: () => void;
  children: ReactNode;
  ariaLabel: string;
  className?: string;
};

export function OpenChamberSlidingDrawer({
  open,
  side,
  onClose,
  children,
  ariaLabel,
  className = "",
}: SlidingDrawerProps) {
  const [visible, setVisible] = useState(open);
  const [visited, setVisited] = useState(open);
  const [entered, setEntered] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (open) {
      setVisited(true);
      setVisible(true);
      const timer = window.setTimeout(() => setEntered(true), ENTER_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
    setEntered(false);
    const timer = window.setTimeout(() => setVisible(false), DURATION_MS + 40);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!visited) return null;
  const resting = side === "left" ? "translateX(-100%)" : "translateX(100%)";
  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-hidden={!open}
      className={`oc-keyboard-inset-surface fixed inset-0 z-50 flex min-h-0 flex-col bg-background text-foreground ${visible ? "" : "invisible"} ${className}`}
      style={{
        paddingTop: "var(--oc-safe-area-top, env(safe-area-inset-top, 0px))",
        paddingBottom:
          "var(--oc-safe-area-bottom-visual, env(safe-area-inset-bottom, 0px))",
        transform: entered ? "none" : resting,
        transition: `transform ${DURATION_MS}ms ${EASING}`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        <button
          type="button"
          onClick={onClose}
          className="flex size-10 items-center justify-center rounded-full text-muted-foreground active:bg-interactive-hover"
          aria-label={`Close ${ariaLabel.toLowerCase()}`}
        >
          <ArrowLeft className="size-5" />
        </button>
        <span className="text-sm font-semibold">{ariaLabel}</span>
      </header>
      {children}
    </section>
  );
}
