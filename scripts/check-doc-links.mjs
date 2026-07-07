import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const skipDirs = new Set([".git", "node_modules"]);
const linkRe = /!?\[[^\]]*]\(([^)]+)\)/g;
const failures = [];

for (const file of markdownFiles(root)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(linkRe)) {
    const target = cleanTarget(match[1]);
    if (!target || skipTarget(target)) continue;
    const [path] = target.split("#");
    if (!path) continue;
    const abs = resolve(dirname(file), decodeURIComponent(path));
    if (!existsSync(abs)) failures.push(`${relativeFile(file)} -> ${target}`);
  }
}

if (failures.length > 0) {
  console.error(`broken Markdown links:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log("doc links ok");

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name))
        yield* markdownFiles(join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      yield join(dir, entry.name);
    }
  }
}

function cleanTarget(raw) {
  const target = raw.trim();
  return target.startsWith("<") && target.endsWith(">")
    ? target.slice(1, -1)
    : target;
}

function skipTarget(target) {
  return target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function relativeFile(file) {
  return file.slice(root.length + 1);
}
