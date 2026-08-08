import assert from "node:assert/strict";
import { test } from "node:test";
import { clipboardImageFiles } from "./clipboard.ts";

test("clipboardImageFiles prefers image items and falls back to files", () => {
  const image = { name: "shot.png", type: "image/png" } as File;
  const text = { name: "note.txt", type: "text/plain" } as File;
  assert.deepEqual(
    clipboardImageFiles({
      items: [
        { kind: "string", type: "text/plain", getAsFile: () => text },
        { kind: "file", type: "image/png", getAsFile: () => image },
      ] as unknown as DataTransferItemList,
      files: [text] as unknown as FileList,
    }),
    [image],
  );
  assert.deepEqual(
    clipboardImageFiles({
      items: [] as unknown as DataTransferItemList,
      files: [text, image] as unknown as FileList,
    }),
    [image],
  );
});
