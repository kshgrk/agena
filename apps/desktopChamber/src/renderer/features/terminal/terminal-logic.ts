// Pure terminal logic — no DOM, no zustand, no xterm runtime (the ITheme
// import is type-only and erased). Tested by terminal-logic.test.ts under
// `node --experimental-strip-types --test`.
import type { ITheme } from "@xterm/xterm";

/** design.md §10: the xterm theme is built from the --term-* tokens. */
export const TERM_VAR_MAP = {
  background: "--term-bg",
  foreground: "--term-fg",
  cursor: "--term-cursor",
  selectionBackground: "--term-selection",
  black: "--term-ansi-black",
  red: "--term-ansi-red",
  green: "--term-ansi-green",
  yellow: "--term-ansi-yellow",
  blue: "--term-ansi-blue",
  magenta: "--term-ansi-magenta",
  cyan: "--term-ansi-cyan",
  white: "--term-ansi-white",
  brightBlack: "--term-ansi-bright-black",
  brightRed: "--term-ansi-bright-red",
  brightGreen: "--term-ansi-bright-green",
  brightYellow: "--term-ansi-bright-yellow",
  brightBlue: "--term-ansi-bright-blue",
  brightMagenta: "--term-ansi-bright-magenta",
  brightCyan: "--term-ansi-bright-cyan",
  brightWhite: "--term-ansi-bright-white",
} as const satisfies Partial<Record<keyof ITheme, string>>;

/** Map the --term-* vars through a reader; empty values are omitted so xterm
 * falls back to its defaults instead of parsing "". */
export function buildXtermTheme(read: (varName: string) => string): ITheme {
  const theme: Record<string, string> = {};
  for (const [key, varName] of Object.entries(TERM_VAR_MAP)) {
    const value = read(varName);
    if (value) theme[key] = value;
  }
  return theme as ITheme;
}

/** Last path segment of a cwd, for the default tab label. */
export function cwdTail(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? "terminal";
}

/** Label precedence: user rename > OSC title from the shell > cwd tail. */
export function tabLabel(t: {
  label: string | null;
  title: string | null;
  cwd: string;
}): string {
  return t.label ?? (t.title?.trim() || null) ?? cwdTail(t.cwd);
}

/** Rename commit: trimmed, empty → null (fall back to derived label). */
export function normalizeLabel(label: string): string | null {
  return label.trim() || null;
}

/**
 * Active tab after closing `closedId`. `ids` is the tab order BEFORE removal;
 * closing the active tab activates the neighbor (same index, clamped).
 */
export function nextActiveId(
  ids: readonly string[],
  activeId: string | null,
  closedId: string,
): string | null {
  if (activeId !== closedId) return activeId;
  const idx = ids.indexOf(closedId);
  const rest = ids.filter((id) => id !== closedId);
  return rest[Math.min(idx, rest.length - 1)] ?? null;
}

/** Tabs still marked running whose PTY the daemon no longer knows (listPtys
 * reconciliation after a reconnect). */
export function lostPtyIds(
  tabs: ReadonlyArray<{ id: string; exited: unknown }>,
  liveIds: Iterable<string>,
): string[] {
  const live = new Set(liveIds);
  return tabs.filter((t) => !t.exited && !live.has(t.id)).map((t) => t.id);
}

/** Exit-strip text: "process exited (code 0) — reason". */
export function exitText(exited: {
  code: number | null;
  reason: string | null;
}): string {
  const base = `process exited (code ${exited.code ?? "?"})`;
  return exited.reason ? `${base} — ${exited.reason}` : base;
}
