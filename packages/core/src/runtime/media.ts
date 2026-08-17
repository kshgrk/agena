import { Buffer } from "node:buffer";
import type { BlobRef, ContentBlock } from "@agena/protocol";
import type { RuntimeContentBlock } from "./types.ts";

const MAX_IMAGES = 32;
const MAX_IMAGE_BYTES = 3_000_000;
const MAX_TOTAL_IMAGE_BYTES = 12_000_000;
const MAX_PIXELS = 40_000_000;
const MAX_DIMENSION = 32_768;

type PutBlob = (bytes: Uint8Array, mimeType: string) => Promise<BlobRef>;

export async function materializeRuntimeContent(
  blocks: readonly RuntimeContentBlock[],
  putBlob: PutBlob,
): Promise<ContentBlock[]> {
  const output: ContentBlock[] = [];
  let images = 0;
  let totalBytes = 0;
  for (const block of blocks) {
    if (block.type === "text") {
      output.push(block);
      continue;
    }
    if (images >= MAX_IMAGES) {
      output.push({ type: "text", text: "[Image omitted: too many images]" });
      continue;
    }
    images += 1;
    try {
      const decoded = decodeImage(block.data, block.mimeType);
      totalBytes += decoded.bytes.byteLength;
      if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
        throw new Error("turn media exceeds 12 MB");
      }
      const ref = await putBlob(decoded.bytes, decoded.mimeType);
      output.push({
        type: "image",
        ref,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid image";
      output.push({ type: "text", text: `[Image omitted: ${message}]` });
    }
  }
  return output;
}

function decodeImage(
  value: string,
  claimedMime: string,
): { bytes: Uint8Array; mimeType: string } {
  const dataUrl = /^data:([^;,]+);base64,(.*)$/is.exec(value);
  const encoded = (dataUrl?.[2] ?? value).replaceAll(/\s/g, "");
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new Error("invalid base64");
  }
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  if (
    Buffer.from(bytes).toString("base64").replace(/=+$/, "") !==
    encoded.replace(/=+$/, "")
  ) {
    throw new Error("invalid base64");
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("image exceeds 3 MB");
  }
  const mimeType = sniffImageMime(bytes);
  const declared = (dataUrl?.[1] ?? claimedMime)
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    declared &&
    declared !== "application/octet-stream" &&
    normalizeMime(declared) !== mimeType
  ) {
    throw new Error(`MIME mismatch (${declared} is ${mimeType})`);
  }
  if (mimeType === "image/svg+xml") validateSvg(bytes);
  validateDimensions(bytes, mimeType);
  return { bytes, mimeType };
}

function normalizeMime(mime: string): string {
  if (mime === "image/jpg") return "image/jpeg";
  if (mime === "image/x-ms-bmp") return "image/bmp";
  return mime;
}

function sniffImageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    )
  ) {
    return "image/png";
  }
  const ascii = Buffer.from(bytes.subarray(0, 40)).toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  if (ascii.startsWith("BM")) return "image/bmp";
  if (ascii.slice(4, 12).includes("ftypavif") || ascii.includes("ftypavis")) {
    return "image/avif";
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, Math.min(bytes.length, 4096)))
      .replace(/^\uFEFF/, "")
      .trimStart();
    if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) {
      return "image/svg+xml";
    }
  } catch {
    // Binary, not SVG.
  }
  throw new Error("unsupported image format");
}

function validateSvg(bytes: Uint8Array): void {
  if (bytes.byteLength > 1_000_000) throw new Error("SVG exceeds 1 MB");
  const svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    svg.includes("\0") ||
    /<!DOCTYPE|<!ENTITY/i.test(svg) ||
    /<\s*(?:script|foreignObject|iframe|object|embed|audio|video)\b/i.test(
      svg,
    ) ||
    /\bon[a-z]+\s*=/i.test(svg) ||
    /(?:href|xlink:href)\s*=\s*["'](?!#)/i.test(svg) ||
    /(?:url\s*\(|@import)/i.test(svg)
  ) {
    throw new Error("unsafe SVG content");
  }
}

function validateDimensions(bytes: Uint8Array, mimeType: string): void {
  const dimensions = imageDimensions(bytes, mimeType);
  if (!dimensions) return;
  const [width, height] = dimensions;
  if (
    width <= 0 ||
    height <= 0 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    throw new Error("image dimensions are too large");
  }
}

function imageDimensions(
  bytes: Uint8Array,
  mimeType: string,
): [number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === "image/png" && bytes.length >= 24) {
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (mimeType === "image/gif" && bytes.length >= 10) {
    return [view.getUint16(6, true), view.getUint16(8, true)];
  }
  if (mimeType === "image/bmp" && bytes.length >= 26) {
    return [
      Math.abs(view.getInt32(18, true)),
      Math.abs(view.getInt32(22, true)),
    ];
  }
  if (mimeType === "image/webp" && bytes.length >= 30) {
    const kind = Buffer.from(bytes.subarray(12, 16)).toString("ascii");
    if (kind === "VP8X") {
      return [1 + uint24(bytes, 24), 1 + uint24(bytes, 27)];
    }
    if (kind === "VP8L") {
      return [
        1 + ((bytes[21] ?? 0) | (((bytes[22] ?? 0) & 0x3f) << 8)),
        1 +
          (((bytes[22] ?? 0) >> 6) |
            ((bytes[23] ?? 0) << 2) |
            (((bytes[24] ?? 0) & 0x0f) << 10)),
      ];
    }
    if (
      kind === "VP8 " &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      return [
        view.getUint16(26, true) & 0x3fff,
        view.getUint16(28, true) & 0x3fff,
      ];
    }
  }
  if (mimeType === "image/jpeg") return jpegDimensions(bytes);
  if (mimeType === "image/avif") {
    const marker = Buffer.from(bytes).indexOf(Buffer.from("ispe"));
    if (marker >= 0 && marker + 16 <= bytes.length) {
      return [view.getUint32(marker + 8), view.getUint32(marker + 12)];
    }
  }
  return null;
}

function jpegDimensions(bytes: Uint8Array): [number, number] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    ) {
      return [view.getUint16(offset + 7), view.getUint16(offset + 5)];
    }
    const size = view.getUint16(offset + 2);
    if (size < 2) break;
    offset += size + 2;
  }
  return null;
}

function uint24(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}
