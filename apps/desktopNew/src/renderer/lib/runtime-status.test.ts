import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageStatus } from "./runtime-status.ts";

test("prefers subscription quota over session cost", () => {
  assert.equal(
    formatUsageStatus(
      { period: "weekly", remainingPercent: 75 },
      {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2,
        costUsd: 0,
      },
    ),
    "75% Weekly",
  );
});

test("formats API session cost", () => {
  assert.equal(
    formatUsageStatus(undefined, {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      costUsd: 0.421,
    }),
    "$0.421",
  );
});
