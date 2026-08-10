import type { ChamberAutocomplete } from "./types.ts";

const boundary = (text: string, index: number): boolean =>
  index === 0 || /\s/.test(text[index - 1] ?? "");

/** OpenChamber's mutually-exclusive prompt-language trigger precedence. */
export function resolveComposerAutocomplete(
  value: string,
  cursor: number,
): ChamberAutocomplete | null {
  const before = value.slice(0, cursor);
  if (before.startsWith("/") && !/[\s\n]/.test(before)) {
    return { kind: "command", query: before.slice(1), from: 0, to: cursor };
  }

  for (const [sigil, kind] of [
    ["/", "skill"],
    ["#", "snippet"],
    ["@", "mention"],
  ] as const) {
    const from = before.lastIndexOf(sigil);
    if (from < 0 || !boundary(before, from)) continue;
    const query = before.slice(from + 1);
    if (/\s/.test(query)) continue;
    return { kind, query, from, to: cursor };
  }
  return null;
}

export type ComposerToken = {
  from: number;
  to: number;
  kind: ChamberAutocomplete["kind"];
};

/** Lightweight prompt-language decoration; Agena resolves the actual choices. */
export function composerTokens(value: string): ComposerToken[] {
  const tokens: ComposerToken[] = [];
  for (const match of value.matchAll(/(^|\s)([/#@])([^\s/#@]*)/g)) {
    const prefix = match[1] ?? "";
    const sigil = match[2];
    const from = (match.index ?? 0) + prefix.length;
    const kind =
      sigil === "#"
        ? "snippet"
        : sigil === "@"
          ? "mention"
          : from === 0
            ? "command"
            : "skill";
    tokens.push({
      from,
      to: from + (match[0]?.length ?? 0) - prefix.length,
      kind,
    });
  }
  return tokens;
}
