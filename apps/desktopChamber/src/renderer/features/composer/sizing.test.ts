import assert from "node:assert/strict";
import test from "node:test";
import { composerHeight } from "./sizing.ts";

test("composer starts compact and grows to the surface-specific line cap", () => {
  assert.equal(
    composerHeight({
      scrollHeight: 10,
      lineHeight: 24,
      viewportHeight: 1_000,
      mobile: false,
    }),
    44,
  );
  assert.equal(
    composerHeight({
      scrollHeight: 900,
      lineHeight: 24,
      viewportHeight: 1_000,
      mobile: false,
    }),
    216,
  );
  assert.equal(
    composerHeight({
      scrollHeight: 900,
      lineHeight: 24,
      viewportHeight: 600,
      mobile: true,
    }),
    240,
  );
});
