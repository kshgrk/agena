import { describe, expect, it } from "vitest";
import { routeKey } from "../src/shell-pane.ts";

const chat = { shellFocused: false, shellVisible: true, editorEmpty: true };
const chatTyping = {
  shellFocused: false,
  shellVisible: true,
  editorEmpty: false,
};
const chatNoShell = {
  shellFocused: false,
  shellVisible: false,
  editorEmpty: true,
};
const shell = { shellFocused: true, shellVisible: true, editorEmpty: true };

describe("routeKey (§11.3 keymap, focus-aware)", () => {
  it("Ctrl+T toggles terminal visibility from either pane", () => {
    expect(routeKey("\x14", chatNoShell)).toBe("toggle-shell");
    expect(routeKey("\x1b[116;5u", chatNoShell)).toBe("toggle-shell");
    expect(routeKey("\x14", shell)).toBe("toggle-shell");
  });

  it("Ctrl+J focuses and unfocuses only a visible shell", () => {
    expect(routeKey("\n", chat)).toBe("focus-shell");
    expect(routeKey("\n", chatTyping)).toBe("focus-shell");
    expect(routeKey("\n", shell)).toBe("focus-chat");
    expect(routeKey("\n", chatNoShell)).toBe("pass");
  });

  it("chat: Ctrl+C is the quit key; plain Enter passes", () => {
    expect(routeKey("\x03", chat)).toBe("quit-key");
    expect(routeKey("\x03", chatTyping)).toBe("quit-key");
    expect(routeKey("\r", chat)).toBe("pass");
  });

  it("shell: Ctrl+J returns focus to chat in legacy and CSI-u encodings", () => {
    expect(routeKey("\n", shell)).toBe("focus-chat");
    expect(routeKey("\x1b[106;5u", shell)).toBe("focus-chat");
  });

  it("shell: everything else — Ctrl+C included — is routed to the PTY", () => {
    expect(routeKey("\x03", shell)).toBe("shell-input");
    expect(routeKey("q", shell)).toBe("shell-input");
    expect(routeKey("\r", shell)).toBe("shell-input");
  });

  it("resize keys are Ctrl+Shift+Up/Down from either side, only while visible", () => {
    expect(routeKey("\x1b[1;6A", shell)).toBe("grow");
    expect(routeKey("\x1b[1;6B", shell)).toBe("shrink");
    expect(routeKey("\x1b[1;6A", chat)).toBe("grow");
    expect(routeKey("\x1b[1;6A", chatNoShell)).toBe("pass");
    expect(routeKey("\x1b[1;5A", shell)).toBe("shell-input");
    expect(routeKey("\x1b[1;5A", chat)).toBe("pass");
  });
});
