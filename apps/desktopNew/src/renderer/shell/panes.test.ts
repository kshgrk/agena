// node --experimental-strip-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block } from "../store/types.ts";
import {
  buildSavedLayout,
  LAYOUT_VERSION,
  latestUsage,
  parseSavedLayout,
} from "./panes.ts";

// ---- parseSavedLayout ----------------------------------------------------------

test("parseSavedLayout rejects garbage and wrong versions", () => {
  assert.equal(parseSavedLayout(null), null);
  assert.equal(parseSavedLayout(undefined), null);
  assert.equal(parseSavedLayout("layout"), null);
  assert.equal(parseSavedLayout(42), null);
  assert.equal(parseSavedLayout({}), null);
  assert.equal(parseSavedLayout({ v: LAYOUT_VERSION - 1, dock: {} }), null);
  assert.equal(parseSavedLayout({ v: "3", dock: {} }), null);
});

test("parseSavedLayout accepts the current version", () => {
  const dock = { grid: {}, panels: {} };
  assert.deepEqual(
    parseSavedLayout({ v: LAYOUT_VERSION, dock, sidebarCollapsed: true }),
    { dock, sidebarCollapsed: true },
  );
  // missing/invalid fields degrade instead of failing the whole blob
  assert.deepEqual(parseSavedLayout({ v: LAYOUT_VERSION }), {
    dock: null,
    sidebarCollapsed: false,
  });
  assert.deepEqual(
    parseSavedLayout({ v: LAYOUT_VERSION, dock: "bad", sidebarCollapsed: 1 }),
    { dock: null, sidebarCollapsed: false },
  );
});

test("buildSavedLayout round-trips through parseSavedLayout", () => {
  const dock = { grid: { root: {} } };
  const blob = buildSavedLayout(
    dock as unknown as Parameters<typeof buildSavedLayout>[0],
    true,
  );
  assert.deepEqual(parseSavedLayout(blob), { dock, sidebarCollapsed: true });
});

// ---- latestUsage ------------------------------------------------------------------

const base = { seq: 0, at: "2026-01-01T00:00:00Z", source: { kind: "user" } };

const assistant = (seq: number, usage?: { inputTokens: number; outputTokens: number }) =>
  ({
    ...base,
    seq,
    kind: "assistant",
    messageId: `m${seq}`,
    content: [],
    status: "completed",
    ...(usage ? { usage } : {}),
  }) as unknown as Block;

const user = (seq: number) =>
  ({ ...base, seq, kind: "user", messageId: `u${seq}`, content: [] }) as unknown as Block;

test("latestUsage returns undefined for empty/undefined/usage-less transcripts", () => {
  assert.equal(latestUsage(undefined), undefined);
  assert.equal(latestUsage([]), undefined);
  assert.equal(latestUsage([user(1), assistant(2)]), undefined);
});

test("latestUsage picks the most recent assistant usage", () => {
  const blocks = [
    assistant(1, { inputTokens: 10, outputTokens: 5 }),
    user(2),
    assistant(3, { inputTokens: 200, outputTokens: 90 }),
    assistant(4), // completed but reported no usage — skipped
    user(5),
  ];
  assert.deepEqual(latestUsage(blocks), { inputTokens: 200, outputTokens: 90 });
});
