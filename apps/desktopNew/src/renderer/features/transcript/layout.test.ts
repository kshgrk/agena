import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block, ToolBlock } from "../../store/types.ts";
import {
  argSummary,
  formatDayLabel,
  middleTruncate,
  outputLineLabel,
  rowMeta,
  toolVisualState,
} from "./layout.ts";

const src = { kind: "runtime" } as const;
let seq = 0;

function user(at: string): Block {
  return {
    seq: ++seq,
    at,
    source: src,
    kind: "user",
    messageId: `m${seq}`,
    content: [{ type: "text", text: "hi" }],
  };
}

function assistant(at: string): Block {
  return {
    seq: ++seq,
    at,
    source: src,
    kind: "assistant",
    messageId: `m${seq}`,
    content: [],
    status: "completed",
  };
}

function tool(
  at: string,
  name: string,
  status: ToolBlock["status"],
): ToolBlock {
  return {
    seq: ++seq,
    at,
    source: src,
    kind: "tool",
    toolCallId: `t${seq}`,
    name,
    args: {},
    status,
    liveOutput: "",
  };
}

const D1 = "2026-07-10T10:00:00Z";
const D1_LATER = "2026-07-10T11:00:00Z";
const D2 = "2026-07-11T09:00:00Z";

test("rowMeta: first row, turn gaps, block gaps", () => {
  const blocks: Block[] = [user(D1), assistant(D1), user(D1_LATER)];
  assert.equal(rowMeta(blocks, 0).gap, "first");
  assert.equal(rowMeta(blocks, 1).gap, "block");
  assert.equal(rowMeta(blocks, 2).gap, "turn");
  assert.equal(rowMeta(blocks, 1).dayLabel, null);
});

test("rowMeta: day separator when the calendar day changes", () => {
  const blocks: Block[] = [user(D1), assistant(D2)];
  const meta = rowMeta(blocks, 1);
  assert.notEqual(meta.dayLabel, null);
  assert.equal(rowMeta(blocks, 0).dayLabel, null);
});

test("rowMeta: consecutive same-tool success cards group and go flush", () => {
  const blocks: Block[] = [
    tool(D1, "grep", "completed"),
    tool(D1, "grep", "completed"),
    tool(D1, "grep", "completed"),
    tool(D1, "bash", "completed"),
  ];
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => rowMeta(blocks, i).groupWithPrev),
    [false, true, true, false],
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => rowMeta(blocks, i).groupWithNext),
    [true, true, false, false],
  );
  assert.equal(rowMeta(blocks, 1).gap, "flush");
});

test("rowMeta: non-success or different-name tools never group", () => {
  const blocks: Block[] = [
    tool(D1, "grep", "completed"),
    tool(D1, "grep", "failed"),
    tool(D1, "read", "completed"),
  ];
  assert.equal(rowMeta(blocks, 1).groupWithPrev, false);
  assert.equal(rowMeta(blocks, 2).groupWithPrev, false);
});

test("rowMeta: a day change between grouped cards un-groups them", () => {
  const blocks: Block[] = [
    tool(D1, "grep", "completed"),
    tool(D2, "grep", "completed"),
  ];
  const meta = rowMeta(blocks, 1);
  assert.notEqual(meta.dayLabel, null);
  assert.equal(meta.groupWithPrev, false);
  assert.equal(rowMeta(blocks, 0).groupWithNext, false);
});

test("formatDayLabel: valid date renders, garbage is empty", () => {
  assert.notEqual(formatDayLabel(D1), "");
  assert.equal(formatDayLabel("garbage"), "");
});

test("middleTruncate keeps both ends", () => {
  assert.equal(middleTruncate("short", 10), "short");
  const long = `${"a".repeat(50)}MIDDLE${"z".repeat(50)}`;
  const cut = middleTruncate(long, 21);
  assert.equal(cut.length, 21);
  assert.ok(cut.startsWith("aaa"));
  assert.ok(cut.endsWith("zzz"));
  assert.ok(cut.includes("…"));
});

test("argSummary prefers primary string args, falls back to JSON", () => {
  assert.equal(argSummary({ command: "ls -la" }), "ls -la");
  assert.equal(argSummary({ file_path: "/a/b.ts", extra: 1 }), "/a/b.ts");
  assert.equal(argSummary({ pattern: "foo.*bar" }), "foo.*bar");
  assert.equal(argSummary({ n: 3 }), '{"n":3}');
  assert.equal(argSummary("raw"), "raw");
  assert.equal(argSummary(undefined), "");
});

test("toolVisualState maps statuses and pending approvals", () => {
  assert.equal(toolVisualState("running", false), "running");
  assert.equal(toolVisualState("running", true), "pending");
  assert.equal(toolVisualState("completed", false), "success");
  assert.equal(toolVisualState("failed", false), "error");
  assert.equal(toolVisualState("aborted", false), "aborted");
  assert.equal(toolVisualState("denied", false), "denied");
});

test("outputLineLabel reports only present output", () => {
  assert.equal(outputLineLabel(""), "");
  assert.equal(outputLineLabel("ok"), "1 line");
  assert.equal(outputLineLabel("ok\n"), "1 line");
  assert.equal(outputLineLabel("one\ntwo"), "2 lines");
});
