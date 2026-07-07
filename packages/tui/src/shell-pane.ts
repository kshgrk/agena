import {
  type Component,
  CURSOR_MARKER,
  type Focusable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const style = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const dim = style("2");
const bold = style("1");
const green = style("32");
const yellow = style("33");
const red = style("31");

// OSC (title etc.) must match BEFORE the generic Fe class, and that class must
// exclude "[" and "]" — otherwise "ESC ]" matches alone and the OSC *payload*
// (e.g. bash's "0;user@host: /dir" window title) leaks into the transcript.
const ansiPattern =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal parser strips PTY escape/control bytes.
  /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\^_])/g;

// Anchored single-escape matcher for the split-frame carry check below.
const completeEscape =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal parser strips PTY escape/control bytes.
  /^\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\^_])/;

export type ShellPaneState =
  | "closed"
  | "opening"
  | "attached"
  | "reconnecting"
  | "ended";

export type ShellKeyAction =
  | "toggle-shell"
  | "focus-chat"
  | "focus-shell"
  | "grow"
  | "shrink"
  | "quit-key"
  | "shell-input"
  | "pass";

/**
 * §11.3 keymap, focus-aware. pi-tui runs global input listeners BEFORE the
 * focused component, so this must never steal keys the focused side owns:
 * - Ctrl+T toggles terminal visibility.
 * - Ctrl+J toggles focus between chat and a visible shell.
 * - Ctrl+Shift+Up/Down resizes a visible shell.
 * - shell focused: everything else, Ctrl+C included, is consumed and forwarded
 *   to the PTY.
 * matchesKey covers both legacy bytes and kitty CSI-u encodings.
 */
export function routeKey(
  data: string,
  ctx: { shellFocused: boolean; shellVisible: boolean; editorEmpty: boolean },
): ShellKeyAction {
  if (matchesKey(data, "ctrl+t")) return "toggle-shell";
  if (ctx.shellFocused) {
    if (matchesKey(data, "ctrl+j")) return "focus-chat";
    if (isGrowKey(data)) return "grow";
    if (isShrinkKey(data)) return "shrink";
    return "shell-input";
  }
  if (matchesKey(data, "ctrl+j") && ctx.shellVisible) return "focus-shell";
  if (matchesKey(data, "ctrl+c")) return "quit-key";
  if (ctx.shellVisible) {
    if (isGrowKey(data)) return "grow";
    if (isShrinkKey(data)) return "shrink";
  }
  return "pass";
}

export class ShellPane implements Component, Focusable {
  focused = false;

  private height = 0;
  private state: ShellPaneState = "closed";
  private lines: string[] = [""];
  private overwriteLine = false;
  private carry = ""; // incomplete trailing escape held until its terminator arrives
  private readonly maxLines = 2_000;
  private readonly onInput: (data: string) => void;

  constructor(onInput: (data: string) => void) {
    this.onInput = onInput;
  }

  /** ended/closed panes render nothing — the split's rows return to the chat. */
  get visible(): boolean {
    return (
      this.height > 0 &&
      (this.state === "opening" ||
        this.state === "attached" ||
        this.state === "reconnecting")
    );
  }

  get rows(): number {
    return this.height;
  }

  get ptyRows(): number {
    return Math.max(1, this.height - 1);
  }

  setHeight(height: number): void {
    this.height = Math.max(0, height);
  }

  setState(state: ShellPaneState): void {
    this.state = state;
  }

  clear(): void {
    this.lines = [""];
    this.overwriteLine = false;
    this.carry = "";
  }

  write(data: string): void {
    // ponytail: line-oriented transcript, not VT100 — \r overwrites the current
    // line (progress bars), backspace erases, other ANSI is stripped. The
    // xterm-headless pane replaces this wholesale when the emulator scope is
    // pulled forward (§18 future/optional #4).
    // Escape sequences can be split across WS frames: hold an incomplete
    // trailing escape until its terminator arrives (capped — a malformed
    // never-terminated sequence must not swallow output forever).
    const chunk = this.carry + data;
    const cut = incompleteEscapeStart(chunk);
    const usable = cut === -1 ? chunk : chunk.slice(0, cut);
    this.carry =
      cut === -1 || chunk.length - cut > 4096 ? "" : chunk.slice(cut);
    for (const part of normalizePtyText(usable)) {
      if (part === "\n") {
        this.lines.push("");
        this.overwriteLine = false;
        continue;
      }
      if (part === "\r") {
        this.overwriteLine = true; // takes effect only if text follows before \n
        continue;
      }
      const last = this.lines.length - 1;
      if (part === "\b") {
        this.lines[last] = dropLastGrapheme(this.lines[last] ?? "");
        this.overwriteLine = false;
        continue;
      }
      this.lines[last] = this.overwriteLine
        ? part
        : `${this.lines[last] ?? ""}${part}`;
      this.overwriteLine = false;
    }
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(-this.maxLines);
    }
  }

  handleInput(data: string): void {
    if (this.state === "attached") this.onInput(data);
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.visible) return [];
    const safeWidth = Math.max(3, width);
    const bodyHeight = Math.max(0, this.height - 1);
    const header = truncateToWidth(this.header(), safeWidth, "", true);
    const shown = this.lines.slice(-bodyHeight);
    const body = shown.map((line) => {
      const visibleLine = frameLine(line, safeWidth);
      return this.focused ? visibleLine : dim(visibleLine);
    });
    if (this.focused && body.length > 0) {
      body[body.length - 1] = withCursor(
        shown[shown.length - 1] ?? "",
        safeWidth,
      );
    }
    // Pad BELOW: a fresh shell starts at the top of the pane, like a terminal.
    while (body.length < bodyHeight) {
      const empty = frameLine("", safeWidth);
      body.push(this.focused ? empty : dim(empty));
    }
    return [header, ...body];
  }

  private header(): string {
    const dot =
      this.state === "attached"
        ? green("●")
        : this.state === "opening" || this.state === "reconnecting"
          ? yellow("◐")
          : red("○");
    const focus = this.focused ? bold("terminal") : "terminal";
    const hint = this.focused
      ? "Ctrl+J chat · Ctrl+T hide · Ctrl+Shift+↑/↓ resize"
      : "Ctrl+J focus · Ctrl+T hide · Ctrl+Shift+↑/↓ resize";
    return `${dot} ${focus} · ${this.state} · ${dim(hint)}`;
  }
}

