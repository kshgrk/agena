// Pure helpers for the files pane: root derivation, lazy tree flattening for
// the virtualized list, and viewer guards. Node-safe (type-only imports).
import type { FileEntry, SessionSummary } from "@agena/protocol";

// ---- roots & paths -------------------------------------------------------------

/** Strip the /workspace prefix; bare "/workspace" → "." (listFiles root). */
export function workspaceRelative(path: string): string {
  if (path === "/workspace" || path === "/workspace/") return ".";
  if (path.startsWith("/workspace/")) return path.slice("/workspace/".length);
  return path;
}

/** Project sessions browse their project root; everything else the workspace. */
export function fileRootForSession(
  session: Pick<SessionSummary, "scope" | "projectRoot"> | null | undefined,
): string {
  if (session && session.scope === "project" && session.projectRoot) {
    return workspaceRelative(session.projectRoot);
  }
  return ".";
}

export function childPath(parent: string, name: string): string {
  return parent === "." ? name : `${parent}/${name}`;
}

export function breadcrumbs(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

// ---- tree flattening ------------------------------------------------------------

export type DirState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: FileEntry[] };

export type TreeRow =
  | { kind: "dir"; path: string; name: string; depth: number; expanded: boolean }
  | { kind: "file"; path: string; name: string; depth: number; size: number }
  | {
      kind: "note";
      path: string;
      depth: number;
      note: "loading" | "error" | "empty";
      message?: string;
    };

/** Directories first, then case-insensitive by name. */
export function sortEntries(entries: readonly FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.type === "dir" ? 0 : 1;
    const bDir = b.type === "dir" ? 0 : 1;
    return (
      aDir - bDir || a.name.localeCompare(b.name, undefined, { numeric: true })
    );
  });
}

/**
 * Flatten the lazily loaded tree into rows for virtualization: descend only
 * into expanded dirs; unloaded/loading/error/empty dirs contribute one note
 * row so the list always shows why nothing is under a folder.
 */
export function flattenTree(
  root: string,
  dirs: Readonly<Record<string, DirState>>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number): void => {
    const state = dirs[dir];
    if (!state || state.status === "loading") {
      rows.push({ kind: "note", path: dir, depth, note: "loading" });
      return;
    }
    if (state.status === "error") {
      rows.push({
        kind: "note",
        path: dir,
        depth,
        note: "error",
        message: state.message,
      });
      return;
    }
    if (state.entries.length === 0) {
      rows.push({ kind: "note", path: dir, depth, note: "empty" });
      return;
    }
    for (const entry of sortEntries(state.entries)) {
      const path = childPath(dir, entry.name);
      if (entry.type === "dir") {
        const isOpen = expanded.has(path);
        rows.push({
          kind: "dir",
          path,
          name: entry.name,
          depth,
          expanded: isOpen,
        });
        if (isOpen) walk(path, depth + 1);
      } else {
        rows.push({
          kind: "file",
          path,
          name: entry.name,
          depth,
          size: entry.size,
        });
      }
    }
  };
  walk(root, 0);
  return rows;
}

// ---- viewer guards ---------------------------------------------------------------

export const MAX_PREVIEW_BYTES = 512 * 1024;

/** Heuristic: a NUL byte in the first 1 KiB means "not text". */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "svg",
  "avif",
]);

export function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTS.has(extOf(path));
}

// shiki bundled-language ids (viewer highlighting)
const EXT_SHIKI_LANG: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  sql: "sql",
  lua: "lua",
  vue: "vue",
  svelte: "svelte",
  graphql: "graphql",
  dockerfile: "docker",
};

/** shiki lang id for a path; "text" (no grammar load) when unknown. */
export function shikiLangForPath(path: string): string {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (name === "dockerfile") return "docker";
  if (name === "makefile") return "make";
  return EXT_SHIKI_LANG[extOf(path)] ?? "text";
}
