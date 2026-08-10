import assert from "node:assert/strict";
import test from "node:test";
import {
  promptIndexAtOffset,
  promptTickTop,
  promptTickWidth,
} from "./prompt-navigator-logic.ts";

test("prompt navigator maps every prompt across the full rail", () => {
  assert.equal(promptTickTop(0, 46), "0%");
  assert.equal(promptTickTop(45, 46), "100%");
  assert.equal(promptIndexAtOffset(0, 360, 46), 0);
  assert.equal(promptIndexAtOffset(180, 360, 46), 23);
  assert.equal(promptIndexAtOffset(360, 360, 46), 45);
});

test("prompt navigator tick wave emphasizes the hovered neighborhood", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => promptTickWidth(index, 0, false)),
    [20, 16, 14, 12, 10],
  );
  assert.equal(promptTickWidth(4, null, true), 14);
});
