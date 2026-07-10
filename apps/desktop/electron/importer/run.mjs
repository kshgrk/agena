// Import orchestration (docs/settings_import_plan.md §8): per selected project
// createProject → optional tar upload → convert each ticked-harness session via
// @agena/importer → POST /v1/imports/session. Sequential; every session import
// is independent — one failure never aborts the batch.
import { readFile, stat } from "node:fs/promises";
import {
  convertToPi,
  groupCodexThreads,
  parseClaudeSession,
  parseCodexRollout,
  parsePiSession,
} from "@agena/importer";
import { tarFolder } from "../bridge.mjs";
import { loadHarnessNames, loadScanIndex } from "./scan.mjs";

const PARSERS = {
  claude: parseClaudeSession,
  codex: parseCodexRollout,
  pi: parsePiSession,
};

const message = (err) => String(err?.message ?? err);

/** @returns {Promise<ImportRunResult>} */
export async function runImport(plan, { client, machineId, userData }) {
  const files = (await loadScanIndex(userData))?.files ?? {};
  const names = await loadHarnessNames();
  const sessions = [];
  for (const project of plan.projects) {
    let created;
    try {
      created = await client.createProject(project.name);
    } catch (err) {
      // 409 slug collision etc. — surface it, keep the rest of the batch going
      sessions.push({
        sourcePath: project.cwd,
        status: "error",
        error: `createProject "${project.name}": ${message(err)}`,
      });
      continue;
    }
    if (project.copyFiles) {
      try {
        if (!(await stat(project.cwd)).isDirectory()) {
          throw new Error("source cwd is not a directory");
        }
        const tar = await tarFolder(project.cwd);
        try {
          await client.uploadFiles(
            { path: created.projectRoot, format: "tar" },
            tar.body,
          );
        } finally {
          await tar.cleanup();
        }
      } catch (err) {
        sessions.push({
          sourcePath: project.cwd,
          status: "error",
          error: `file copy: ${message(err)}`,
        });
      }
    }
    // parse every scanned source for the ticked harnesses in this cwd
    const parsed = [];
    for (const [path, file] of Object.entries(files)) {
      if (file.cwd !== project.cwd) continue;
      if (!project.harnesses.includes(file.harness)) continue;
      try {
        const source = PARSERS[file.harness](
          await readFile(path, "utf8"),
          path,
        );
        if (source) {
          // parsers can't know mtime — fingerprint from the scanned stat so the
          // ledger's (mtime, size) differential (plan §6) actually works
          source.mtimeMs = file.mtimeMs;
          source.size = file.size;
          parsed.push(source);
        } else sessions.push({ sourcePath: path, status: "skipped" });
      } catch (err) {
        sessions.push({
          sourcePath: path,
          status: "error",
          error: message(err),
        });
      }
    }
    // pi dual-store: the same header id can exist in both ~/.pi stores —
    // keep the newer copy (plan §11), never import both.
    const piById = new Map();
    const sources = [];
    for (const source of parsed) {
      if (source.harness !== "pi") {
        sources.push(source);
        continue;
      }
      const prev = piById.get(source.sourceSessionId);
      if (!prev || source.mtimeMs > prev.mtimeMs) {
        piById.set(source.sourceSessionId, source);
      }
    }
    sources.push(...piById.values());
    // merges codex rollouts sharing a thread id; claude/pi pass through.
    // Imports run CONCURRENCY-wide with per-session retry: the route is
    // idempotent (ledger dedupe), so a retried POST can never double-import.
    await pool(groupCodexThreads(sources), async (source) => {
      const converted = convertToPi(source, { targetCwd: created.cwd });
      if (!converted) {
        sessions.push({ sourcePath: source.sourcePath, status: "skipped" });
        return;
      }
      try {
        const res = await withRetry(() =>
          client.importSession({
            projectId: created.projectId,
            projectRoot: created.projectRoot,
            title:
              names.get(
                `${source.harness}\0${converted.sourceFingerprint.sourceSessionId}`,
              ) ??
              (converted.title || undefined),
            sourceFingerprint: { ...converted.sourceFingerprint, machineId },
            piSession: converted.jsonl,
          }),
        );
        sessions.push({
          sourcePath: source.sourcePath,
          status: "ok",
          sessionId: res.sessionId,
        });
      } catch (err) {
        sessions.push({
          sourcePath: source.sourcePath,
          status: "error",
          error: message(err),
        });
      }
    });
  }
  return { sessions };
}

// ponytail: 4-wide — SQLite is a single writer behind the route; wider mostly
// queues on busy_timeout. Bump only if measured.
const CONCURRENCY = 4;

async function pool(items, worker) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        await worker(item);
      }
    }),
  );
}

async function withRetry(fn, attempts = 3) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, i * 1000));
    }
  }
}
