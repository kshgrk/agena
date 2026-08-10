import assert from "node:assert/strict";
import { test } from "node:test";
import { eventClock, indexOfSeq, payloadJson } from "./inspector-logic.ts";

test("indexOfSeq finds exact seq or -1", () => {
  const rows = [{ seq: 1 }, { seq: 3 }, { seq: 7 }, { seq: 20 }];
  assert.equal(indexOfSeq(rows, 1), 0);
  assert.equal(indexOfSeq(rows, 7), 2);
  assert.equal(indexOfSeq(rows, 20), 3);
  assert.equal(indexOfSeq(rows, 2), -1);
  assert.equal(indexOfSeq(rows, 99), -1);
  assert.equal(indexOfSeq([], 1), -1);
});

test("payloadJson handles undefined and objects", () => {
  assert.equal(payloadJson({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(payloadJson(undefined), "undefined");
  assert.equal(payloadJson(null), "null");
});

test("eventClock tolerates garbage timestamps", () => {
  assert.equal(eventClock("not a date"), "");
  assert.notEqual(eventClock("2026-07-11T10:20:30Z"), "");
});
