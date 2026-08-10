import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commandScore,
  filterCommands,
  fuzzyMatch,
  groupCommands,
  parsePaletteQuery,
  rankSessions,
} from "./palette-logic.ts";

test("parsePaletteQuery: '>' prefix forces commands mode", () => {
  assert.deepEqual(parsePaletteQuery("> new sess"), {
    mode: "commands",
    text: "new sess",
  });
  assert.deepEqual(parsePaletteQuery(">"), { mode: "commands", text: "" });
  assert.deepEqual(parsePaletteQuery("  hello "), {
    mode: "mixed",
    text: "hello",
  });
  assert.deepEqual(parsePaletteQuery(""), { mode: "mixed", text: "" });
});

test("fuzzyMatch: subsequence, case-insensitive", () => {
  assert.equal(fuzzyMatch("Toggle Terminal", "tgl"), true);
  assert.equal(fuzzyMatch("Toggle Terminal", "TERM"), true);
  assert.equal(fuzzyMatch("Toggle", "tlg"), false);
  assert.equal(fuzzyMatch("anything", ""), true);
  assert.equal(fuzzyMatch("", "x"), false);
});

test("commandScore tiers: title substring > keyword > subsequence > none", () => {
  const cmd = {
    title: "Toggle Theme",
    group: "View",
    keywords: ["dark", "light"],
  };
  assert.equal(commandScore(cmd, "theme"), 3);
  assert.equal(commandScore(cmd, "dark"), 2);
  assert.equal(commandScore(cmd, "view"), 2);
  assert.equal(commandScore(cmd, "tgt"), 1);
  assert.equal(commandScore(cmd, "zzz"), 0);
  assert.equal(commandScore(cmd, ""), 1); // empty query keeps everything
});

test("filterCommands ranks by score then stable input order", () => {
  const cmds = [
    { id: "a", title: "New Terminal", group: "Terminal" },
    { id: "b", title: "Toggle Theme", group: "View", keywords: ["dark"] },
    { id: "c", title: "Theme picker", group: "View" },
  ];
  const out = filterCommands(cmds, "theme");
  assert.deepEqual(
    out.map((c) => c.id),
    ["b", "c"], // both title-substring hits, input order kept
  );
  assert.deepEqual(
    filterCommands(cmds, "").map((c) => c.id),
    ["a", "b", "c"],
  );
});

test("rankSessions: recents first, filters on title or id", () => {
  const sessions = [
    { sessionId: "01A", title: "fix bug", updatedAt: "2026-07-10T10:00:00Z" },
    { sessionId: "01B", title: "deploy", updatedAt: "2026-07-11T10:00:00Z" },
    { sessionId: "01C", updatedAt: "2026-07-09T10:00:00Z" },
  ];
  assert.deepEqual(
    rankSessions(sessions, "", 10).map((s) => s.sessionId),
    ["01B", "01A", "01C"],
  );
  assert.deepEqual(
    rankSessions(sessions, "bug", 10).map((s) => s.sessionId),
    ["01A"],
  );
  // id match works for untitled sessions
  assert.deepEqual(
    rankSessions(sessions, "01c", 10).map((s) => s.sessionId),
    ["01C"],
  );
  // limit applies after ranking
  assert.deepEqual(
    rankSessions(sessions, "", 1).map((s) => s.sessionId),
    ["01B"],
  );
});

test("rankSessions also searches project and cwd context", () => {
  const sessions = [
    {
      sessionId: "1",
      updatedAt: "2026-01-01",
      projectId: "web",
      cwd: "apps/site",
    },
    {
      sessionId: "2",
      updatedAt: "2026-01-02",
      projectId: "api",
      cwd: "services/api",
    },
  ];
  assert.deepEqual(
    rankSessions(sessions, "site", 10).map((s) => s.sessionId),
    ["1"],
  );
  assert.deepEqual(
    rankSessions(sessions, "api", 10).map((s) => s.sessionId),
    ["2"],
  );
});

test("groupCommands buckets by group preserving order", () => {
  const out = groupCommands([
    { title: "A", group: "View" },
    { title: "B", group: "Session" },
    { title: "C", group: "View" },
  ]);
  assert.deepEqual(
    out.map(([g, cmds]) => [g, cmds.map((c) => c.title)]),
    [
      ["View", ["A", "C"]],
      ["Session", ["B"]],
    ],
  );
});
