import type { ContentBlock, ImageBlock } from "@agena/protocol";

export type MediaItem =
  | { kind: "blob"; key: string; block: ImageBlock }
  | { kind: "remote"; key: string; url: string; alt?: string }
  | {
      kind: "inline";
      key: string;
      data: string;
      mimeType: string;
      alt?: string;
    };

export function mediaFromContent(
  content: readonly ContentBlock[],
): MediaItem[] {
  const direct = content.flatMap((block): MediaItem[] =>
    block.type === "image"
      ? [{ kind: "blob", key: block.ref.blob, block }]
      : [],
  );
  const legacy = content.flatMap((block) =>
    block.type === "text" ? legacyMedia(block.text) : [],
  );
  return dedupeMedia([...direct, ...legacy]);
}

export function dedupeMedia(items: readonly MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const identity =
      item.kind === "blob"
        ? item.block.ref.blob
        : item.kind === "remote"
          ? item.url
          : `${item.mimeType}\0${item.data}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function mediaFromMarkdownImage(src: string, alt: string): MediaItem[] {
  const inline = legacyMedia(src).map((item) => ({ ...item, alt }));
  if (inline.length > 0) return inline;
  try {
    const url = new URL(src);
    return url.protocol === "https:"
      ? [{ kind: "remote", key: `remote:${url.href}`, url: url.href, alt }]
      : [];
  } catch {
    return [];
  }
}

export function legacyMedia(text: string): MediaItem[] {
  if (text.length === 0 || text.length > 16_000_000) return [];
  const trimmed = text.trim();
  if (trimmed.startsWith("data:image/")) {
    const parsed = dataUrl(trimmed);
    return parsed ? [parsed] : [];
  }
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const content = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && "content" in parsed
        ? (parsed as { content?: unknown }).content
        : undefined;
    if (!Array.isArray(content)) return [];
    return content.slice(0, 32).flatMap((value, index): MediaItem[] => {
      if (!value || typeof value !== "object") return [];
      const block = value as Record<string, unknown>;
      if (
        block.type !== "image" ||
        typeof block.data !== "string" ||
        typeof block.mimeType !== "string"
      ) {
        return [];
      }
      return [
        {
          kind: "inline",
          key: inlineKey(block.data, index),
          data: block.data,
          mimeType: block.mimeType,
        },
      ];
    });
  } catch {
    return [];
  }
}

function dataUrl(value: string): MediaItem | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(value);
  if (!match?.[1] || !match[2]) return null;
  return {
    kind: "inline",
    key: inlineKey(match[2], 0),
    data: match[2],
    mimeType: match[1],
  };
}

function inlineKey(data: string, index: number): string {
  let hash = 2166136261;
  for (
    let i = 0;
    i < data.length;
    i += Math.max(1, Math.floor(data.length / 512))
  ) {
    hash = Math.imul(hash ^ (data.charCodeAt(i) || 0), 16777619);
  }
  return `inline:${data.length}:${(hash >>> 0).toString(16)}:${index}`;
}
