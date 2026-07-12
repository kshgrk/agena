// Import orchestration (docs/settings_import_plan.md §8): per selected project
// createProject → optional tar upload → convert each ticked-harness session via
// @agena/importer → POST /v1/imports/session. Sequential; every session import
// is independent — one failure never aborts the batch.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  convertToPi,
  discoverClaudeSubagents,
  groupCodexThreads,
  parseClaudeSession,
  parseCodexRollout,
  parsePiSession,
} from "@agena/importer";
import { tarFolder } from "../bridge.mjs";
import { readCodexSubagentRelations } from "./codex-relations.mjs";
import { loadHarnessNames, loadScanIndex } from "./scan.mjs";

const PARSERS = {
  claude: parseClaudeSession,
  codex: parseCodexRollout,
  pi: parsePiSession,
};

const message = (err) => String(err?.message ?? err);

async function claudeSubagentCandidates(parentPath) {
  const root = parentPath.replace(/\.jsonl$/u, "");
  const out = [];
  const walk = async (dir) => {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /^agent-[^/]+\.jsonl$/u.test(entry.name)) {
        out.push({ sourcePath: path, content: await readFile(path, "utf8") });
      }
    }
  };
  await walk(join(root, "subagents"));
  return out;
}

function modelOf(source) {
  return source.entries.find(
    (entry) =>
      entry.kind === "message" && entry.role === "assistant" && entry.model,
  )?.model;
}

export function codexSubagentName({ agentPath, nickname }) {
  const basename = agentPath?.split("/").filter(Boolean).at(-1);
  return basename
    ? basename.replaceAll("_", " ")
    : nickname || "Codex subagent";
}

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
        // Session import is the one upload path that preserves repository
        // identity. Ordinary file uploads continue to exclude .git.
        const tar = await tarFolder(project.cwd, { includeGit: true });
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
    const grouped = groupCodexThreads(sources);
    const bySourceId = new Map(
      grouped.map((source) => [source.sourceSessionId, source]),
    );
    const codexRelations = new Map(
      readCodexSubagentRelations()
        .filter(
          (relation) =>
            bySourceId.has(relation.parentSourceSessionId) &&
            bySourceId.has(relation.childSourceSessionId),
        )
        .map((relation) => [relation.childSourceSessionId, relation]),
    );
    for (const source of grouped) {
      const lineage = source.codexSubagent;
      if (lineage && bySourceId.has(lineage.parentSourceSessionId)) {
        codexRelations.set(source.sourceSessionId, {
          parentSourceSessionId: lineage.parentSourceSessionId,
          agentPath: lineage.agentPath,
          nickname: lineage.nickname,
          role: lineage.role,
          title: "",
        });
      }
    }
    const claudeChildren = [];
    for (const source of grouped) {
      if (source.harness !== "claude") continue;
      const content = await readFile(source.sourcePath, "utf8");
      for (const child of discoverClaudeSubagents(
        source.sourcePath,
        await claudeSubagentCandidates(source.sourcePath),
        content,
      )) {
        const childStat = await stat(child.transcript.sourcePath);
        claudeChildren.push({
          source: {
            ...child.transcript,
            // Claude agent ids are only meaningful beneath their parent session.
            // The imports ledger keys this value without sourcePath, so preserve
            // the parent in the child source reference to avoid cross-session
            // dedupe collisions (for example multiple historical "agent-1"s).
            sourceSessionId: `${child.parentSourceSessionId}::${child.agentId}`,
            mtimeMs: childStat.mtimeMs,
            size: childStat.size,
          },
          subagent: {
            parentSourceSessionId: child.parentSourceSessionId,
            agentId: child.agentId,
            role: child.task?.role ?? "Claude subagent",
            task: child.task?.title ?? child.title,
            execution: "foreground",
            model: child.model ?? { provider: "anthropic", id: "claude" },
          },
        });
      }
    }
    const importSource = async (source, subagent) => {
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
              subagent?.task ??
              names.get(
                `${source.harness}\0${converted.sourceFingerprint.sourceSessionId}`,
              ) ??
              (converted.title || undefined),
            sourceFingerprint: { ...converted.sourceFingerprint, machineId },
            ...(subagent ? { subagent } : {}),
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
    };
    const primary = grouped.filter(
      (source) => !codexRelations.has(source.sourceSessionId),
    );
    await pool(primary, (source) => importSource(source));
    const importedSourceIds = new Set(
      primary.map((source) => source.sourceSessionId),
    );
    let pending = grouped.filter((source) =>
      codexRelations.has(source.sourceSessionId),
    );
    while (pending.length > 0) {
      const ready = pending.filter((source) =>
        importedSourceIds.has(
          codexRelations.get(source.sourceSessionId).parentSourceSessionId,
        ),
      );
      // ponytail: a corrupt edge must not block ordinary import; flat is safer
      // than inventing a parent. Valid Codex graphs always make progress here.
      if (ready.length === 0) {
        await pool(pending, (source) => importSource(source));
        break;
      }
      await pool(ready, (source) => {
        const relation = codexRelations.get(source.sourceSessionId);
        const label = codexSubagentName(relation);
        return importSource(source, {
          parentSourceSessionId: relation.parentSourceSessionId,
          agentId: source.sourceSessionId,
          role: label,
          task: label,
          execution: "foreground",
          model: modelOf(source) ?? { provider: "openai", id: "gpt-5" },
        });
      });
      for (const source of ready) importedSourceIds.add(source.sourceSessionId);
      const readyIds = new Set(ready.map((source) => source.sourceSessionId));
      pending = pending.filter(
        (source) => !readyIds.has(source.sourceSessionId),
      );
    }
    await pool(claudeChildren, ({ source, subagent }) =>
      importSource(source, subagent),
    );
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
