// Source-derived from OpenChamber apps/useEdgeSwipe.ts (MIT).

import type { RefObject } from "react";
import { useEffect, useRef } from "react";

const EDGE_ZONE = 32;
const ANDROID_EDGE_ZONE = 80;
const MIN_DISTANCE = 64;
const MAX_OFF_AXIS_RATIO = 0.7;

export type EdgeSwipeSide = "left" | "right";

export function detectEdgeSwipe(input: {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  width: number;
  android?: boolean;
}): EdgeSwipeSide | null {
  const edge = input.android ? ANDROID_EDGE_ZONE : EDGE_ZONE;
  const left = input.startX <= edge;
  const right = input.startX >= input.width - edge;
  if (!left && !right) return null;
  const dx = input.endX - input.startX;
  const dy = input.endY - input.startY;
  if (Math.abs(dx) < MIN_DISTANCE) return null;
  if (Math.abs(dy) > Math.abs(dx) * MAX_OFF_AXIS_RATIO) return null;
  if (left && dx > 0) return "left";
  if (right && dx < 0) return "right";
  return null;
}

export function useEdgeSwipe(
  ref: RefObject<HTMLElement | null>,
  actions: { onLeft?: () => void; onRight?: () => void },
): void {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let start: { x: number; y: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      start = touch ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (!start || !touch) return;
      const platform = (
        window as typeof window & {
          Capacitor?: { getPlatform?: () => string };
        }
      ).Capacitor?.getPlatform?.();
      const side = detectEdgeSwipe({
        startX: start.x,
        startY: start.y,
        endX: touch.clientX,
        endY: touch.clientY,
        width: element.clientWidth,
        android: platform === "android",
      });
      start = null;
      if (side === "left") actionsRef.current.onLeft?.();
      if (side === "right") actionsRef.current.onRight?.();
    };
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchend", onTouchEnd);
    };
  }, [ref]);
}
