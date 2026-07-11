import assert from "node:assert/strict";
import { test } from "node:test";
import { splitMatches } from "./highlight.ts";

test("splitMatches finds every case-insensitive occurrence", () => {
  assert.deepEqual(splitMatches("Foo bar foo", "foo"), [
    { text: "Foo", match: true },
    { text: " bar ", match: false },
    { text: "foo", match: true },
  ]);
});

test("splitMatches with no hit returns one plain part", () => {
  assert.deepEqual(splitMatches("hello", "zzz"), [
    { text: "hello", match: false },
  ]);
});

test("splitMatches handles empty query and empty text", () => {
  assert.deepEqual(splitMatches("hello", ""), [
    { text: "hello", match: false },
  ]);
  assert.deepEqual(splitMatches("", "x"), [{ text: "", match: false }]);
});

test("splitMatches handles adjacent and full-string matches", () => {
  assert.deepEqual(splitMatches("aaaa", "aa"), [
    { text: "aa", match: true },
    { text: "aa", match: true },
  ]);
  assert.deepEqual(splitMatches("abc", "abc"), [{ text: "abc", match: true }]);
});

test("splitMatches never regex-interprets the query", () => {
  assert.deepEqual(splitMatches("a.c abc", "a.c"), [
    { text: "a.c", match: true },
    { text: " abc", match: false },
  ]);
});
