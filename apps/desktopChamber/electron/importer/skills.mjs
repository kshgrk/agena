import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  normalizeSkillFiles,
  parseSkillManifest,
  skillContentHash,
  skillIdentity,
} from "@agena/importer/skills";

const MAX_FILES = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_BYTES = 10 * 1024 * 1024;
let privateScan = new Map();
const execFileAsync = promisify(execFile);
const SKIP_DIRS = new Set([".git", "node_modules"]);

const digest = (value) => createHash("sha256").update(value).digest("hex");
export const publicSkillIdentity = (identity) =>
  `skill:${digest(identity).slice(0, 24)}`;

async function entries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function skillDirs(root) {
  const found = [];
  for (const entry of await entries(root)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    try {
      if ((await stat(join(path, "SKILL.md"))).isFile()) found.push(path);
    } catch {
      // not a skill folder
    }
    found.push(...(await skillDirs(path)));
  }
  return found;
}

async function findPluginSkills(root, depth = 0) {
  if (depth > 7) return [];
  const found = [];
  for (const entry of await entries(root)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (basename(dirname(path)) === "skills") {
      try {
        if ((await stat(join(path, "SKILL.md"))).isFile()) {
          found.push(path);
          continue;
        }
      } catch {
        // keep searching
      }
    }
    found.push(...(await findPluginSkills(path, depth + 1)));
  }
  return found;
}

async function claudePluginSkills(home) {
  try {
    const installed = JSON.parse(
      await readFile(
        join(home, ".claude", "plugins", "installed_plugins.json"),
        "utf8",
      ),
    );
    const paths = Object.values(installed.plugins ?? {})
      .flat()
      .flatMap((plugin) =>
        typeof plugin?.installPath === "string" ? [plugin.installPath] : [],
      );
    return (
      await Promise.all(paths.map((path) => skillDirs(join(path, "skills"))))
    ).flat();
  } catch {
    return [];
  }
}

