// Pure palette query/ranking logic (Node-safe; cmdk renders, this decides).
// The palette does its own filtering (cmdk shouldFilter={false}) because the
// list mixes three sources — commands, sessions, async bridge.search hits —
// and only the first two should be text-filtered client-side.

export type PaletteMode = "commands" | "mixed";

export type PaletteQuery = {
  /** ">" prefix = commands only (the classic editor convention). */
  mode: PaletteMode;
  /** Query text with the prefix stripped and trimmed. */
  text: string;
};

export function parsePaletteQuery(raw: string): PaletteQuery {
  if (raw.startsWith(">"))
    return { mode: "commands", text: raw.slice(1).trim() };
  return { mode: "mixed", text: raw.trim() };
}

/** Case-insensitive subsequence match ("tgl" hits "Toggle"). */
export function fuzzyMatch(haystack: string, needle: string): boolean {
  if (needle.length === 0) return true;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i += 1;
    if (i === n.length) return true;
  }
  return false;
}

type CommandLike = {
  title: string;
  group: string;
  keywords?: string[];
};

/**
 * Score a command against the query: title substring (3) > keyword/group
 * substring (2) > title subsequence (1) > no match (0).
 */
export function commandScore(cmd: CommandLike, text: string): number {
  if (text.length === 0) return 1;
  const q = text.toLowerCase();
  if (cmd.title.toLowerCase().includes(q)) return 3;
  const words = [cmd.group, ...(cmd.keywords ?? [])];
  if (words.some((w) => w.toLowerCase().includes(q))) return 2;
  if (fuzzyMatch(cmd.title, q)) return 1;
  return 0;
}

/** Filter+rank commands, preserving input order within a score tier. */
export function filterCommands<T extends CommandLike>(
  cmds: readonly T[],
  text: string,
): T[] {
  if (text.length === 0) return [...cmds];
  return cmds
    .map((cmd, i) => ({ cmd, i, score: commandScore(cmd, text) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((e) => e.cmd);
}

type SessionLike = {
  sessionId: string;
  title?: string | undefined;
  updatedAt: string;
  cwd?: string | undefined;
  projectId?: string | undefined;
  status?: string | undefined;
};

/**
 * Session-switcher entries: match on title/id, most recently updated first.
 * Empty text = the plain recents list.
 */
export function rankSessions<T extends SessionLike>(
  sessions: readonly T[],
  text: string,
  limit: number,
): T[] {
  const q = text.toLowerCase();
  return sessions
    .filter(
      (s) =>
        q.length === 0 ||
        (s.title ?? "").toLowerCase().includes(q) ||
        (s.cwd ?? "").toLowerCase().includes(q) ||
        (s.projectId ?? "").toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q) ||
        fuzzyMatch(s.title ?? "", q),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/** Group commands by their `group`, preserving list order. */
export function groupCommands<T extends CommandLike>(
  cmds: readonly T[],
): Array<[string, T[]]> {
  const m = new Map<string, T[]>();
  for (const cmd of cmds) {
    const list = m.get(cmd.group);
    if (list) list.push(cmd);
    else m.set(cmd.group, [cmd]);
  }
  return [...m.entries()];
}
