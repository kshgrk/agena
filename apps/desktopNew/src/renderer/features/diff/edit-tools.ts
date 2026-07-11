// Pure parsing of file-edit tool calls out of transcript store data (Block[]),
// so the diff pane can offer "view diff" for agent edits without importing
// any transcript component (ARCHITECTURE cross-feature rule). Node-safe.
import type { Block, ToolBlock } from "../../store/types.ts";

/** What a file-edit tool call gives us to render. */
export type ParsedEdit =
  | { path: string; kind: "text"; oldText: string; newText: string }
  | { path: string; kind: "patch"; hunks: string[] };

const PATH_KEYS = ["path", "file_path", "filePath", "filename", "file"];
const PAIR_KEYS: Array<[oldKey: string, newKey: string]> = [
  ["old_string", "new_string"],
  ["oldText", "newText"],
  ["old_str", "new_str"],
  ["old", "new"],
];

/** Tool names that plausibly edit files (gate before arg parsing). */
export function isEditToolName(name: string): boolean {
  return /edit|write|patch|create[_-]?file|str[_-]?replace/i.test(name);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function pathOf(args: Record<string, unknown>): string | null {
  for (const key of PATH_KEYS) {
    const v = str(args[key]);
    if (v) return v;
  }
  return null;
}

/** Split a unified patch into per-hunk strings, dropping file headers. */
function patchToHunks(patch: string): string[] {
  const hunks: string[][] = [];
  for (const line of patch.split("\n")) {
    if (
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("diff ") ||
      line.startsWith("index ")
    ) {
      continue;
    }
    if (line.startsWith("@@")) hunks.push([line]);
    else if (hunks.length > 0) hunks[hunks.length - 1]!.push(line);
  }
  return hunks.map((h) => h.join("\n"));
}

/** Headerless +/− snippet (some harnesses emit bare patch bodies) → old/new. */
function patchToTexts(patch: string): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+")) newLines.push(line.slice(1));
    else if (line.startsWith("-")) oldLines.push(line.slice(1));
    else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      oldLines.push(text);
      newLines.push(text);
    }
  }
  return { oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

/**
 * Parse one tool call's args into a renderable edit. Handles the shapes in
 * the wild: old/new string pairs (claude/pi edit tools), multi-edit arrays,
 * unified patches (with or without @@ headers), and file writes.
 */
export function parseEditArgs(name: string, args: unknown): ParsedEdit | null {
  if (!isEditToolName(name)) return null;
  if (typeof args !== "object" || args === null) return null;
  const a = args as Record<string, unknown>;
  const path = pathOf(a);
  if (!path) return null;

  for (const [oldKey, newKey] of PAIR_KEYS) {
    const oldText = str(a[oldKey]);
    const newText = str(a[newKey]);
    if (oldText !== null && newText !== null) {
      return { path, kind: "text", oldText, newText };
    }
  }

  // multi-edit: [{old_string,new_string}, …] — stack the pairs; without the
  // file content we cannot splice them into place, but stacked pairs still
  // show exactly what changed.
  if (Array.isArray(a.edits)) {
    const olds: string[] = [];
    const news: string[] = [];
    for (const item of a.edits) {
      if (typeof item !== "object" || item === null) continue;
      const e = item as Record<string, unknown>;
      for (const [oldKey, newKey] of PAIR_KEYS) {
        const o = str(e[oldKey]);
        const n = str(e[newKey]);
        if (o !== null && n !== null) {
          olds.push(o);
          news.push(n);
          break;
        }
      }
    }
    if (olds.length > 0) {
      return {
        path,
        kind: "text",
        oldText: olds.join("\n"),
        newText: news.join("\n"),
      };
    }
  }

  const patch = str(a.patch) ?? str(a.diff);
  if (patch) {
    if (/^@@ -\d/m.test(patch)) {
      const hunks = patchToHunks(patch);
      if (hunks.length > 0) return { path, kind: "patch", hunks };
    }
    return { path, kind: "text", ...patchToTexts(patch) };
  }

  const content = str(a.content) ?? str(a.text);
  if (content !== null && /write|create/i.test(name)) {
    return { path, kind: "text", oldText: "", newText: content };
  }
  return null;
}

export type FileEditItem = { block: ToolBlock; edit: ParsedEdit };

/** File edits in a transcript, newest first. Denied calls never ran. */
export function listFileEdits(blocks: readonly Block[]): FileEditItem[] {
  const items: FileEditItem[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.kind !== "tool" || block.status === "denied") continue;
    const edit = parseEditArgs(block.name, block.args);
    if (edit) items.push({ block, edit });
  }
  return items;
}
