import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readCodexSubagentRelations } from "./codex-relations.mjs";

test("reads Codex subagent edges without reading rollout content", async () => {
  const databasePath = join(
    await mkdtemp(join(tmpdir(), "agena-codex-")),
    "state.sqlite",
  );
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      title TEXT NOT NULL,
      agent_role TEXT,
      agent_nickname TEXT
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY,
      status TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run(
    "parent",
    "/rollouts/parent.jsonl",
    "Parent",
    null,
    null,
  );
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run(
    "child",
    "/rollouts/child.jsonl",
    "Architecture review",
    "explorer",
    "Ada",
  );
  db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)").run(
    "parent",
    "child",
    "closed",
  );
  db.close();

  assert.deepEqual(readCodexSubagentRelations({ databasePath }), [
    {
      parentSourceSessionId: "parent",
      childSourceSessionId: "child",
      parentRolloutPath: "/rollouts/parent.jsonl",
      childRolloutPath: "/rollouts/child.jsonl",
      role: "explorer",
      nickname: "Ada",
      status: "closed",
      title: "Architecture review",
    },
  ]);
});

test("returns no relations when Codex state is unavailable", () => {
  assert.deepEqual(
    readCodexSubagentRelations({ databasePath: "/missing/state.sqlite" }),
    [],
  );
});
