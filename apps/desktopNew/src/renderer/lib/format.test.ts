// node --experimental-strip-types --test src/renderer/lib/format.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatBytes,
  formatDuration,
  formatRelativeTime,
  formatTokens,
} from "./format.ts";

test("formatRelativeTime", () => {
  const now = Date.parse("2026-07-11T12:00:00.000Z");
  assert.equal(formatRelativeTime("2026-07-11T11:59:50.000Z", now), "just now");
  assert.equal(formatRelativeTime("2026-07-11T11:55:00.000Z", now), "5m ago");
  assert.equal(formatRelativeTime("2026-07-11T10:00:00.000Z", now), "2h ago");
  assert.equal(formatRelativeTime("2026-07-08T12:00:00.000Z", now), "3d ago");
  assert.equal(formatRelativeTime("2026-07-11T12:05:00.000Z", now), "in 5m");
  assert.equal(formatRelativeTime("not a date", now), "");
  // beyond two weeks falls back to an absolute date
  assert.match(formatRelativeTime("2026-01-05T12:00:00.000Z", now), /Jan/);
});

test("formatBytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(3.2 * 1024 * 1024), "3.2 MB");
  assert.equal(formatBytes(1.1 * 1024 ** 3), "1.1 GB");
  assert.equal(formatBytes(-1), "");
});

test("formatTokens", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(1000), "1k");
  assert.equal(formatTokens(12_340), "12.3k");
  assert.equal(formatTokens(1_200_000), "1.2M");
});

test("formatDuration", () => {
  assert.equal(formatDuration(820), "820ms");
  assert.equal(formatDuration(4200), "4.2s");
  assert.equal(formatDuration(42_000), "42s");
  assert.equal(formatDuration(59_600), "1m"); // rounds up, never "60s"
  assert.equal(formatDuration(192_000), "3m 12s");
  assert.equal(formatDuration(3_840_000), "1h 4m");
  assert.equal(formatDuration(7_200_000), "2h");
});
