#!/usr/bin/env node
// Dependency-boundary check (final_plan.md §4.2). CI-blocking: `pnpm boundary`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Allowed workspace edges — anything not listed is forbidden (§4.2 table).
export const EDGES = {
  "@agena/protocol": [],
  "@agena/core": ["@agena/protocol"],
  "@agena/runtime-pi": ["@agena/core", "@agena/protocol"],
  "@agena/storage-sqlite": ["@agena/core", "@agena/protocol"],
  "@agena/importer": ["@agena/protocol"],
  "@agena/client": ["@agena/protocol"],
  "@agena/tui": ["@agena/client", "@agena/protocol"],
  "@agena/desktop": ["@agena/client", "@agena/importer", "@agena/protocol"],
  "@agena/desktop-new": ["@agena/client", "@agena/importer", "@agena/protocol"],
  "@agena/conductor": ["@agena/client"],
  "@agena/daemon": [
    "@agena/core",
    "@agena/importer",
    "@agena/protocol",
    "@agena/runtime-pi",
    "@agena/storage-sqlite",
  ],
  "@agena/cli": ["@agena/client", "@agena/tui", "@agena/protocol"],
};

// Restricted externals: [specifier regex, the only package dir allowed to import it] (§4.2b).
export const RESTRICTED = [
  [
    /^@earendil-works\/(pi-coding-agent|pi-ai|pi-agent-core)(\/|$)/,
    "packages/runtime-pi",
  ],
  [/^@earendil-works\/pi-tui(\/|$)/, "packages/tui"],
  [/^(drizzle|better-sqlite3)/, "packages/storage-sqlite"],
  [/^node-pty(\/|$)/, "apps/daemon"],
  [/^electron(\/|$)/, "apps/desktop"],
];

const IMPORT_RE = /(?:from\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

/** @param {{name: string, dir: string, deps: string[], imports: {file: string, spec: string}[]}[]} pkgs */
export function check(pkgs) {
  const violations = [];
  for (const { name, dir, deps, imports } of pkgs) {
    const allowed = EDGES[name];
    if (!allowed) {
      violations.push(`${name}: not in the §4.2 allowed-edges table`);
      continue;
    }
    for (const dep of deps) {
      if (dep.startsWith("@agena/") && !allowed.includes(dep)) {
        violations.push(
          `${name}: forbidden workspace dependency "${dep}" in package.json`,
        );
      }
    }
    for (const { file, spec } of imports) {
      if (spec.startsWith("@agena/")) {
        const target = spec.split("/").slice(0, 2).join("/");
        if (target !== name && !allowed.includes(target)) {
          violations.push(`${file}: forbidden import "${spec}"`);
        }
      }
      for (const [re, onlyDir] of RESTRICTED) {
        if (re.test(spec) && dir !== onlyDir) {
          violations.push(
            `${file}: "${spec}" may only be imported by ${onlyDir}`,
          );
        }
      }
    }
  }
  return violations;
}

function* tsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules")
      yield* tsFiles(path);
    else if (entry.isFile() && /\.[cm]?ts$/.test(entry.name)) yield path;
  }
}

export function collect(root) {
  const pkgs = [];
  for (const group of ["packages", "apps"]) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      const manifestPath = join(groupDir, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const dir = `${group}/${entry.name}`;
      const imports = [];
      for (const file of tsFiles(join(groupDir, entry.name))) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(IMPORT_RE)) {
          imports.push({ file, spec: match[1] });
        }
      }
      pkgs.push({
        name: manifest.name,
        dir,
        deps: Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
        }),
        imports,
      });
    }
  }
  return pkgs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = check(collect(process.cwd()));
  if (violations.length > 0) {
    console.error(
      `Boundary violations:\n${violations.map((v) => `  ${v}`).join("\n")}`,
    );
    process.exit(1);
  }
  console.log("boundaries ok");
}
