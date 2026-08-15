export type DiagramTransform = {
  scale: number;
  x: number;
  y: number;
};

export const MIN_DIAGRAM_SCALE = 0.25;
export const MAX_DIAGRAM_SCALE = 5;

export function clampDiagramScale(scale: number): number {
  return Math.min(MAX_DIAGRAM_SCALE, Math.max(MIN_DIAGRAM_SCALE, scale));
}

/** Zoom around a viewport point so the content beneath it stays stationary. */
export function zoomDiagramAt(
  current: DiagramTransform,
  nextScale: number,
  point: { x: number; y: number },
): DiagramTransform {
  const scale = clampDiagramScale(nextScale);
  const ratio = scale / current.scale;
  return {
    scale,
    x: point.x - (point.x - current.x) * ratio,
    y: point.y - (point.y - current.y) * ratio,
  };
}
