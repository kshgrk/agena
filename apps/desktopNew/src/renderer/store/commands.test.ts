// node --experimental-strip-types --test
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  allCommands,
  type Command,
  commandForShortcut,
  registerCommands,
  runCommand,
  shortcutMatches,
  useCommands,
} from "./commands.ts";

// Node has no KeyboardEvent; shortcutMatches only reads these fields.
function key(
  k: string,
  mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {},
): KeyboardEvent {
  return {
    key: k,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  } as KeyboardEvent;
}

const cmd = (id: string, over: Partial<Command> = {}): Command => ({
  id,
  title: id,
  group: "Test",
  run: () => {},
  ...over,
});

describe("command registry", () => {
  beforeEach(() => {
    useCommands.setState({ byId: {} });
  });

  it("registers, runs, and respects `when`", () => {
    const ran: string[] = [];
    registerCommands([
      cmd("a", { run: () => void ran.push("a") }),
      cmd("b", { when: () => false, run: () => void ran.push("b") }),
    ]);
    runCommand("a");
    runCommand("b"); // disabled
    runCommand("ghost"); // unknown: no throw
    assert.deepEqual(ran, ["a"]);
  });

  it("shadows duplicate ids and restores the shadowed def on unregister", () => {
    const ran: string[] = [];
    registerCommands([cmd("x", { run: () => void ran.push("first") })]);
    const off = registerCommands([cmd("x", { run: () => void ran.push("second") })]);
    runCommand("x");
    off();
    runCommand("x");
    assert.deepEqual(ran, ["second", "first"]);
    // unregistering a non-shadowed def deletes it outright
    const off2 = registerCommands([cmd("y")]);
    off2();
    assert.equal(useCommands.getState().byId.y, undefined);
  });

  it("sorts the palette by group then title", () => {
    registerCommands([
      cmd("2", { group: "B", title: "b" }),
      cmd("1", { group: "A", title: "z" }),
      cmd("3", { group: "B", title: "a" }),
    ]);
    assert.deepEqual(
      allCommands(useCommands.getState().byId).map((c) => c.id),
      ["1", "3", "2"],
    );
  });
});

// Node ≥21 exposes navigator.platform, so the module's IS_MAC matches the
// machine the tests run on. `mod`/`wrongMod` keep the assertions portable.
const IS_MAC =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
const mod = { [IS_MAC ? "meta" : "ctrl"]: true } as const;
const wrongMod = { [IS_MAC ? "ctrl" : "meta"]: true } as const;

describe("shortcutMatches", () => {
  it("matches mod chords and rejects wrong modifiers", () => {
    assert.equal(shortcutMatches("mod+n", key("n", mod)), true);
    assert.equal(shortcutMatches("mod+n", key("n", wrongMod)), false);
    assert.equal(shortcutMatches("mod+n", key("n")), false);
    assert.equal(
      shortcutMatches("mod+shift+f", key("F", { ...mod, shift: true })),
      true,
    );
    // shift must match exactly
    assert.equal(
      shortcutMatches("mod+f", key("f", { ...mod, shift: true })),
      false,
    );
    assert.equal(
      shortcutMatches("mod+alt+arrowdown", key("ArrowDown", { ...mod, alt: true })),
      true,
    );
  });

  it("a shortcut without mod requires meta AND ctrl to be up", () => {
    assert.equal(shortcutMatches("escape", key("Escape")), true);
    assert.equal(shortcutMatches("escape", key("Escape", { ctrl: true })), false);
    assert.equal(shortcutMatches("escape", key("Escape", { meta: true })), false);
  });

  it("commandForShortcut finds the first registered match", () => {
    useCommands.setState({ byId: {} });
    registerCommands([
      cmd("no-chord"),
      cmd("find", { shortcut: "mod+shift+f" }),
    ]);
    const hit = commandForShortcut(key("f", { ...mod, shift: true }));
    assert.equal(hit?.id, "find");
    assert.equal(commandForShortcut(key("q", mod)), null);
  });
});
