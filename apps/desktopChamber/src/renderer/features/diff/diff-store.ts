// Diff feature state + the cross-feature API. Other features open diffs
// through `openDiff(...)` / the `diff.open` command — never by importing the
// DiffPane component (ARCHITECTURE cross-feature rules).
import { highlighter } from "@git-diff-view/react";
import { create } from "zustand";
import { registerCommands, runCommand } from "../../store/commands.ts";
import { useSessions } from "../../store/sessions.ts";
import { useTranscripts } from "../../store/transcript.ts";
import type { ToolBlock } from "../../store/types.ts";
import {
  type FileEditItem,
  listFileEdits,
  type ParsedEdit,
  parseEditArgs,
} from "./edit-tools.ts";
import {
  buildUnifiedHunks,
  composeGitDiff,
  hunkStats,
} from "./unified-diff.ts";

highlighter.setMaxLineToIgnoreSyntax(Number.MAX_SAFE_INTEGER);

/** The contract other features call (features/diff/diff-store.ts openDiff). */
export type OpenDiffInput = {
  path: string;
  oldText: string;
  newText: string;
  /** Highlight language; derived from the path extension when omitted. */
  lang?: string;
};

/** A fully prepared, renderable diff. */
export type DiffEntry = {
  path: string;
  lang: string;
  /** One git-style diff string (header + hunks); empty = no changes. */
  hunks: string[];
  /** Full file contents when known (enables expanding unchanged regions). */
  oldText: string | null;
  newText: string | null;
  adds: number;
  dels: number;
  /** Bumped per open so re-opening the same path remounts the view. */
  nonce: number;
};

export type DiffMode = "unified" | "split";

export type DiffStore = {
  entry: DiffEntry | null;
  mode: DiffMode;
  setMode: (mode: DiffMode) => void;
  /** Back to the file-edit list. */
  clear: () => void;
};

export const useDiff = create<DiffStore>((set) => ({
  entry: null,
  mode: "unified",
  setMode: (mode) => set({ mode }),
  clear: () => set({ entry: null }),
}));

// ---- lang mapping (lowlight ids used by @git-diff-view's highlighter) --------

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
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
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  lua: "lua",
  dockerfile: "dockerfile",
};

export function diffLangForPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  const ext = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : name.toLowerCase();
  return EXT_LANG[ext] ?? "plaintext";
}

// ---- pane reveal --------------------------------------------------------------

let paneHost: HTMLElement | null = null;

/** DiffPane binds its root element so openDiff can tell "already visible". */
export function bindDiffPaneHost(el: HTMLElement | null): void {
  paneHost = el;
}

function revealPane(): void {
  // ponytail: `view.diff` is the shell's toggle command (absent → open+focus,
  // hidden tab → focus, visible+active → close). Skipping the run while the
  // pane is measurably visible is what keeps toggle semantics from closing it.
  const visible = paneHost !== null && paneHost.offsetWidth > 0;
  if (!visible) runCommand("view.diff");
}

// ---- open APIs ------------------------------------------------------------------

let nonce = 0;

function setEntry(entry: Omit<DiffEntry, "nonce">): void {
  useDiff.setState({ entry: { ...entry, nonce: ++nonce } });
  revealPane();
}

/** Open a diff from full old/new text (hunks are computed here). */
export function openDiff(input: OpenDiffInput): void {
  const { hunks, adds, dels } = buildUnifiedHunks(input.oldText, input.newText);
  setEntry({
    path: input.path,
    lang: input.lang ?? diffLangForPath(input.path),
    hunks: composeGitDiff(input.path, hunks),
    oldText: input.oldText,
    newText: input.newText,
    adds,
    dels,
  });
}

/** Open a parsed file edit (text pair or pass-through patch hunks). */
export function openEditDiff(edit: ParsedEdit): void {
  if (edit.kind === "text") {
    openDiff({ path: edit.path, oldText: edit.oldText, newText: edit.newText });
    return;
  }
  const { adds, dels } = hunkStats(edit.hunks);
  setEntry({
    path: edit.path,
    lang: diffLangForPath(edit.path),
    hunks: composeGitDiff(edit.path, edit.hunks),
    oldText: null,
    newText: null,
    adds,
    dels,
  });
}

/** Open the diff for one tool call block; false when it isn't a file edit. */
export function openDiffForTool(block: ToolBlock): boolean {
  const edit = parseEditArgs(block.name, block.args);
  if (!edit) return false;
  openEditDiff(edit);
  return true;
}

/** File edits of the active session, newest first (diff pane list + command). */
export function activeSessionEdits(): FileEditItem[] {
  const sessionId = useSessions.getState().activeSessionId;
  if (!sessionId) return [];
  const transcript = useTranscripts.getState().bySession[sessionId];
  if (!transcript) return [];
  return listFileEdits(transcript.blocks);
}

// Module-init command registration (commands are the payload-free cross-feature
// entry; payload-carrying callers import openDiff from this store module).
registerCommands([
  {
    id: "diff.open",
    title: "View Last File Edit Diff",
    group: "Diff",
    keywords: ["diff", "edit", "change", "patch"],
    when: () => activeSessionEdits().length > 0,
    run: () => {
      const latest = activeSessionEdits()[0];
      if (latest) openEditDiff(latest.edit);
    },
  },
]);
