// Source-derived from OpenChamber components/layout/Sidebar.tsx (MIT).
import type {
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 220;
const MAX_WIDTH = 480;
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

export type OpenChamberSidebarProps = {
  open: boolean;
  width?: number;
  onWidthChange?: (width: number) => void;
  topBar?: ReactNode;
  children: ReactNode;
  className?: string;
};

const clamp = (width: number): number =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));

export function OpenChamberSidebar({
  open,
  width = DEFAULT_WIDTH,
  onWidthChange,
  topBar,
  children,
  className = "",
}: OpenChamberSidebarProps) {
  const [resizing, setResizing] = useState(false);
  const startX = useRef(0);
  const startWidth = useRef(clamp(width));
  const liveWidth = useRef<number | null>(null);
  const pointerId = useRef<number | null>(null);
  const aside = useRef<HTMLElement | null>(null);
  const resolvedWidth = clamp(width);

  const paintWidth = useCallback((next: number) => {
    const element = aside.current;
    if (!element) return;
    const value = `${next}px`;
    element.style.width = value;
    element.style.minWidth = value;
    element.style.maxWidth = value;
    element.style.setProperty("--oc-left-sidebar-width", value);
  }, []);

  useEffect(() => {
    if (!resizing) {
      pointerId.current = null;
      liveWidth.current = null;
    }
  }, [resizing]);

  function begin(event: PointerEvent<HTMLDivElement>): void {
    if (!open) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerId.current = event.pointerId;
    startX.current = event.clientX;
    startWidth.current = resolvedWidth;
    liveWidth.current = resolvedWidth;
    setResizing(true);
    paintWidth(resolvedWidth);
    event.preventDefault();
  }

  function move(event: PointerEvent<HTMLDivElement>): void {
    if (!resizing || pointerId.current !== event.pointerId) return;
    const next = clamp(startWidth.current + event.clientX - startX.current);
    if (liveWidth.current === next) return;
    liveWidth.current = next;
    paintWidth(next);
  }

  function end(event: PointerEvent<HTMLDivElement>): void {
    if (pointerId.current !== event.pointerId) return;
    const next = clamp(liveWidth.current ?? resolvedWidth);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The browser may release capture when the window loses focus.
    }
    setResizing(false);
    onWidthChange?.(next);
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onWidthChange?.(
      clamp(resolvedWidth + (event.key === "ArrowLeft" ? -10 : 10)),
    );
  }

  const appliedWidth = open ? resolvedWidth : 0;
  return (
    <aside
      ref={aside}
      className={`relative flex h-full overflow-hidden border-r border-border bg-sidebar will-change-[width] motion-reduce:transition-none ${open ? "shadow-[inset_-2px_0_10px_-2px_rgb(0_0_0_/_0.06)]" : "border-r-0"} ${className}`}
      style={
        {
          width: appliedWidth,
          minWidth: appliedWidth,
          maxWidth: appliedWidth,
          "--oc-left-sidebar-width": `${resolvedWidth}px`,
          overflowX: "clip",
          transitionProperty: resizing ? "none" : "width, min-width, max-width",
          transitionDuration: "200ms",
          transitionTimingFunction: EASING,
        } as CSSProperties
      }
      aria-hidden={!open}
    >
      {open ? (
        // biome-ignore lint/a11y/useSemanticElements: a resizable vertical separator has no equivalent native element.
        <div
          className={`absolute right-0 top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-border ${resizing ? "bg-border" : ""}`}
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={resizeWithKeyboard}
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize sessions sidebar"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={resolvedWidth}
        />
      ) : null}
      <div
        className={`relative z-10 flex h-full shrink-0 flex-col transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${resizing ? "pointer-events-none" : ""} ${open ? "opacity-100" : "pointer-events-none select-none opacity-0"}`}
        style={{ width: "var(--oc-left-sidebar-width)", overflowX: "hidden" }}
        aria-hidden={!open}
      >
        {topBar}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </aside>
  );
}
