// node --experimental-strip-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@agena/protocol";
import {
  createGlobalSessionInput,
  createProjectSessionInput,
  cycleOrder,
  matchesQuery,
  pathTail,
  sessionGroupLabel,
  splitSessionSections,
} from "./sections.ts";

function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: "01A",
    workspaceId: "ws",
    rootBranchId: "b",
    lastSeq: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    scope: "global",
    status: "idle",
    cwd: ".",
    ...over,
  } as SessionSummary;
}

const sessions: SessionSummary[] = [
  summary({ sessionId: "06", purpose: "quick_chat", title: "Quick Chat" }),
  summary({
    sessionId: "05",
    scope: "project",
    projectId: "p1",
    projectRoot: "/workspace/checkout",
    cwd: "/workspace/checkout",
    title: "fix login",
  }),
  summary({ sessionId: "04", scope: "global", title: "scratch" }),
  summary({
    sessionId: "03",
    scope: "project",
    projectId: "p1",
    projectRoot: "/workspace/checkout",
    cwd: "/workspace/checkout/api",
    status: "archived",
  }),
  summary({ sessionId: "02", scope: "control" }),
  summary({
    sessionId: "01",
    scope: "project",
    projectRoot: "/workspace/tools",
    cwd: "/workspace/tools",
  }), // no projectId
];
const byId = Object.fromEntries(sessions.map((s) => [s.sessionId, s]));
const order = ["06", "05", "04", "03", "02", "01"]; // newest-first

test("splitSessionSections groups, buckets archived, skips control", () => {
  const s = splitSessionSections(byId, order);
  assert.deepEqual(
    s.projectGroups.map((g) => g.key),
    ["p1", "project:01"],
  );
  assert.deepEqual(s.projectGroups[0]?.ids, ["05"]);
  assert.equal(s.projectGroups[0]?.projectId, "p1");
  assert.equal(s.projectGroups[1]?.projectId, null);
  assert.deepEqual(s.globalIds, ["04"]);
  assert.deepEqual(s.archivedIds, ["03"]);
  assert.equal(s.visibleCount, 4);
});

test("query filters across title, cwd, and group label", () => {
  assert.equal(splitSessionSections(byId, order, "login").visibleCount, 1);
  assert.deepEqual(
    splitSessionSections(byId, order, "login").projectGroups[0]?.ids,
    ["05"],
  );
  // group label "checkout" also matches the archived project session
  assert.equal(splitSessionSections(byId, order, "checkout").visibleCount, 2);
  assert.equal(splitSessionSections(byId, order, "nope").visibleCount, 0);
  assert.equal(splitSessionSections(byId, order, "  ").visibleCount, 4); // blank = all
});

test("matchesQuery is case-insensitive", () => {
  const s = byId["05"];
  assert.ok(s && matchesQuery(s, "checkout", "LOGIN"));
  assert.ok(s && matchesQuery(s, "checkout", "CHECK"));
  assert.ok(s && !matchesQuery(s, "checkout", "zzz"));
});

test("cycleOrder flattens projects then global, excludes archived", () => {
  const s = splitSessionSections(byId, order);
  assert.deepEqual(cycleOrder(s), ["05", "01", "04"]);
});

test("group label prefers hostCwdHint over projectRoot over projectId", () => {
  assert.equal(
    sessionGroupLabel(
      summary({
        hostCwdHint: "/Users/me/dev/app",
        projectRoot: "/workspace/x",
        projectId: "p",
      }),
    ),
    "app",
  );
  assert.equal(
    sessionGroupLabel(summary({ projectRoot: "/workspace/x", projectId: "p" })),
    "x",
  );
  assert.equal(sessionGroupLabel(summary({ projectId: "p" })), "p");
  assert.equal(sessionGroupLabel(summary({})), "Global");
});

test("pathTail keeps the last two segments", () => {
  assert.equal(pathTail("/workspace/checkout/api"), "checkout/api");
  assert.equal(pathTail("solo"), "solo");
  assert.equal(pathTail("/"), "/");
});

test("create inputs", () => {
  assert.deepEqual(createGlobalSessionInput(), { scope: "global", cwd: "." });
  assert.equal(createProjectSessionInput(summary({})), null);
  assert.deepEqual(
    createProjectSessionInput(
      summary({ projectId: "p1", projectRoot: "/workspace/checkout" }),
    ),
    {
      scope: "project",
      projectId: "p1",
      projectRoot: "/workspace/checkout",
      cwd: "/workspace/checkout",
    },
  );
});
