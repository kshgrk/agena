import {
  Check,
  Copy,
  Maximize2,
  Minus,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useUi } from "../../store/ui.ts";
import { Dialog, DialogTitle, IconButton } from "../../ui/index.ts";
import { CodeBlock } from "./code-block.tsx";
import {
  clampDiagramScale,
  type DiagramTransform,
  zoomDiagramAt,
} from "./mermaid-viewport.ts";

type RenderMermaid = typeof import("beautiful-mermaid").renderMermaidSVG;

const DIAGRAM_RENDER_DELAY_MS = 180;
const diagramCache = new Map<string, string>();
let rendererPromise: Promise<RenderMermaid> | null = null;

function loadRenderer(): Promise<RenderMermaid> {
  rendererPromise ??= import("beautiful-mermaid").then(
    ({ renderMermaidSVG }) => renderMermaidSVG,
  );
  return rendererPromise;
}

function remember(code: string, svg: string): void {
  diagramCache.delete(code);
  diagramCache.set(code, svg);
  if (diagramCache.size > 50) {
    const oldest = diagramCache.keys().next().value;
    if (oldest !== undefined) diagramCache.delete(oldest);
  }
}

function useRenderedDiagram(code: string): string | null {
  const [svg, setSvg] = useState<string | null>(
    () => diagramCache.get(code) ?? null,
  );

  useEffect(() => {
    const cached = diagramCache.get(code);
    setSvg(cached ?? null);
    if (cached) return;
    let alive = true;
    const timer = setTimeout(() => {
      void loadRenderer()
        .then((render) => {
          if (!alive) return;
          try {
            const next = render(code, {
              bg: "var(--bg-inset)",
              fg: "var(--fg)",
              line: "var(--fg-muted)",
              accent: "var(--accent)",
              muted: "var(--fg-muted)",
              surface: "var(--bg-raised)",
              border: "var(--border-strong)",
              font: "var(--font-sans)",
              padding: 28,
              transparent: true,
              interactive: true,
            });
            remember(code, next);
            setSvg(next);
          } catch {
            // Invalid, incomplete, or unsupported Mermaid stays readable as code.
            setSvg(null);
          }
        })
        .catch(() => {
          if (alive) setSvg(null);
        });
    }, DIAGRAM_RENDER_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [code]);

  return svg;
}

type Gesture =
  | {
      kind: "pan";
      pointerId: number;
      start: { x: number; y: number };
      transform: DiagramTransform;
    }
  | {
      kind: "pinch";
      distance: number;
      midpoint: { x: number; y: number };
      transform: DiagramTransform;
    };

type Point = { x: number; y: number };

function midpoint(first: Point, second: Point): Point {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function distance(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function DiagramCanvas({ svg }: { svg: string }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<Gesture | null>(null);
  const transformRef = useRef<DiagramTransform>({ scale: 1, x: 0, y: 0 });
  const [transform, setTransformState] = useState(transformRef.current);

  const setTransform = useCallback((next: DiagramTransform) => {
    transformRef.current = next;
    setTransformState(next);
  }, []);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    const diagram = contentRef.current?.querySelector("svg");
    if (!viewport || !diagram) return;
    const viewBox = diagram.viewBox.baseVal;
    const width = viewBox.width || diagram.getBoundingClientRect().width;
    const height = viewBox.height || diagram.getBoundingClientRect().height;
    if (!width || !height) return;
    const scale = clampDiagramScale(
      Math.min(
        (viewport.clientWidth - 48) / width,
        (viewport.clientHeight - 48) / height,
      ),
    );
    setTransform({
      scale,
      x: (viewport.clientWidth - width * scale) / 2,
      y: (viewport.clientHeight - height * scale) / 2,
    });
  }, [setTransform]);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [fit]);

  const zoom = useCallback(
    (factor: number, point?: { x: number; y: number }) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      setTransform(
        zoomDiagramAt(
          transformRef.current,
          transformRef.current.scale * factor,
          point ?? {
            x: viewport.clientWidth / 2,
            y: viewport.clientHeight / 2,
          },
        ),
      );
    },
    [setTransform],
  );

  const beginGesture = useCallback(() => {
    const points = [...pointersRef.current.entries()];
    if (points.length >= 2) {
      const pair = points.slice(0, 2).map(([, point]) => point);
      const first = pair[0];
      const second = pair[1];
      if (!first || !second) return;
      gestureRef.current = {
        kind: "pinch",
        distance: Math.max(1, distance(first, second)),
        midpoint: midpoint(first, second),
        transform: transformRef.current,
      };
    } else if (points[0]) {
      gestureRef.current = {
        kind: "pan",
        pointerId: points[0][0],
        start: points[0][1],
        transform: transformRef.current,
      };
    } else {
      gestureRef.current = null;
    }
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      const rect = event.currentTarget.getBoundingClientRect();
      pointersRef.current.set(event.pointerId, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
      beginGesture();
    },
    [beginGesture],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!pointersRef.current.has(event.pointerId)) return;
      const rect = event.currentTarget.getBoundingClientRect();
      pointersRef.current.set(event.pointerId, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (gesture.kind === "pan") {
        const point = pointersRef.current.get(gesture.pointerId);
        if (!point) return;
        setTransform({
          ...gesture.transform,
          x: gesture.transform.x + point.x - gesture.start.x,
          y: gesture.transform.y + point.y - gesture.start.y,
        });
        return;
      }
      const pair = [...pointersRef.current.values()].slice(0, 2);
      const first = pair[0];
      const second = pair[1];
      if (!first || !second) return;
      const currentMidpoint = midpoint(first, second);
      const scale = clampDiagramScale(
        gesture.transform.scale * (distance(first, second) / gesture.distance),
      );
      const ratio = scale / gesture.transform.scale;
      setTransform({
        scale,
        x:
          gesture.midpoint.x -
          (gesture.midpoint.x - gesture.transform.x) * ratio +
          currentMidpoint.x -
          gesture.midpoint.x,
        y:
          gesture.midpoint.y -
          (gesture.midpoint.y - gesture.transform.y) * ratio +
          currentMidpoint.y -
          gesture.midpoint.y,
      });
    },
    [setTransform],
  );

  const endPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      pointersRef.current.delete(event.pointerId);
      beginGesture();
    },
    [beginGesture],
  );

  const onWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    },
    [zoom],
  );

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-inset">
      <div
        ref={viewportRef}
        role="application"
        aria-label="Interactive Mermaid diagram. Drag to pan and use the wheel or pinch gesture to zoom."
        className="absolute inset-0 touch-none cursor-grab overflow-hidden active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        <div
          ref={contentRef}
          className="absolute left-0 top-0 max-w-none select-none [&>svg]:max-w-none"
          style={{
            transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
            transformOrigin: "0 0",
          }}
          // beautiful-mermaid escapes labels/attributes and emits SVG only.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted renderer output
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-border bg-overlay p-1 shadow-md">
        <IconButton label="Zoom out" size="sm" onClick={() => zoom(1 / 1.2)}>
          <Minus />
        </IconButton>
        <span className="w-10 text-center text-2xs tabular-nums text-fg-muted">
          {Math.round(transform.scale * 100)}%
        </span>
        <IconButton label="Zoom in" size="sm" onClick={() => zoom(1.2)}>
          <Plus />
        </IconButton>
        <IconButton label="Fit diagram" size="sm" onClick={fit}>
          <RotateCcw />
        </IconButton>
      </div>
    </div>
  );
}

