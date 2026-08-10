// Pure snippet-match splitting (Node-safe; the React <mark> rendering lives in
// pane.tsx). Case-insensitive, every occurrence, no regex escaping pitfalls —
// plain indexOf like the battle-tested old app.

export type SnippetPart = { text: string; match: boolean };

/** Split `text` into alternating plain/match parts for `query` (case-insensitive). */
export function splitMatches(text: string, query: string): SnippetPart[] {
  const q = query.toLowerCase();
  if (q.length === 0 || text.length === 0) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const out: SnippetPart[] = [];
  let i = 0;
  for (;;) {
    const at = lower.indexOf(q, i);
    if (at < 0) {
      if (i < text.length) out.push({ text: text.slice(i), match: false });
      return out.length > 0 ? out : [{ text, match: false }];
    }
    if (at > i) out.push({ text: text.slice(i, at), match: false });
    out.push({ text: text.slice(at, at + q.length), match: true });
    i = at + q.length;
  }
}
