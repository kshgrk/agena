import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildUnifiedHunks,
  composeGitDiff,
  diffLines,
  hunkStats,
  splitLines,
} from "./unified-diff.ts";

test("splitLines treats a trailing newline as a terminator", () => {
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("a"), ["a"]);
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitLines("\n"), [""]);
});

test("diffLines covers pure add / pure delete / identical", () => {
  assert.deepEqual(diffLines([], ["x"]), [{ type: "add", line: "x" }]);
  assert.deepEqual(diffLines(["x"], []), [{ type: "del", line: "x" }]);
  assert.deepEqual(diffLines(["x"], ["x"]), [{ type: "ctx", line: "x" }]);
});

test("diffLines finds a minimal edit script", () => {
  const ops = diffLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
  assert.deepEqual(ops, [
    { type: "ctx", line: "a" },
    { type: "del", line: "b" },
    { type: "add", line: "x" },
    { type: "ctx", line: "c" },
    { type: "ctx", line: "d" },
    { type: "add", line: "e" },
  ]);
});

test("diffLines reconstructs both sides", () => {
  const oldLines = ["one", "two", "three", "four", "five"];
  const newLines = ["zero", "one", "three", "3.5", "five", "six"];
  const ops = diffLines(oldLines, newLines);
  assert.deepEqual(
    ops.filter((o) => o.type !== "add").map((o) => o.line),
    oldLines,
  );
  assert.deepEqual(
    ops.filter((o) => o.type !== "del").map((o) => o.line),
    newLines,
  );
});

test("buildUnifiedHunks: no changes → no hunks", () => {
  const r = buildUnifiedHunks("a\nb\n", "a\nb\n");
  assert.deepEqual(r, { hunks: [], adds: 0, dels: 0 });
});

test("buildUnifiedHunks: single change with context and counts", () => {
  const oldText = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
  const newText = ["1", "2", "3", "4x", "5", "6", "7", "8"].join("\n");
  const r = buildUnifiedHunks(oldText, newText);
  assert.equal(r.adds, 1);
  assert.equal(r.dels, 1);
  assert.equal(r.hunks.length, 1);
  assert.equal(
    r.hunks[0],
    "@@ -1,7 +1,7 @@\n 1\n 2\n 3\n-4\n+4x\n 5\n 6\n 7",
  );
});

test("buildUnifiedHunks: distant changes split into separate hunks", () => {
  const oldLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const newLines = [...oldLines];
  newLines[1] = "changed 2";
  newLines[27] = "changed 28";
  const r = buildUnifiedHunks(oldLines.join("\n"), newLines.join("\n"));
  assert.equal(r.hunks.length, 2);
  assert.match(r.hunks[0]!, /^@@ -1,\d+ \+1,\d+ @@/);
  assert.match(r.hunks[1]!, /^@@ -25,6 \+25,6 @@/);
  assert.equal(r.adds, 2);
  assert.equal(r.dels, 2);
});

test("buildUnifiedHunks: nearby changes merge into one hunk", () => {
  const oldLines = Array.from({ length: 12 }, (_, i) => `l${i}`);
  const newLines = [...oldLines];
  newLines[3] = "x";
  newLines[7] = "y";
  const r = buildUnifiedHunks(oldLines.join("\n"), newLines.join("\n"));
  assert.equal(r.hunks.length, 1);
});

test("buildUnifiedHunks: pure insertion uses git zero-count header", () => {
  const r = buildUnifiedHunks("", "a\nb\n");
  assert.equal(r.hunks.length, 1);
  assert.match(r.hunks[0]!, /^@@ -0,0 \+1,2 @@/);
  assert.equal(r.adds, 2);
  assert.equal(r.dels, 0);
});

test("hunkStats counts +/− lines and ignores headers", () => {
  const stats = hunkStats(["@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d"]);
  assert.deepEqual(stats, { adds: 2, dels: 1 });
  // file header lines never count
  const withHeader = hunkStats(["--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-b\n+c"]);
  assert.deepEqual(withHeader, { adds: 1, dels: 1 });
});

test("composeGitDiff prefixes the file header @git-diff-view requires", () => {
  assert.deepEqual(composeGitDiff("src/x.ts", []), []);
  assert.deepEqual(
    composeGitDiff("src/x.ts", ["@@ -1,1 +1,1 @@\n-a\n+b", "@@ -9,1 +9,1 @@\n-c\n+d"]),
    ["--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -9,1 +9,1 @@\n-c\n+d"],
  );
});