export function MermaidDiagram({ code }: { code: string }) {
  const svg = useRenderedDiagram(code);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    useUi.getState().enterOverlay();
    return () => useUi.getState().exitOverlay();
  }, [open]);

  if (!svg)
    return <CodeBlock code={code} language="mermaid" className="my-3" />;

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <>
      <div className="group/diagram my-3 overflow-hidden rounded-lg border border-border-subtle bg-inset">
        <div className="flex h-8 items-center justify-between border-b border-border-subtle px-2 pl-3">
          <span className="text-2xs text-fg-muted">Mermaid diagram</span>
          <div className="flex items-center gap-0.5">
            <IconButton
              label={copied ? "Copied" : "Copy Mermaid source"}
              size="sm"
              onClick={copy}
            >
              {copied ? <Check className="text-success" /> : <Copy />}
            </IconButton>
            <IconButton
              label="Expand diagram"
              size="sm"
              onClick={() => setOpen(true)}
            >
              <Maximize2 />
            </IconButton>
          </div>
        </div>
        <button
          type="button"
          aria-label="Expand Mermaid diagram"
          className="flex max-h-96 min-h-32 w-full cursor-zoom-in items-center justify-center overflow-auto p-4 [&>svg]:h-auto [&>svg]:max-w-full"
          onClick={() => setOpen(true)}
          // beautiful-mermaid escapes labels/attributes and emits SVG only.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted renderer output
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        size="lg"
        className="flex h-[calc(100dvh-32px)] max-w-[calc(100vw-32px)] flex-col overflow-hidden p-0 max-md:h-[100dvh]"
      >
        <DialogTitle className="sr-only">Mermaid diagram</DialogTitle>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="text-sm font-medium text-fg">Diagram</span>
          <span className="hidden text-xs text-fg-muted sm:inline">
            Drag to move · wheel or pinch to zoom
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton label="Copy Mermaid source" size="sm" onClick={copy}>
              {copied ? <Check className="text-success" /> : <Copy />}
            </IconButton>
            <IconButton
              label="Close diagram"
              size="sm"
              onClick={() => setOpen(false)}
            >
              <X />
            </IconButton>
          </div>
        </div>
        <DiagramCanvas svg={svg} />
      </Dialog>
    </>
  );
}
