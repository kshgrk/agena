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
  | {
      kind: "dir";
      path: string;
      name: string;
      depth: number;
      expanded: boolean;
    }
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
export const MAX_RASTER_BYTES_DESKTOP = 25 * 1024 * 1024;
export const MAX_RASTER_BYTES_MOBILE = 12 * 1024 * 1024;

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

const RASTER_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
]);

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd"]);

export type FileRenderDecision =
  | { kind: "source"; language: string }
  | { kind: "markdown" }
  | { kind: "image"; mediaType: string }
  | { kind: "unsupported"; reason: string };

export function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTS.has(extOf(path));
}

export function isRasterImagePath(path: string): boolean {
  return RASTER_EXTS.has(extOf(path));
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTS.has(extOf(path));
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export function sniffRasterMediaType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(ascii(bytes, 0, 6)))
    return "image/gif";
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  )
    return "image/webp";
  if (bytes.length >= 2 && ascii(bytes, 0, 2) === "BM") return "image/bmp";
  if (
    bytes.length >= 12 &&
    ascii(bytes, 4, 4) === "ftyp" &&
    ["avif", "avis"].includes(ascii(bytes, 8, 4))
  )
    return "image/avif";
  return null;
}

export function detectFileRenderer(input: {
  path: string;
  size: number;
  prefix: Uint8Array;
  maxRasterBytes?: number;
}): FileRenderDecision {
  const extension = extOf(input.path);
  if (MARKDOWN_EXTS.has(extension)) {
    return input.size > MAX_PREVIEW_BYTES
      ? {
          kind: "unsupported",
          reason: "Markdown preview is limited to 512 KB.",
        }
      : looksBinary(input.prefix)
        ? {
            kind: "unsupported",
            reason: "This Markdown file contains binary data.",
          }
        : { kind: "markdown" };
  }
  if (RASTER_EXTS.has(extension)) {
    if (input.size > (input.maxRasterBytes ?? MAX_RASTER_BYTES_DESKTOP)) {
      return {
        kind: "unsupported",
        reason: "This image is too large to preview safely.",
      };
    }
    const mediaType = sniffRasterMediaType(input.prefix);
    return mediaType
      ? { kind: "image", mediaType }
      : {
          kind: "unsupported",
          reason: "The file contents do not match a supported image format.",
        };
  }
  if (looksBinary(input.prefix)) {
    return {
      kind: "unsupported",
      reason: "No preview is available for this binary format.",
    };
  }
  return input.size > MAX_PREVIEW_BYTES
    ? { kind: "unsupported", reason: "Source previews are limited to 512 KB." }
    : { kind: "source", language: shikiLangForPath(input.path) };
}

export function resolveWorkspaceLink(
  currentPath: string,
  href: string,
  root: string,
): string | null {
  const withoutFragment = href.split(/[?#]/, 1)[0] ?? "";
  if (!withoutFragment || /^[a-z][a-z\d+.-]*:/i.test(withoutFragment))
    return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment).replaceAll("\\", "/");
  } catch {
    return null;
  }
  const rootParts = root === "." ? [] : root.split("/").filter(Boolean);
  const currentParts = currentPath.split("/").filter(Boolean);
  if (
    rootParts.some((part, index) => currentParts[index] !== part) ||
    currentParts.length < rootParts.length
  )
    return null;
  const parts = decoded.startsWith("/")
    ? [...rootParts]
    : currentParts.slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length <= rootParts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/") || ".";
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
