// Local-session scanner (docs/settings_import_plan.md §4). Enumerates Claude
// Code / Codex / pi session files under the home dir, parses just enough of
// each (cwd/sessionId/title/messageCount) to build ProjectGroup rows, and
// caches the index at userData/import-index.json so refreshes only re-parse
// files whose (mtimeMs, size) changed.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  messageCountOf,
  parseClaudeSession,
  parseCodexRollout,
  parsePiSession,
  titleFromEntries,
} from "@agena/importer";

const execFileAsync = promisify(execFile);
const indexPath = (userData) => join(userData, "import-index.json");

export async function loadScanIndex(userData) {
  try {
    return JSON.parse(await readFile(indexPath(userData), "utf8"));
  } catch {
    return null;
  }
}

/** @returns {Promise<{ projects: ProjectGroup[]; scannedAt: string }>} */
export async function scanImports({ userData, refresh = false }) {
  const cached = await loadScanIndex(userData);
  const index =
    cached && !refresh ? cached : await buildIndex(userData, cached);
  return { projects: await groupProjects(index), scannedAt: index.scannedAt };
}

// ---- index build (differential) --------------------------------------------

async function buildIndex(userData, cached) {
  const prev = cached?.files ?? {};
  const files = {};
  for (const src of await listSourceFiles()) {
    const hit = prev[src.path];
    if (hit && hit.mtimeMs === src.mtimeMs && hit.size === src.size) {
      files[src.path] = hit;
      continue;
    }
    const meta = await parseHead(src).catch(() => null);
    if (meta) {
      files[src.path] = {
        mtimeMs: src.mtimeMs,
        size: src.size,
        harness: src.harness,
        ...meta,
      };
    }
  }
  const index = { scannedAt: new Date().toISOString(), files };
  await mkdir(userData, { recursive: true });
  await writeFile(indexPath(userData), JSON.stringify(index));
  return index;
}

const PI_FILE =
  /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

async function listSourceFiles() {
  const home = homedir();
  const out = [];
  const push = async (path, harness) => {
    try {
      const s = await stat(path);
      if (s.isFile()) {
        out.push({ path, harness, mtimeMs: s.mtimeMs, size: s.size });
      }
    } catch {
      // vanished between readdir and stat
    }
  };
  // claude: ~/.claude/projects/*/ top-level *.jsonl only — no recursion, which
  // also excludes */subagents/** journal noise (plan §2 fix 2).
  for (const dir of await subdirs(join(home, ".claude", "projects"))) {
    for (const e of await entries(dir)) {
      if (e.isFile() && e.name.endsWith(".jsonl")) {
        await push(join(dir, e.name), "claude");
      }
    }
  }
  // codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  const codexRoot = join(home, ".codex", "sessions");
  for (const year of await subdirs(codexRoot)) {
    for (const month of await subdirs(year)) {
      for (const day of await subdirs(month)) {
        for (const e of await entries(day)) {
          if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) {
            await push(join(day, e.name), "codex");
          }
        }
      }
    }
  }
  // pi: both stores (plan §11), *_<uuid>.jsonl inside per-cwd dirs (and a few
  // stray top-level files seen in the wild).
  const piRoots = [
    join(home, ".pi", "agent", "sessions"),
    join(home, ".pi", "sessions"),
  ];
  for (const root of piRoots) {
    for (const e of await entries(root)) {
      if (e.isDirectory()) {
        for (const f of await entries(join(root, e.name))) {
          if (f.isFile() && PI_FILE.test(f.name)) {
            await push(join(root, e.name, f.name), "pi");
          }
        }
      } else if (e.isFile() && PI_FILE.test(e.name)) {
        await push(join(root, e.name), "pi");
      }
    }
  }
  return out;
}

async function subdirs(dir) {
  return (await entries(dir))
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name));
}

