// Pure row-layout decisions for the virtualized transcript: day separators,
// turn spacing, consecutive same-tool grouping (design.md §7), and the tool
// header's one-line argument summary. Kept DOM-free so it tests under
// `node --experimental-strip-types --test`.
import type { Block, ToolBlock } from "../../store/types.ts";

export type RowGap =
  /** First row of the list. */
  | "first"
  /** New turn (20px, design.md §6). */
  | "turn"
  /** Block within a turn (12px). */
  | "block"
  /** Flush against the previous row (grouped tool cards). */
  | "flush";

export type RowMeta = {
  /** Non-null when this row starts a new calendar day: render a date chip. */
  dayLabel: string | null;
  gap: RowGap;
  /** Consecutive same-tool success cards share one visual card (design.md §7). */
  groupWithPrev: boolean;
  groupWithNext: boolean;
};

function sameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** "Mon, Jul 7" (year appended when not the current year). Bad dates → "". */
export function formatDayLabel(at: string, now: Date = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

function groupable(a: Block | undefined, b: Block | undefined): boolean {
  return (
    a?.kind === "tool" &&
    b?.kind === "tool" &&
    a.status === "completed" &&
    b.status === "completed" &&
    a.name === b.name
  );
}

export function rowMeta(blocks: readonly Block[], index: number): RowMeta {
  const block = blocks[index];
  const prev = blocks[index - 1];
  if (!block) {
    return {
      dayLabel: null,
      gap: "block",
      groupWithPrev: false,
      groupWithNext: false,
    };
  }
  const groupWithPrev = groupable(prev, block);
  const groupWithNext = groupable(block, blocks[index + 1]);
  const dayLabel =
    prev && !sameDay(prev.at, block.at) ? formatDayLabel(block.at) : null;
  const gap: RowGap = !prev
    ? "first"
    : groupWithPrev && !dayLabel
      ? "flush"
      : block.kind === "user"
        ? "turn"
        : "block";
  return {
    dayLabel,
    gap,
    // a day chip between two grouped cards un-groups them visually
    groupWithPrev: groupWithPrev && !dayLabel,
    groupWithNext:
      groupWithNext && sameDay(block.at, blocks[index + 1]?.at ?? block.at),
  };
}

/** "verylongmiddle…truncated" — keeps both ends (paths/commands stay legible). */
export function middleTruncate(text: string, max = 72): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/**
 * One-line summary of a tool call's primary argument: the command for bash,
 * the path for file tools, the pattern for search — else compact JSON.
 */
export function argSummary(args: unknown, max = 72): string {
  if (typeof args === "string") return middleTruncate(args, max);
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    for (const k of [
      "command",
      "cmd",
      "path",
      "file_path",
      "filePath",
      "pattern",
      "query",
      "url",
    ]) {
      if (typeof a[k] === "string" && a[k] !== "") {
        return middleTruncate(a[k], max);
      }
    }
  }
  let json = "";
  try {
    json = JSON.stringify(args) ?? "";
  } catch {
    json = String(args);
  }
  return middleTruncate(json, max);
}

/** The design.md §7 visual state union for a tool card. */
export type ToolVisualState =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "aborted"
  | "denied";

export function toolVisualState(
  status: ToolBlock["status"],
  hasPendingApproval: boolean,
): ToolVisualState {
  switch (status) {
    case "running":
      return hasPendingApproval ? "pending" : "running";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "aborted":
      return "aborted";
    case "denied":
      return "denied";
  }
}

/** Compact, truthful output size for a settled tool header. */
export function outputLineLabel(text: string): string {
  if (text === "") return "";
  const lines = text.replace(/\r?\n$/, "").split("\n").length;
  return `${lines} line${lines === 1 ? "" : "s"}`;
}