export class FixedHeightPane implements Component {
  private readonly child: Component;
  private readonly getHeight: () => number;
  private readonly align: "start" | "end";
  private scrollOffset = 0;

  constructor(
    child: Component,
    getHeight: () => number,
    align: "start" | "end" = "end",
  ) {
    this.child = child;
    this.getHeight = getHeight;
    this.align = align;
  }

  scroll(delta: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + delta);
    this.invalidate();
  }

  scrollToTop(): void {
    this.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.invalidate();
  }

  scrollToBottom(): void {
    this.scrollOffset = 0;
    this.invalidate();
  }

  render(width: number): string[] {
    const height = Math.max(0, this.getHeight());
    if (height === 0) return [];
    const rendered = this.child.render(width);
    const maxOffset = Math.max(0, rendered.length - height);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const end = Math.max(0, rendered.length - this.scrollOffset);
    const lines =
      this.align === "end"
        ? rendered.slice(Math.max(0, end - height), end)
        : rendered.slice(this.scrollOffset, this.scrollOffset + height);
    while (lines.length < height) {
      if (this.align === "end") lines.unshift("");
      else lines.push("");
    }
    return lines.map((line) => truncateToWidth(line, width, "", true));
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

export class ShellDivider implements Component {
  private readonly visible: () => boolean;
  private readonly focused: () => boolean;

  constructor(visible: () => boolean, focused: () => boolean) {
    this.visible = visible;
    this.focused = focused;
  }

  render(width: number): string[] {
    if (!this.visible()) return [];
    const label = this.focused() ? " terminal focus " : " chat focus ";
    const line = `${"─".repeat(Math.max(1, Math.floor((width - label.length) / 2)))}${label}${"─".repeat(width)}`;
    return [dim(truncateToWidth(line, width, "", true))];
  }

  invalidate(): void {}
}

/** Cursor sits right after the text; padding (for stale-cell cleanup) follows it. */
function withCursor(line: string, width: number): string {
  const innerWidth = Math.max(1, width - 2);
  const trimmed = truncateToWidth(line, innerWidth, "", false);
  const pad = Math.max(0, innerWidth - visibleWidth(trimmed));
  return `│${trimmed}${CURSOR_MARKER}${" ".repeat(pad)}│`;
}

function frameLine(line: string, width: number): string {
  const innerWidth = Math.max(1, width - 2);
  const trimmed = truncateToWidth(line, innerWidth, "", false);
  const pad = Math.max(0, innerWidth - visibleWidth(trimmed));
  return `│${trimmed}${" ".repeat(pad)}│`;
}

function dropLastGrapheme(s: string): string {
  return [...s].slice(0, -1).join("");
}

/** Index of an incomplete trailing escape sequence in s, or -1 if none. */
function incompleteEscapeStart(s: string): number {
  const i = s.lastIndexOf("\x1b");
  if (i === -1) return -1;
  return completeEscape.test(s.slice(i)) ? -1 : i;
}

export function normalizePtyText(data: string): string[] {
  const cleaned = data.replace(ansiPattern, "");
  const out: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      out.push(current);
      current = "";
    }
  };
  for (const char of cleaned) {
    if (char === "\n" || char === "\r") {
      flush();
      out.push(char);
      continue;
    }
    if (char === "\b" || char === "\u007f") {
      flush();
      out.push("\b");
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 32 && char !== "\t") continue;
    current = `${current}${char}`;
  }
  flush();
  return out;
}

function isGrowKey(data: string): boolean {
  return matchesKey(data, "ctrl+shift+up") || data === "\x1b[1;6A";
}

function isShrinkKey(data: string): boolean {
  return matchesKey(data, "ctrl+shift+down") || data === "\x1b[1;6B";
}
