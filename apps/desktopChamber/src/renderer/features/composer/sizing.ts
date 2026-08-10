const MIN_HEIGHT = 44;

export function composerHeight({
  scrollHeight,
  lineHeight,
  viewportHeight,
  mobile,
}: {
  scrollHeight: number;
  lineHeight: number;
  viewportHeight: number;
  mobile: boolean;
}): number {
  const lineCap = lineHeight * (mobile ? 16 : 8) + 24;
  const viewportCap = viewportHeight * 0.4;
  return Math.max(MIN_HEIGHT, Math.min(scrollHeight, lineCap, viewportCap));
}
