import assert from "node:assert/strict";
import { test } from "node:test";
import type { SnapshotSummary } from "@agena/protocol";
import {
  confirmPhrase,
  snapshotLabel,
  visibleSnapshots,
} from "./snapshots-lib.ts";

function snap(over: Partial<SnapshotSummary>): SnapshotSummary {
  return {
    snapshotId: "01SNAPSHOTIDXXXXXXXXXXXXXX",
    workspaceId: "ws",
    kind: "manual",
    storagePath: "/snaps/x",
    sha256: "abc",
    sizeBytes: 1024,
    status: "available",
    createdAt: "2026-07-11T10:00:00Z",
    ...over,
  };
}

test("visibleSnapshots filters deleted and sorts newest first", () => {
  const list = visibleSnapshots([
    snap({ snapshotId: "a", createdAt: "2026-07-10T00:00:00Z" }),
    snap({ snapshotId: "gone", status: "deleted" }),
    snap({ snapshotId: "c", createdAt: "2026-07-11T00:00:00Z" }),
    snap({ snapshotId: "b", createdAt: "2026-07-11T00:00:00Z" }),
  ]);
  assert.deepEqual(
    list.map((s) => s.snapshotId),
    ["c", "b", "a"],
  );
});

test("snapshotLabel: name or id tail", () => {
  assert.equal(
    snapshotLabel(snap({ name: "before refactor" })),
    "before refactor",
  );
  assert.equal(snapshotLabel(snap({ snapshotId: "0123456789" })), "23456789");
});

test("confirmPhrase: name, or the word restore for unnamed", () => {
  assert.equal(confirmPhrase(snap({ name: "green build" })), "green build");
  assert.equal(confirmPhrase(snap({})), "restore");
});
