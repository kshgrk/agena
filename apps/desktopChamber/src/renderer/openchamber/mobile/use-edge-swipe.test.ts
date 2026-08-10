import assert from "node:assert/strict";
import test from "node:test";
import { detectEdgeSwipe } from "./use-edge-swipe.ts";

test("edge swipes require inward horizontal travel", () => {
  assert.equal(
    detectEdgeSwipe({
      startX: 10,
      startY: 100,
      endX: 90,
      endY: 110,
      width: 390,
    }),
    "left",
  );
  assert.equal(
    detectEdgeSwipe({
      startX: 200,
      startY: 100,
      endX: 290,
      endY: 100,
      width: 390,
    }),
    null,
  );
  assert.equal(
    detectEdgeSwipe({
      startX: 380,
      startY: 100,
      endX: 300,
      endY: 110,
      width: 390,
    }),
    "right",
  );
});

test("Android accepts gestures beyond the system edge zone", () => {
  const input = { startX: 70, startY: 100, endX: 150, endY: 100, width: 390 };
  assert.equal(detectEdgeSwipe(input), null);
  assert.equal(detectEdgeSwipe({ ...input, android: true }), "left");
});
