import assert from "node:assert/strict";
import test from "node:test";
import { isMobileHost, isSoftwareKeyboardVisible } from "./mobile-logic.ts";

test("mobile host uses a narrow viewport or a native Capacitor shell", () => {
  assert.equal(isMobileHost(390, false), true);
  assert.equal(isMobileHost(1024, false), false);
  assert.equal(isMobileHost(1024, true), true);
});

test("software keyboard requires both a focused text input and a shorter viewport", () => {
  assert.equal(isSoftwareKeyboardVisible(480, 800, true), true);
  assert.equal(isSoftwareKeyboardVisible(480, 800, false), false);
  assert.equal(isSoftwareKeyboardVisible(760, 800, true), false);
});
