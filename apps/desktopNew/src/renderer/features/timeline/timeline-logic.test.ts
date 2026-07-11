import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bucketize,
  familyCounts,
  familyOf,
  matchesTimelineFilter,
  rankOf,
  seqAtFraction,
} from "./timeline-logic.ts";

test("matchesTimelineFilter families", () => {
  assert.equal(matchesTimelineFilter("anything.at.all", "all"), true);
  assert.equal(matchesTimelineFilter("message.user.created", "agent"), true);
  assert.equal(matchesTimelineFilter("run.started", "agent"), true);
  assert.equal(matchesTimelineFilter("tool.call.started", "tools"), true);
  assert.equal(matchesTimelineFilter("tool.call.started", "agent"), false);
  assert.equal(matchesTimelineFilter("terminal.started", "terminal"), true);
  assert.equal(matchesTimelineFilter("approval.requested", "approvals"), true);
  assert.equal(matchesTimelineFilter("snapshot.created", "snapshots"), true);
  // errors match by suffix, including underscore forms
  assert.equal(matchesTimelineFilter("tool.call.failed", "errors"), true);
  assert.equal(matchesTimelineFilter("tool.call.denied", "errors"), true);
  assert.equal(matchesTimelineFilter("snapshot.restore_failed", "errors"), true);
  assert.equal(matchesTimelineFilter("message.assistant.completed", "errors"), false);
});

test("rankOf priority: error beats approval beats user beats snapshot beats tool", () => {
  assert.equal(rankOf("approval.denied"), 0); // error-ish suffix wins
  assert.equal(rankOf("approval.requested"), 1);
  assert.equal(rankOf("message.user.created"), 2);
  assert.equal(rankOf("snapshot.created"), 3);
  assert.equal(rankOf("tool.call.started"), 4);
  assert.equal(rankOf("message.assistant.completed"), 5);
  assert.equal(rankOf("session.created"), 6);
});

test("familyOf maps rank to a labeled family", () => {
  assert.equal(familyOf("tool.call.started").label, "tools");
  assert.equal(familyOf("wat.is.this").label, "other");
});

test("bucketize clusters shared pixels and keeps the best rank", () => {
  const rows = [
    { seq: 1, type: "message.user.created" },
    { seq: 2, type: "tool.call.started" },
    { seq: 3, type: "tool.call.failed" },
    { seq: 100, type: "message.assistant.completed" },
  ];
  const out = bucketize(rows, 100, 10, "all");
  // seqs 1..3 all land in bucket 0; seq 100 in the last bucket
  assert.equal(out.length, 2);
  const first = out[0]!;
  assert.equal(first.index, 0);
  assert.equal(first.count, 3);
  assert.equal(first.firstSeq, 1);
  assert.equal(first.lastSeq, 3);
  assert.equal(first.rank, 0); // the failed tool call wins the color
  assert.equal(first.type, "tool.call.failed");
  assert.equal(out[1]!.index, 9);
});

test("bucketize respects the filter and empty inputs", () => {
  const rows = [
    { seq: 1, type: "terminal.started" },
    { seq: 2, type: "tool.call.started" },
  ];
  const tools = bucketize(rows, 2, 4, "tools");
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.firstSeq, 2);
  assert.deepEqual(bucketize([], 10, 10, "all"), []);
  assert.deepEqual(bucketize(rows, 0, 10, "all"), []);
  assert.deepEqual(bucketize(rows, 10, 0, "all"), []);
});

test("bucketize clamps seq > lastSeq into the final bucket", () => {
  const rows = [{ seq: 50, type: "tool.call.started" }];
  const out = bucketize(rows, 10, 4, "all"); // stale lastSeq below max row seq
  assert.equal(out.length, 1);
  assert.equal(out[0]!.index, 3);
});

test("familyCounts tallies by rank order", () => {
  const counts = familyCounts([
    { type: "tool.call.started" },
    { type: "tool.call.completed" },
    { type: "message.user.created" },
    { type: "tool.call.failed" },
  ]);
  assert.equal(counts[0], 1); // errors
  assert.equal(counts[2], 1); // user
  assert.equal(counts[4], 2); // tools
});

test("seqAtFraction picks the nearest loaded seq", () => {
  const rows = [{ seq: 10 }, { seq: 20 }, { seq: 90 }];
  assert.equal(seqAtFraction(rows, 100, 0), 10);
  assert.equal(seqAtFraction(rows, 100, 1), 90);
  assert.equal(seqAtFraction(rows, 100, 0.14), 10); // target 14 → 10 closer than 20
  assert.equal(seqAtFraction(rows, 100, 0.17), 20); // target 17 → 20 closer
  assert.equal(seqAtFraction(rows, 100, 0.5), 20); // target 50 → 20 closer than 90
  assert.equal(seqAtFraction([], 100, 0.5), null);
  assert.equal(seqAtFraction(rows, 0, 0.5), null);
  // out-of-range fractions clamp
  assert.equal(seqAtFraction(rows, 100, -3), 10);
  assert.equal(seqAtFraction(rows, 100, 42), 90);
});
