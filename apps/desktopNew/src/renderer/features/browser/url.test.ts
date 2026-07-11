import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBrowserUrl } from "./url.ts";

test("normalizeBrowserUrl accepts web URLs and rejects unsafe schemes", () => {
  assert.equal(normalizeBrowserUrl("localhost:8000"), "http://localhost:8000/");
  assert.equal(normalizeBrowserUrl("example.com/x"), "https://example.com/x");
  assert.equal(
    normalizeBrowserUrl("https://example.com/x"),
    "https://example.com/x",
  );
  assert.equal(normalizeBrowserUrl("javascript:alert(1)"), null);
  assert.equal(normalizeBrowserUrl("file:///etc/passwd"), null);
  assert.equal(normalizeBrowserUrl("not a url"), null);
});
