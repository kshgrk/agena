import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeMedia, legacyMedia, mediaFromContent } from "./media.ts";

test("recovers bounded legacy MCP image envelopes", () => {
  const text = JSON.stringify({
    content: [
      { type: "text", text: "screens" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/jpeg" },
      { type: "image", data: "c2NyZWVu", mimeType: "image/png" },
    ],
    details: { ignored: true },
  });
  const items = legacyMedia(text);
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => item.kind === "inline" && item.mimeType),
    ["image/jpeg", "image/png"],
  );
  assert.deepEqual(
    legacyMedia('{"nested":{"content":[{"type":"image"}]}}'),
    [],
  );
  assert.deepEqual(legacyMedia("not json"), []);
});

test("recognizes explicit data URLs and deduplicates durable blobs", () => {
  assert.equal(
    legacyMedia("data:image/png;base64,aW1hZ2U=")[0]?.kind,
    "inline",
  );
  const block = {
    type: "image" as const,
    ref: {
      blob: `sha256:${"a".repeat(64)}`,
      sizeBytes: 5,
      mimeType: "image/png",
    },
  };
  const items = mediaFromContent([block, block]);
  assert.equal(items.length, 1);
  assert.equal(dedupeMedia([...items, ...items]).length, 1);
});
