import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateActivity,
  filterSessionTree,
  projectSessionPreview,
  sessionTreeContains,
} from "./types.ts";

const tree = [
  {
    id: "parent",
    title: "Parent",
    activity: "idle" as const,
    children: [
      {
        id: "child",
        title: "Research agent",
        context: "harp",
        activity: "active" as const,
      },
    ],
  },
];

test("collapsed activity rolls active children up to the project", () => {
  assert.equal(aggregateActivity(tree), "active");
});

test("search retains matching child and its parent hierarchy", () => {
  assert.deepEqual(filterSessionTree(tree, "research"), tree);
});

test("projects preview five parent sessions while search and show-more reveal all", () => {
  const sessions = Array.from({ length: 7 }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `Session ${index + 1}`,
  }));
  assert.deepEqual(
    projectSessionPreview(sessions, false, "").map((session) => session.id),
    ["session-1", "session-2", "session-3", "session-4", "session-5"],
  );
  assert.equal(projectSessionPreview(sessions, true, "").length, 7);
  assert.equal(projectSessionPreview(sessions, false, "match").length, 7);
});

test("session containment includes nested subagents", () => {
  assert.equal(sessionTreeContains(tree, "child"), true);
  assert.equal(sessionTreeContains(tree, "missing"), false);
});
