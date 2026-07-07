// Tiny ANSI stripper for tool output (plan §7.3: output rendered ANSI-stripped).
// Covers CSI sequences (ESC[ ... cmd), OSC strings (ESC] ... BEL/ST), and lone
// two-char escapes. Written with \u escapes so no control chars live in source.
const ESC = "\\u001b";
const ANSI_RE = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)?|${ESC}[@-_]`,
  "g",
);

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}
