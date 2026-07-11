import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderEnv } from "./providers-lib.ts";

test("provider settings parse NAME=value lines without exposing magic fields", () => {
  assert.deepEqual(parseProviderEnv("ACCOUNT=a\nREGION=us=west\n\n"), {
    ACCOUNT: "a",
    REGION: "us=west",
  });
  assert.equal(parseProviderEnv(""), undefined);
  assert.throws(() => parseProviderEnv("missing-separator"), /NAME=value/);
});
