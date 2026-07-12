const MAX_MESSAGE_GAP_PX = 12;

type MessageRailLayout = {
  gap: number;
  padding: number;
};

export function messageRailLayout(
  messageCount: number,
  height: number,
): MessageRailLayout {
  if (messageCount <= 0 || height <= 0) return { gap: 0, padding: 0 };
  if (messageCount === 1) return { gap: 0, padding: height / 2 };
  const naturalGap = height / (messageCount + 1);
  if (naturalGap <= MAX_MESSAGE_GAP_PX) {
    return { gap: naturalGap, padding: naturalGap };
  }
  const gap = MAX_MESSAGE_GAP_PX;
  return { gap, padding: (height - gap * (messageCount - 1)) / 2 };
}

export function messagePositionCss(
  index: number,
  messageCount: number,
): string {
  const offset = index - (messageCount - 1) / 2;
  if (offset === 0) return "50%";
  const distance = Math.abs(offset);
  const direction = offset < 0 ? "-" : "+";
  return `calc(50% ${direction} min(${distance * MAX_MESSAGE_GAP_PX}px, ${(distance * 100) / (messageCount + 1)}%))`;
}

export function messageIndexAtPosition(
  position: number,
  messageCount: number,
  layout: MessageRailLayout,
): number | null {
  if (messageCount <= 0) return null;
  if (messageCount === 1 || layout.gap === 0) return 0;
  return Math.min(
    messageCount - 1,
    Math.max(0, Math.round((position - layout.padding) / layout.gap)),
  );
}
