import assert from "node:assert/strict";
import { test } from "node:test";
import { type AnsiSpan, parseAnsi, stripAnsi } from "./ansi.ts";

const E = "\u001b";

test("stripAnsi removes CSI, OSC and lone escapes", () => {
  assert.equal(stripAnsi(`${E}[31mred${E}[0m plain`), "red plain");
  assert.equal(stripAnsi(`${E}]0;title\u0007body`), "body");
  assert.equal(stripAnsi(`${E}]0;title${E}\\body`), "body");
  assert.equal(stripAnsi(`${E}[2K${E}[1Gline`), "line");
  assert.equal(stripAnsi("no escapes"), "no escapes");
});

test("parseAnsi: plain text is one unstyled span", () => {
  assert.deepEqual(parseAnsi("hello"), [{ text: "hello" }]);
  assert.deepEqual(parseAnsi(""), []);
});

test("parseAnsi: basic 16-color foregrounds map to term tokens", () => {
  const spans = parseAnsi(`${E}[31mred${E}[0m ok ${E}[92mgreen${E}[39m!`);
  assert.deepEqual(spans, [
    { text: "red", color: "var(--term-ansi-red)" },
    { text: " ok " },
    { text: "green", color: "var(--term-ansi-bright-green)" },
    { text: "!" },
  ] satisfies AnsiSpan[]);
});

test("parseAnsi: bold/dim/italic/underline set and clear", () => {
  const spans = parseAnsi(`${E}[1;4mstrong${E}[22mstill-underlined${E}[24mplain`);
  assert.deepEqual(spans, [
    { text: "strong", bold: true, underline: true },
    { text: "still-underlined", underline: true },
    { text: "plain" },
  ]);
});

test("parseAnsi: 256-color low range maps, high range and truecolor fall back", () => {
  assert.deepEqual(parseAnsi(`${E}[38;5;9mx`), [
    { text: "x", color: "var(--term-ansi-bright-red)" },
  ]);
  assert.deepEqual(parseAnsi(`${E}[38;5;196mx`), [{ text: "x" }]);
  assert.deepEqual(parseAnsi(`${E}[38;2;255;0;0mx`), [{ text: "x" }]);
});

test("parseAnsi: backgrounds and non-SGR sequences are stripped, style survives", () => {
  const spans = parseAnsi(`${E}[41m${E}[32mgreen-on-red${E}[2K tail`);
  assert.deepEqual(spans, [
    { text: "green-on-red", color: "var(--term-ansi-green)" },
    { text: " tail", color: "var(--term-ansi-green)" },
  ]);
});

test("parseAnsi: bare ESC[m resets", () => {
  const spans = parseAnsi(`${E}[36mcyan${E}[mdone`);
  assert.deepEqual(spans, [
    { text: "cyan", color: "var(--term-ansi-cyan)" },
    { text: "done" },
  ]);
});
