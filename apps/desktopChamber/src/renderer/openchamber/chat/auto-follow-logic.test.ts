import assert from "node:assert/strict";
import { test } from "node:test";
import { followStateAfterScroll } from "./auto-follow-logic.ts";

test("does not trap an upward reader inside the bottom spacer", () => {
  assert.equal(
    followStateAfterScroll({
      state: "released",
      scrollingDown: false,
      distance: 30,
      threshold: 60,
      programmatic: false,
      animationGuarded: false,
    }),
    "released",
  );
});

test("keeps programmatic geometry changes pinned", () => {
  assert.equal(
    followStateAfterScroll({
      state: "following",
      scrollingDown: false,
      distance: 90,
      threshold: 60,
      programmatic: true,
      animationGuarded: false,
    }),
    "following",
  );
});
