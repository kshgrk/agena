import assert from "node:assert/strict";
import test from "node:test";
import { bottomThreshold, nextFollowState } from "./auto-follow.ts";

test("auto-follow only releases for real upward user intent", () => {
  const base = {
    current: "following" as const,
    previousTop: 500,
    currentTop: 420,
    distanceFromBottom: 300,
    bottomThreshold: 80,
  };
  assert.equal(nextFollowState({ ...base, userIntent: false }), "following");
  assert.equal(nextFollowState({ ...base, userIntent: true }), "released");
  assert.equal(
    nextFollowState({
      ...base,
      current: "released",
      userIntent: true,
      currentTop: 900,
      distanceFromBottom: 20,
    }),
    "following",
  );
  assert.equal(bottomThreshold(1_000), 100);
});
