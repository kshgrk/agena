import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRelative } from "./format-relative.ts";

const NOW = Date.parse("2026-07-11T12:00:00Z");
const at = (ms: number) => new Date(NOW - ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("sub-minute → just now", () => {
  assert.equal(formatRelative(at(0), NOW), "just now");
  assert.equal(formatRelative(at(59 * SEC), NOW), "just now");
});

test("minutes", () => {
  assert.equal(formatRelative(at(MIN), NOW), "1m ago");
  assert.equal(formatRelative(at(59 * MIN), NOW), "59m ago");
});

test("hours", () => {
  assert.equal(formatRelative(at(HOUR), NOW), "1h ago");
  assert.equal(formatRelative(at(23 * HOUR), NOW), "23h ago");
});

test("days", () => {
  assert.equal(formatRelative(at(DAY), NOW), "yesterday");
  assert.equal(formatRelative(at(2 * DAY), NOW), "2d ago");
  assert.equal(formatRelative(at(6 * DAY), NOW), "6d ago");
});

test("a week+ falls back to a locale date", () => {
  const out = formatRelative(at(7 * DAY), NOW);
  assert.equal(out, new Date(NOW - 7 * DAY).toLocaleDateString());
});

test("future timestamps clamp to just now", () => {
  assert.equal(formatRelative(at(-5 * MIN), NOW), "just now");
});

test("unparseable input is returned verbatim", () => {
  assert.equal(formatRelative("not-a-date", NOW), "not-a-date");
});
