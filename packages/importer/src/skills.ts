import { createHash } from "node:crypto";
import { posix } from "node:path";

export type SkillPackageFile = { path: string; contentBase64: string };

export type SkillManifest = {
  name: string;
  description: string;
  version?: string;
  source?: string;
};

export function parseSkillManifest(markdown: string): SkillManifest {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) throw new Error("SKILL.md must start with YAML frontmatter");
  const fields = frontmatterFields(match[1]);
  const name = fields.get("name")?.trim();
  const description = fields.get("description")?.trim();
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)
    throw new Error(
      "skill name must use lowercase letters, numbers, and hyphens",
    );
  if (!description) throw new Error("skill description is required");
  if (description.length > 1024)
    throw new Error("skill description must be at most 1024 characters");
  const version = fields.get("version")?.trim();
  const source = fields.get("source")?.trim();
  return {
    name,
    description,
    ...(version ? { version } : {}),
    ...(source ? { source } : {}),
  };
}

export function normalizeSkillFiles(
  files: SkillPackageFile[],
): SkillPackageFile[] {
  if (files.length === 0 || files.length > 500)
    throw new Error("skill package must contain 1 to 500 files");
  const seen = new Set<string>();
  let bytes = 0;
  const normalized = files.map((file) => {
    const path = posix.normalize(file.path.replaceAll("\\", "/"));
    if (
      !file.path ||
      file.path.includes("\0") ||
      path === "." ||
      path.startsWith("../") ||
      posix.isAbsolute(path) ||
      seen.has(path)
    )
      throw new Error(`invalid skill file path: ${file.path}`);
    seen.add(path);
    const content = Buffer.from(file.contentBase64, "base64");
    bytes += content.length;
    if (bytes > 10 * 1024 * 1024)
      throw new Error("skill package exceeds the 10 MiB limit");
    return { path, contentBase64: content.toString("base64") };
  });
  if (!seen.has("SKILL.md")) throw new Error("skill package needs SKILL.md");
  return normalized.sort((a, b) => a.path.localeCompare(b.path));
}

export function skillContentHash(files: SkillPackageFile[]): string {
  const hash = createHash("sha256");
  for (const file of normalizeSkillFiles(files)) {
    hash.update(file.path).update("\0");
    hash.update(Buffer.from(file.contentBase64, "base64")).update("\0");
  }
  return hash.digest("hex");
}

export function skillIdentity(input: {
  contentHash: string;
  sourceUrl?: string;
  sourcePath?: string;
}): string {
  if (!input.sourceUrl) return `content:${input.contentHash}`;
  const url = new URL(input.sourceUrl);
  url.username = "";
  url.password = "";
  url.hash = "";
  const clean = url
    .toString()
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  const path = input.sourcePath
    ? posix
        .normalize(input.sourcePath.replaceAll("\\", "/"))
        .replace(/^\.\//, "")
    : "";
  if (path.startsWith("../") || posix.isAbsolute(path))
    throw new Error("skill source path must stay inside its repository");
  return `git:${clean}#${path}`;
}

function frontmatterFields(frontmatter: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!match?.[1]) continue;
    const key = match[1];
    const raw = match[2] ?? "";
    if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-") {
      const value: string[] = [];
      while (lines[index + 1]?.match(/^\s+/)) {
        index += 1;
        value.push(lines[index]?.trim() ?? "");
      }
      fields.set(key, value.join(raw.startsWith(">") ? " " : "\n"));
      continue;
    }
    fields.set(key, unquote(raw));
  }
  return fields;
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replaceAll("''", "'");
  return value;
}
