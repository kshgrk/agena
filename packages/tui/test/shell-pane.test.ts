import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  FixedHeightPane,
  normalizePtyText,
  ShellDivider,
  ShellPane,
} from "../src/shell-pane.ts";

describe("ShellPane", () => {
  it("normalizes common PTY output for embedded rendering", () => {
    expect(normalizePtyText("\x1b[32mhelol\b\x1b[0m\nnext\r\n")).toEqual([
      "helol",
      "\b",
      "\n",
      "next",
      "\r",
      "\n",
    ]);
  });

  it("strips OSC window-title sequences without leaking their payload", () => {
    expect(
      normalizePtyText(
        "\x1b]0;node@host: /workspace\x07node@host:/workspace$ ",
      ),
    ).toEqual(["node@host:/workspace$ "]);
    // ST-terminated variant
    expect(normalizePtyText("\x1b]2;title\x1b\\after")).toEqual(["after"]);
  });

  it("holds escapes split across frames until the terminator arrives", () => {
    const pane = new ShellPane(() => {});
    pane.setHeight(4);
    pane.setState("attached");
    pane.write("\x1b]0;node@host: /works");
    pane.write("pace\x07hello");
    pane.write("\x1b[3");
    pane.write("2mgreen\x1b[0m!");
    expect(pane.render(40).join("\n")).toContain("hellogreen!");
    expect(pane.render(40).join("\n")).not.toContain("0;node");
  });

  it("top-aligns fresh output instead of sinking it to the pane bottom", () => {
    const pane = new ShellPane(() => {});
    pane.setHeight(6);
    pane.setState("attached");
    pane.write("$ ");
    const rendered = pane.render(40);
    expect(rendered[1]).toContain("$ "); // first body row, right under the header
    expect(rendered[5]).not.toContain("$ ");
  });

  it("renders a fixed bottom pane with recent output", () => {
    const sent: string[] = [];
    const pane = new ShellPane((data) => sent.push(data));
    pane.setHeight(4);
    pane.setState("attached");
    pane.write("one\ntwo\nthree\n");
    pane.handleInput("pwd\r");

    const rendered = pane.render(80);
    expect(rendered).toHaveLength(4);
    expect(rendered.join("\n")).toContain("terminal");
    expect(rendered.join("\n")).toContain("two");
    expect(rendered.join("\n")).toContain("three");
    expect(sent).toEqual(["pwd\r"]);
  });

  it("applies backspace echo to the rendered terminal line", () => {
    const pane = new ShellPane(() => {});
    pane.setHeight(4);
    pane.setState("attached");
    pane.write("helo");
    pane.write("l");
    pane.write("\b \b");
    pane.write("p\n");

    const rendered = pane.render(40).join("\n");
    expect(rendered).toContain("helop");
    expect(rendered).not.toContain("helolp");
  });

  it("overwrites the current line on carriage return (progress bars)", () => {
    const pane = new ShellPane(() => {});
    pane.setHeight(4);
    pane.setState("attached");
    pane.write("downloading 10%\r");
    pane.write("downloading 55%\rdownloading 100%\ndone\n");

    const rendered = pane.render(40).join("\n");
    expect(rendered).toContain("downloading 100%");
    expect(rendered).toContain("done");
    expect(rendered).not.toContain("10%");
    expect(rendered).not.toContain("55%");
  });

  it("keeps \\r\\n line endings intact across the overwrite path", () => {
    const pane = new ShellPane(() => {});
    pane.setHeight(4);
    pane.setState("attached");
    pane.write("first\r\nsecond\r\n");

    const rendered = pane.render(40).join("\n");
    expect(rendered).toContain("first");
    expect(rendered).toContain("second");
  });

  it("hides the pane once the shell has ended", () => {
    const pane = new ShellPane(() => {});
    pane.setHeight(4);
    pane.setState("attached");
    expect(pane.visible).toBe(true);
    pane.setState("ended");
    expect(pane.visible).toBe(false);
    expect(pane.render(40)).toEqual([]);
  });

  it("places the cursor right after the last character when focused", () => {
    const pane = new ShellPane(() => {});
    pane.setHeight(3);
    pane.setState("attached");
    pane.focused = true;
    pane.write("$ ls");

    const rendered = pane.render(20);
    // top-aligned: the prompt (and its cursor) is the first body row
    expect(rendered[1]).toContain(`$ ls${CURSOR_MARKER}`);
  });

  it("renders a visible frame around empty terminal rows", () => {
    const pane = new ShellPane(() => {});
    pane.setHeight(4);
    pane.setState("attached");
    pane.focused = true;
    const rendered = pane.render(20);

    expect((rendered[1] ?? "").replace(CURSOR_MARKER, "")).toMatch(/^│ +│$/);
    expect(rendered[3]).toMatch(/^│ +│$/);
  });

  it("bounds chat history in a real split pane", () => {
    const child = {
      render: () => ["one", "two", "three"],
      invalidate: () => {},
    };
    const pane = new FixedHeightPane(child, () => 2);

    expect(pane.render(20)).toEqual([
      "two                 ",
      "three               ",
    ]);
  });

  it("draws a visible shell divider only while the pane is open", () => {
    const hidden = new ShellDivider(
      () => false,
      () => false,
    );
    const visible = new ShellDivider(
      () => true,
      () => true,
    );

    expect(hidden.render(20)).toEqual([]);
    expect(visible.render(20).join("")).toContain("terminal focus");
  });
});
