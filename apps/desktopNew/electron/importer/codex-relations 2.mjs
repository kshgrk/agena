// Codex stores the durable subagent graph separately from rollout JSONL. Keep
// this read-only and metadata-only: transcripts still come from the importer.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const defaultDatabasePath = () =>
  join(homedir(), ".codex", "sqlite", "state_5.sqlite");

/**
 * @typedef {{
 *   parentSourceSessionId: string;
 *   childSourceSessionId: string;
 *   parentRolloutPath: string;
 *   childRolloutPath: string;
 *   role: string | null;
 *   nickname: string | null;
 *   status: string;
 *   title: string;
 * }} CodexSubagentRelation
 */

/**
 * Read the Codex thread graph. Thread IDs are the sourceSessionIds emitted by
 * parseCodexRollout, so callers can join this result without parsing content.
 *
 * @param {{ databasePath?: string }} [options]
 * @returns {CodexSubagentRelation[]}
 */
export function readCodexSubagentRelations({
  databasePath = defaultDatabasePath(),
} = {}) {
  if (!existsSync(databasePath)) return [];
  let db;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    return db
      .prepare(
        `SELECT
           edge.parent_thread_id AS parentSourceSessionId,
           edge.child_thread_id AS childSourceSessionId,
           parent.rollout_path AS parentRolloutPath,
           child.rollout_path AS childRolloutPath,
           child.agent_role AS role,
           child.agent_nickname AS nickname,
           edge.status AS status,
           child.title AS title
         FROM thread_spawn_edges AS edge
         INNER JOIN threads AS parent ON parent.id = edge.parent_thread_id
         INNER JOIN threads AS child ON child.id = edge.child_thread_id`,
      )
      .all()
      .map((relation) => ({ ...relation }));
  } catch {
    // Codex may update its private schema or write the DB while we scan. The
    // normal flat-session import remains valid when relation metadata is gone.
    return [];
  } finally {
    db?.close();
  }
}
