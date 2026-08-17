import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import { InMemoryEventStore } from "../src/memory-store.ts";
import { materializeRuntimeContent } from "../src/runtime/media.ts";

function png(width = 2, height = 3): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("runtime media materialization", () => {
  test("stores typed and data-url images as durable BlobRefs", async () => {
    const stored: Array<{ bytes: Uint8Array; mimeType: string }> = [];
    const bytes = png();
    const encoded = Buffer.from(bytes).toString("base64");
    const result = await materializeRuntimeContent(
      [
        { type: "text", text: "screens" },
        { type: "image", data: encoded, mimeType: "image/png" },
        {
          type: "image",
          data: `data:image/png;base64,${encoded}`,
          mimeType: "application/octet-stream",
        },
      ],
      async (value, mimeType) => {
        stored.push({ bytes: value, mimeType });
        return {
          blob: `sha256:${"a".repeat(64)}`,
          sizeBytes: value.byteLength,
          mimeType,
        };
      },
    );

    expect(stored).toHaveLength(2);
    expect(stored[0]?.mimeType).toBe("image/png");
    expect(result).toEqual([
      { type: "text", text: "screens" },
      {
        type: "image",
        ref: {
          blob: `sha256:${"a".repeat(64)}`,
          sizeBytes: 24,
          mimeType: "image/png",
        },
      },
      {
        type: "image",
        ref: {
          blob: `sha256:${"a".repeat(64)}`,
          sizeBytes: 24,
          mimeType: "image/png",
        },
      },
    ]);
  });

  test("turns invalid media into terminal-safe text placeholders", async () => {
    const unsafeSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ).toString("base64");
    const result = await materializeRuntimeContent(
      [
        { type: "image", data: "%%%", mimeType: "image/png" },
        { type: "image", data: unsafeSvg, mimeType: "image/svg+xml" },
        {
          type: "image",
          data: Buffer.from(png()).toString("base64"),
          mimeType: "image/jpeg",
        },
      ],
      async () => {
        throw new Error("must not store rejected media");
      },
    );

    expect(result).toEqual([
      { type: "text", text: "[Image omitted: invalid base64]" },
      { type: "text", text: "[Image omitted: unsafe SVG content]" },
      {
        type: "text",
        text: "[Image omitted: MIME mismatch (image/jpeg is image/png)]",
      },
    ]);
  });

  test("accepts safe SVG as a private blob without inline DOM rendering", async () => {
    const store = new InMemoryEventStore();
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>',
    );
    const result = await materializeRuntimeContent(
      [
        {
          type: "image",
          data: Buffer.from(svg).toString("base64"),
          mimeType: "image/svg+xml",
        },
      ],
      (bytes, mimeType) => store.putBlob(bytes, mimeType),
    );
    const block = result[0];
    expect(block?.type).toBe("image");
    if (block?.type !== "image") return;
    await expect(store.readBlob(block.ref.blob)).resolves.toEqual({
      bytes: svg,
      mimeType: "image/svg+xml",
    });
  });
});