async function codexPluginSkills(home) {
  try {
    const { stdout } = await execFileAsync("codex", ["plugin", "list"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const roots = [];
    for (const line of stdout.split(/\r?\n/)) {
      const columns = line.trim().split(/\s{2,}/);
      const id = columns[0];
      if (!id?.includes("@") || columns[1] !== "installed, enabled") continue;
      const local = columns.at(-1);
      if (local?.startsWith("/")) roots.push(local);
      const [plugin, marketplace] = id.split("@");
      if (plugin && marketplace)
        roots.push(
          join(home, ".codex", "plugins", "cache", marketplace, plugin),
        );
    }
    return (
      await Promise.all(
        [...new Set(roots)].map((root) => findPluginSkills(root)),
      )
    ).flat();
  } catch {
    return [];
  }
}

async function packageSkill(directory) {
  const root = await realpath(directory);
  const files = [];
  let total = 0;
  const walk = async (dir) => {
    for (const entry of await entries(dir)) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        try {
          if ((await stat(join(absolute, "SKILL.md"))).isFile()) continue;
        } catch {
          // ordinary supporting directory
        }
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const path = relative(root, absolute).split(sep).join("/");
      if (!path || path.startsWith("../") || path.includes("/../")) continue;
      const data = await readFile(absolute);
      if (data.length > MAX_FILE_BYTES)
        throw new Error(`${path} exceeds 10 MB`);
      total += data.length;
      if (files.length >= MAX_FILES || total > MAX_SKILL_BYTES)
        throw new Error("skill package exceeds safe import limits");
      files.push({ path, contentBase64: data.toString("base64") });
    }
  };
  await walk(root);
  const normalizedFiles = normalizeSkillFiles(files);
  const contentHash = skillContentHash(normalizedFiles);
  const markdownFile = normalizedFiles.find((file) => file.path === "SKILL.md");
  if (!markdownFile) throw new Error("SKILL.md is missing");
  const metadata = parseSkillManifest(
    Buffer.from(markdownFile.contentBase64, "base64").toString("utf8"),
  );
  const source = (await gitSource(root)) ?? (await pluginSource(root));
  const identityUrl = source ? normalizeGitUrl(source.url) : undefined;
  const identity = skillIdentity({
    contentHash,
    ...(source ? { sourceUrl: identityUrl, sourcePath: source.path } : {}),
  });
  const id = digest(identity).slice(0, 20);
  return {
    public: {
      id,
      identity: publicSkillIdentity(identity),
      contentHash,
      name: metadata.name,
      ...(metadata.description ? { description: metadata.description } : {}),
      fileCount: files.length,
    },
    request: {
      identity,
      name: metadata.name,
      description: metadata.description,
      ...(source
        ? {
            source: {
              url: identityUrl,
              ...(source.path ? { path: source.path } : {}),
              ...(source.revision ? { revision: source.revision } : {}),
            },
          }
        : {}),
      files: normalizedFiles,
    },
  };
}

async function gitSource(directory) {
  try {
    const options = { cwd: directory, encoding: "utf8" };
    const [{ stdout: top }, { stdout: url }, { stdout: revision }] =
      await Promise.all([
        execFileAsync("git", ["rev-parse", "--show-toplevel"], options),
        execFileAsync("git", ["config", "--get", "remote.origin.url"], options),
        execFileAsync("git", ["rev-parse", "HEAD"], options),
      ]);
    const root = top.trim();
    const sourceUrl = url.trim();
    if (!root || !sourceUrl) return null;
    return {
      url: sourceUrl,
      path: relative(root, directory).split(sep).join("/"),
      revision: revision.trim(),
    };
  } catch {
    return null;
  }
}

async function pluginSource(directory) {
  let root = directory;
  for (let depth = 0; depth < 10; depth += 1) {
    for (const path of [
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      ".cursor-plugin/plugin.json",
    ]) {
      try {
        const manifest = JSON.parse(await readFile(join(root, path), "utf8"));
        const repository =
          typeof manifest.repository === "string"
            ? manifest.repository
            : manifest.repository?.url;
        if (typeof repository !== "string") continue;
        const parsed = repositorySource(repository);
        return {
          url: parsed.url,
          path: [parsed.path, relative(root, directory).split(sep).join("/")]
            .filter(Boolean)
            .join("/"),
        };
      } catch {
        // keep walking toward the plugin root
      }
    }
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return null;
}

function repositorySource(value) {
  const normalized = normalizeGitUrl(value.replace(/^git\+/, ""));
  const tree = normalized.match(
    /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/[^/]+\/(.+)\/?$/,
  );
  return tree
    ? { url: tree[1], path: tree[2].replace(/\/$/, "") }
    : { url: normalized.replace(/\/tree\/[^/]+\/?$/, ""), path: "" };
}

function normalizeGitUrl(value) {
  const scp = value.match(/^git@([^:\s]+):(.+)$/);
  return scp ? `https://${scp[1]}/${scp[2]}` : value;
}

export async function scanSkills({
  refresh = false,
  roots,
  projectRoots = [],
} = {}) {
  if (!refresh && privateScan.size > 0)
    return {
      skills: [...privateScan.values()].map((skill) => skill.public),
      scannedAt: new Date().toISOString(),
    };
  const home = homedir();
  const regularRoots = roots ?? [
    join(home, ".claude", "skills"),
    join(home, ".codex", "skills"),
    join(home, ".agents", "skills"),
    ...projectRoots.flatMap((root) => [
      join(root, ".claude", "skills"),
      join(root, ".codex", "skills"),
      join(root, ".agents", "skills"),
    ]),
  ];
  const dirs = (await Promise.all(regularRoots.map(skillDirs))).flat();
  if (!roots) {
    dirs.push(
      ...(await claudePluginSkills(home)),
      ...(await codexPluginSkills(home)),
    );
  }
  privateScan = new Map();
  const contentSeen = new Set();
  for (const directory of dirs) {
    try {
      const skill = await packageSkill(resolve(directory));
      if (contentSeen.has(skill.public.contentHash)) continue;
      contentSeen.add(skill.public.contentHash);
      privateScan.set(skill.public.id, skill);
    } catch {
      // A malformed/oversized local folder is not an importable skill.
    }
  }
  return {
    skills: [...privateScan.values()].map((skill) => skill.public),
    scannedAt: new Date().toISOString(),
  };
}

export async function importSkills(plan, client) {
  const skills = [];
  for (const id of plan?.ids ?? []) {
    const item = privateScan.get(id);
    if (!item) {
      skills.push({
        id,
        status: "error",
        error: "Skill is no longer in the discovery index",
      });
      continue;
    }
    try {
      const result = await client.importSkill(item.request);
      skills.push({
        id,
        skillId: result.skill.id,
        status: "imported",
      });
    } catch (error) {
      skills.push({
        id,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { skills };
}
