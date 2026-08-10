import assert from "node:assert/strict";
import test from "node:test";
import {
  messageIndexAtPosition,
  messagePositionCss,
  messageRailLayout,
} from "./user-message-rail-logic.ts";

test("message rail uses equal padding and caps sparse-session gaps", () => {
  const sparse = messageRailLayout(4, 600);
  assert.equal(sparse.gap, 12);
  assert.equal(sparse.padding, 282);

  const dense = messageRailLayout(103, 600);
  assert.ok(dense.gap < 12);
  assert.equal(dense.padding, dense.gap);
  assert.equal(messageIndexAtPosition(0, 103, dense), 0);
  assert.equal(messageIndexAtPosition(600, 103, dense), 102);
  assert.equal(messageIndexAtPosition(0, 0, dense), null);

  assert.equal(messagePositionCss(0, 4), "calc(50% - min(18px, 30%))");
  assert.equal(messagePositionCss(3, 4), "calc(50% + min(18px, 30%))");
  assert.equal(messagePositionCss(2, 5), "50%");
});
