// node --experimental-strip-types --test
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Electron dispatches compact transcript bridge methods", async () => {
  const source = await readFile(
    new URL("../../../electron/bridge.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /case "readCompactTranscript":/);
  assert.match(source, /case "getToolCallDetail":/);
});
