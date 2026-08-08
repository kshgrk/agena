import { expect, it } from "vitest";
import { parseCodexWeeklyUsage } from "../src/codex-usage.ts";

it("uses the weekly Codex window and reports remaining quota", () => {
  expect(
    parseCodexWeeklyUsage({
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: 1_786_000_000 },
        secondary_window: { used_percent: 25, reset_at: 1_787_000_000 },
      },
    }),
  ).toEqual({
    period: "weekly",
    remainingPercent: 75,
    resetsAt: new Date(1_787_000_000_000).toISOString(),
  });
});

it("accepts a weekly-only primary window", () => {
  expect(
    parseCodexWeeklyUsage({
      rate_limit: { primary_window: { used_percent: 33.4 } },
    }),
  ).toEqual({ period: "weekly", remainingPercent: 67 });
});