async function entries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ---- real session names (harness indexes) -------------------------------------
// Codex keeps proper thread names in ~/.codex/session_index.jsonl; Claude stores
// no names, but ~/.claude/history.jsonl has what the user actually typed — the
// first non-slash-command prompt per session is an honest title.

export async function loadHarnessNames() {
  const home = homedir();
  /** @type {Map<string, string>} `${harness}\0${sessionId}` → display name */
  const names = new Map();
  for (const line of await jsonLines(
    join(home, ".codex", "session_index.jsonl"),
  )) {
    if (typeof line.id === "string" && typeof line.thread_name === "string") {
      names.set(`codex\0${line.id}`, line.thread_name.slice(0, 80));
    }
  }
  for (const line of await jsonLines(join(home, ".claude", "history.jsonl"))) {
    const key = `claude\0${line.sessionId}`;
    if (
      typeof line.sessionId === "string" &&
      typeof line.display === "string" &&
      line.display.trim() &&
      !line.display.startsWith("/") &&
      !names.has(key) // file is chronological: keep the earliest prompt
    ) {
      names.set(key, line.display.trim().split("\n", 1)[0].slice(0, 80));
    }
  }
  return names;
}

async function jsonLines(path) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial trailing write — skip
    }
  }
  return out;
}

// ---- head parse (display metadata only) --------------------------------------
// Same @agena/importer parsers the converter uses (run.mjs); the scan index just
// keeps the cheap fields. Zero-message / cwd-less sources are dropped here.

const PARSERS = {
  claude: parseClaudeSession,
  codex: parseCodexRollout,
  pi: parsePiSession,
};

async function parseHead({ path, harness }) {
  // ponytail: full read of changed files (≤ ~13 MB); stream if it ever hurts.
  const source = PARSERS[harness](await readFile(path, "utf8"), path);
  if (!source?.cwd) return null;
  return {
    cwd: source.cwd,
    sessionId: source.sourceSessionId,
    title: titleFromEntries(source.entries),
    messageCount: messageCountOf(source.entries),
  };
}

// ---- grouping ---------------------------------------------------------------

async function groupProjects(index) {
  const groups = new Map();
  const seen = new Set(); // dedupe codex thread files / pi dual-store copies
  for (const file of Object.values(index.files)) {
    let group = groups.get(file.cwd);
    if (!group) {
      group = {
        cwd: file.cwd,
        exists: false,
        codebaseBytes: null,
        byHarness: {
          claude: { count: 0, bytes: 0 },
          codex: { count: 0, bytes: 0 },
          pi: { count: 0, bytes: 0 },
        },
      };
      groups.set(file.cwd, group);
    }
    const bucket = group.byHarness[file.harness];
    const key = `${file.harness}\0${file.sessionId}`;
    if (!seen.has(key)) {
      seen.add(key);
      bucket.count += 1;
      bucket.bytes += file.size;
    } else if (file.harness === "codex") {
      // codex rollouts sharing a thread id all merge into the one session —
      // their bytes belong to it; pi dual-store copies are duplicates, not merged.
      bucket.bytes += file.size;
    }
  }
  await Promise.all(
    [...groups.values()].map(async (group) => {
      group.exists = await stat(group.cwd).then(
        (s) => s.isDirectory(),
        () => false,
      );
      if (group.exists) group.codebaseBytes = await gitBytes(group.cwd);
    }),
  );
  return [...groups.values()];
}

// Tracked-file size sum via git — NEVER an fs directory walk, which hangs on
// iCloud-backed home dirs (plan §4 spike lesson). ls-tree reads the object db
// only, so it returns in ms and touches no working-tree files.
async function gitBytes(cwd) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-tree", "-r", "-l", "HEAD"],
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
    );
    let sum = 0;
    for (const line of stdout.split("\n")) {
      const match = line.match(/ blob \S+\s+(\d+)\t/);
      if (match) sum += Number(match[1]);
    }
    return sum;
  } catch {
    return null; // non-git, no HEAD, or timeout → rendered as "—"
  }
}
