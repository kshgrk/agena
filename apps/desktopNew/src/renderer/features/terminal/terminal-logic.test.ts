// node --experimental-strip-types --test src/renderer/features/terminal/terminal-logic.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildXtermTheme,
  cwdTail,
  exitText,
  lostPtyIds,
  nextActiveId,
  normalizeLabel,
  tabLabel,
  TERM_VAR_MAP,
} from "./terminal-logic.ts";

describe("buildXtermTheme", () => {
  it("maps every --term-* var through the reader", () => {
    const theme = buildXtermTheme((name) => `<${name}>`);
    assert.equal(theme.background, "<--term-bg>");
    assert.equal(theme.selectionBackground, "<--term-selection>");
    assert.equal(theme.brightMagenta, "<--term-ansi-bright-magenta>");
    assert.equal(
      Object.keys(theme).length,
      Object.keys(TERM_VAR_MAP).length,
    );
  });

  it("omits keys whose var resolves empty (xterm falls back to defaults)", () => {
    const theme = buildXtermTheme((name) =>
      name === "--term-bg" ? "" : "#111111",
    );
    assert.ok(!("background" in theme));
    assert.equal(theme.foreground, "#111111");
  });
});

describe("labels", () => {
  it("cwdTail takes the last segment, tolerating trailing slashes", () => {
    assert.equal(cwdTail("/workspace/checkout-service"), "checkout-service");
    assert.equal(cwdTail("/workspace/app/"), "app");
    assert.equal(cwdTail(""), "terminal");
    assert.equal(cwdTail("/"), "terminal");
  });

  it("tabLabel prefers rename, then shell title, then cwd tail", () => {
    assert.equal(
      tabLabel({ label: "build", title: "zsh", cwd: "/workspace/app" }),
      "build",
    );
    assert.equal(
      tabLabel({ label: null, title: "vim notes.md", cwd: "/workspace/app" }),
      "vim notes.md",
    );
    assert.equal(
      tabLabel({ label: null, title: "   ", cwd: "/workspace/app" }),
      "app",
    );
    assert.equal(tabLabel({ label: null, title: null, cwd: "" }), "terminal");
  });

  it("normalizeLabel trims and maps empty to null", () => {
    assert.equal(normalizeLabel("  deploy  "), "deploy");
    assert.equal(normalizeLabel("   "), null);
  });
});

describe("nextActiveId", () => {
  const ids = ["a", "b", "c"];

  it("keeps the active tab when a different one closes", () => {
    assert.equal(nextActiveId(ids, "a", "c"), "a");
  });

  it("activates the same index (next neighbor) when the active tab closes", () => {
    assert.equal(nextActiveId(ids, "b", "b"), "c");
  });

  it("clamps to the last tab when the active last tab closes", () => {
    assert.equal(nextActiveId(ids, "c", "c"), "b");
  });

  it("goes null when the only tab closes", () => {
    assert.equal(nextActiveId(["a"], "a", "a"), null);
  });
});

describe("lostPtyIds", () => {
  const tabs = [
    { id: "p1", exited: null },
    { id: "p2", exited: { code: 0, reason: null } },
    { id: "p3", exited: null },
  ];

  it("flags running tabs the daemon no longer lists", () => {
    assert.deepEqual(lostPtyIds(tabs, ["p1"]), ["p3"]);
  });

  it("never flags already-exited tabs", () => {
    assert.deepEqual(lostPtyIds(tabs, []), ["p1", "p3"]);
  });

  it("flags nothing when every running pty is live", () => {
    assert.deepEqual(lostPtyIds(tabs, ["p1", "p3"]), []);
  });
});

describe("exitText", () => {
  it("formats code and optional reason", () => {
    assert.equal(exitText({ code: 0, reason: null }), "process exited (code 0)");
    assert.equal(
      exitText({ code: null, reason: "close 1006" }),
      "process exited (code ?) — close 1006",
    );
  });
});
