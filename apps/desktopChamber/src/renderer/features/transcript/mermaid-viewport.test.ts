import assert from "node:assert/strict";
import test from "node:test";
import { renderMermaidSVG } from "beautiful-mermaid";
import {
  MAX_DIAGRAM_SCALE,
  MIN_DIAGRAM_SCALE,
  zoomDiagramAt,
} from "./mermaid-viewport.ts";

test("diagram zoom clamps and preserves the point beneath the cursor", () => {
  const current = { scale: 1, x: 10, y: 20 };
  assert.deepEqual(zoomDiagramAt(current, 2, { x: 110, y: 120 }), {
    scale: 2,
    x: -90,
    y: -80,
  });
  assert.equal(
    zoomDiagramAt(current, 100, { x: 0, y: 0 }).scale,
    MAX_DIAGRAM_SCALE,
  );
  assert.equal(
    zoomDiagramAt(current, 0, { x: 0, y: 0 }).scale,
    MIN_DIAGRAM_SCALE,
  );
});

test("ordinary Mermaid syntax renders as escaped SVG", () => {
  const svg = renderMermaidSVG(
    "graph LR\n  A[<script>alert(1)</script>] --> B[Done]",
  );
  assert.match(svg, /^<svg /);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
});
