import assert from "node:assert/strict";
import test from "node:test";
import { shouldSubmitComposerKey } from "./keyboard.ts";

const enter = {
  key: "Enter",
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  keyCode: 13,
};

test("desktop Enter sends while mobile and IME Enter remain editing keys", () => {
  assert.equal(shouldSubmitComposerKey(enter, false), true);
  assert.equal(shouldSubmitComposerKey(enter, true), false);
  assert.equal(
    shouldSubmitComposerKey({ ...enter, metaKey: true }, true),
    true,
  );
  assert.equal(
    shouldSubmitComposerKey({ ...enter, isComposing: true }, false),
    false,
  );
  assert.equal(
    shouldSubmitComposerKey({ ...enter, shiftKey: true }, false),
    false,
  );
});
