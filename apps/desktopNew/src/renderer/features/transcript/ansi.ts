// ANSI handling for tool output. Ported from apps/desktop transcript/ansi.ts
// (stripAnsi) and extended into a tiny SGR tokenizer so Bash output renders
// with its colors, mapped onto the theme's --term-ansi-* tokens (design.md:
// components never hard-code colors; the terminal palette is the one sanctioned
// ANSI color source). Written with \u escapes so no control chars live in
// source. Pure module — tested via ansi.test.ts.

const ESC = "\\u001b";

/** OSC strings: body may not contain BEL or ESC, so BEL / ESC-backslash (ST) terminate. */
const OSC = `${ESC}\\][^\\u0007\\u001b]*(?:\\u0007|${ESC}\\\\)?`;

/** CSI sequences (ESC[ ... cmd), OSC strings (ESC] ... BEL/ST), lone two-char escapes. */
const ANSI_RE = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${OSC}|${ESC}[@-_]`,
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export type AnsiSpan = {
  text: string;
  /** CSS color value (always a var(--term-ansi-*) token), absent = inherit. */
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
};

const BASE_COLORS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

function colorVar(index: number): string | undefined {
  if (index >= 0 && index <= 7) return `var(--term-ansi-${BASE_COLORS[index]})`;
  if (index >= 8 && index <= 15) {
    return `var(--term-ansi-bright-${BASE_COLORS[index - 8]})`;
  }
  // ponytail: 256-color cube / truecolor fall back to the default foreground —
  // mapping them to the 16 theme tokens is the upgrade path if it ever matters.
  return undefined;
}

type Style = Omit<AnsiSpan, "text">;

/** Apply one SGR parameter list (the Ps of ESC[Ps m) to a style, mutating it. */
function applySgr(style: Style, params: string): void {
  const parts = params === "" ? [0] : params.split(";").map((p) => Number(p));
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? 0;
    if (Number.isNaN(p)) continue;
    if (p === 0) {
      delete style.color;
      delete style.bold;
      delete style.dim;
      delete style.italic;
      delete style.underline;
    } else if (p === 1) style.bold = true;
    else if (p === 2) style.dim = true;
    else if (p === 3) style.italic = true;
    else if (p === 4) style.underline = true;
    else if (p === 22) {
      delete style.bold;
      delete style.dim;
    } else if (p === 23) delete style.italic;
    else if (p === 24) delete style.underline;
    else if (p >= 30 && p <= 37) {
      const c = colorVar(p - 30);
      if (c) style.color = c;
    } else if (p === 39) delete style.color;
    else if (p >= 90 && p <= 97) {
      const c = colorVar(p - 90 + 8);
      if (c) style.color = c;
    } else if (p === 38 || p === 48) {
      // extended color: 38;5;n or 38;2;r;g;b — consume the arguments
      const mode = parts[i + 1];
      if (mode === 5) {
        if (p === 38) {
          const c = colorVar(parts[i + 2] ?? -1);
          if (c) style.color = c;
          else delete style.color;
        }
        i += 2;
      } else if (mode === 2) {
        if (p === 38) delete style.color; // truecolor → default (see ponytail above)
        i += 4;
      }
    }
    // backgrounds (40-47, 100-107) and everything else: ignored on purpose —
    // tool output sits on bg-inset; painting backgrounds inside it reads as noise.
  }
}

/**
 * Parse text with ANSI SGR codes into styled spans. Non-SGR escape sequences
 * (cursor movement, OSC titles, …) are stripped. Never throws on bad input.
 */
export function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const style: Style = {};
  let last = 0;
  const sgrRe = new RegExp(
    `${ESC}\\[([0-9;]*)m|${ESC}\\[[0-9;?]*[ -/]*[@-~]|${OSC}|${ESC}[@-_]`,
    "g",
  );
  for (const m of text.matchAll(sgrRe)) {
    const chunk = text.slice(last, m.index);
    if (chunk) spans.push({ text: chunk, ...style });
    last = m.index + m[0].length;
    if (m[1] !== undefined) applySgr(style, m[1]);
  }
  const rest = text.slice(last);
  if (rest) spans.push({ text: rest, ...style });
  return spans;
}
