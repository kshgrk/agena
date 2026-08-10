const TICK_BASE_WIDTH_PX = 10;
const TICK_ACTIVE_WIDTH_PX = 14;
const TICK_FOCUS_WIDTH_PX = 20;
const PROXIMITY_FALLOFF = [1, 0.6, 0.35, 0.15] as const;

export function promptIndexAtOffset(
  offset: number,
  height: number,
  promptCount: number,
): number | null {
  if (promptCount === 0 || height <= 0) return null;
  const progress = Math.max(0, Math.min(1, offset / height));
  return Math.round(progress * (promptCount - 1));
}

export function promptTickTop(index: number, promptCount: number): string {
  if (promptCount < 2) return "50%";
  return `${(index / (promptCount - 1)) * 100}%`;
}

export function promptTickWidth(
  index: number,
  highlightedIndex: number | null,
  active: boolean,
): number {
  const base = active ? TICK_ACTIVE_WIDTH_PX : TICK_BASE_WIDTH_PX;
  if (highlightedIndex === null) return base;
  const factor = PROXIMITY_FALLOFF[Math.abs(index - highlightedIndex)] ?? 0;
  return Math.round(base + (TICK_FOCUS_WIDTH_PX - base) * factor);
}
