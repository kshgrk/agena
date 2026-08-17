import { ChevronLeft, ChevronRight, Download, ImageOff, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { peekBridge } from "../../lib/bridge.ts";
import { useUi } from "../../store/index.ts";
import { cx, Dialog, DialogTitle, IconButton } from "../../ui/index.ts";
import { dedupeMedia, type MediaItem } from "./media.ts";

type LoadedMedia = MediaItem & { url?: string; error?: string };

function decodeInline(item: Extract<MediaItem, { kind: "inline" }>): Blob {
  const clean = item.data.replaceAll(/\s/g, "");
  if (
    clean.length === 0 ||
    clean.length > 4_000_000 ||
    clean.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)
  ) {
    throw new Error("Invalid image data");
  }
  const binary = atob(clean);
  if (binary.length > 3_000_000) throw new Error("Image exceeds 3 MB");
  if (btoa(binary).replace(/=+$/, "") !== clean.replace(/=+$/, "")) {
    throw new Error("Invalid image data");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const mimeType = item.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!legacyMimeMatches(bytes, mimeType))
    throw new Error("Image type mismatch");
  if (mimeType === "image/svg+xml") {
    const svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (
      /<!DOCTYPE|<!ENTITY/i.test(svg) ||
      /<\s*(?:script|foreignObject|iframe|object|embed)\b/i.test(svg) ||
      /\bon[a-z]+\s*=/i.test(svg) ||
      /(?:href|xlink:href)\s*=\s*["'](?!#)/i.test(svg)
    ) {
      throw new Error("Unsafe SVG");
    }
  }
  return new Blob([bytes], { type: mimeType });
}

function legacyMimeMatches(bytes: Uint8Array, mimeType: string): boolean {
  const ascii = (start: number, value: string) =>
    [...value].every(
      (character, index) => bytes[start + index] === character.charCodeAt(0),
    );
  switch (mimeType) {
    case "image/jpeg":
    case "image/jpg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png":
      return ascii(1, "PNG");
    case "image/gif":
      return ascii(0, "GIF87a") || ascii(0, "GIF89a");
    case "image/webp":
      return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "image/bmp":
      return ascii(0, "BM");
    case "image/avif":
      return ascii(4, "ftypavif") || ascii(4, "ftypavis");
    case "image/svg+xml":
      try {
        return /^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(
          new TextDecoder("utf-8", { fatal: true })
            .decode(bytes.subarray(0, Math.min(bytes.length, 4096)))
            .trimStart(),
        );
      } catch {
        return false;
      }
    default:
      return false;
  }
}

function useLoadedMedia(items: readonly MediaItem[]): LoadedMedia[] {
  const [loaded, setLoaded] = useState<LoadedMedia[]>(() => [...items]);
  useEffect(() => {
    let disposed = false;
    const urls: string[] = [];
    setLoaded([...items]);
    void Promise.all(
      items.map(async (item): Promise<LoadedMedia> => {
        try {
          let blob: Blob;
          if (item.kind === "inline") {
            blob = decodeInline(item);
          } else {
            const bridge = peekBridge();
            if (!bridge) throw new Error("Image bridge unavailable");
            const ref =
              item.kind === "remote"
                ? await bridge.materializeImageUrl(item.url)
                : item.block.ref;
            const bytes = await bridge.readBlob(ref.blob);
            blob = new Blob(
              [
                bytes.buffer.slice(
                  bytes.byteOffset,
                  bytes.byteOffset + bytes.byteLength,
                ) as ArrayBuffer,
              ],
              {
                type: ref.mimeType ?? "application/octet-stream",
              },
            );
          }
          if (!blob || blob.size === 0) throw new Error("Image unavailable");
          const url = URL.createObjectURL(blob);
          urls.push(url);
          return { ...item, url };
        } catch (error) {
          return {
            ...item,
            error: error instanceof Error ? error.message : "Image unavailable",
          };
        }
      }),
    ).then((results) => {
      if (!disposed) setLoaded(results);
    });
    return () => {
      disposed = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [items]);
  return loaded;
}

function altOf(item: MediaItem, index: number): string {
  return item.kind === "blob"
    ? (item.block.alt ?? `Result image ${index + 1}`)
    : (item.alt ?? `Result image ${index + 1}`);
}

export function MediaGallery({
  items: rawItems,
  className,
}: {
  items: readonly MediaItem[];
  className?: string;
}) {
  const items = useMemo(() => dedupeMedia(rawItems), [rawItems]);
  const loaded = useLoadedMedia(items);
  const [selected, setSelected] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const visible = loaded.slice(0, 9);
  if (items.length === 0) return null;

  return (
    <>
      <div
        className={cx(
          "my-2 grid grid-cols-[repeat(auto-fit,minmax(min(11rem,100%),1fr))] gap-1.5",
          className,
        )}
      >
        {visible.map((item, index) => (
          <button
            key={item.key}
            type="button"
            className="group/media relative aspect-[4/3] min-h-32 overflow-hidden rounded-lg border border-border-subtle bg-inset text-fg-muted outline-none transition-colors duration-100 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent"
            onClick={(event) => {
              if (!item.url) return;
              triggerRef.current = event.currentTarget;
              setSelected(index);
            }}
            aria-label={`Open ${altOf(item, index)}`}
            disabled={!item.url}
          >
            {item.url ? (
              <img
                src={item.url}
                alt={altOf(item, index)}
                loading="lazy"
                className="size-full object-cover transition-transform duration-200 motion-safe:group-hover/media:scale-[1.015]"
              />
            ) : item.error ? (
              <span className="flex size-full flex-col items-center justify-center gap-2 px-3 text-xs">
                <ImageOff className="size-5" aria-hidden="true" />
                {item.error}
              </span>
            ) : (
              <span
                className="block size-full animate-pulse bg-raised"
                aria-hidden="true"
              />
            )}
            {index === 8 && loaded.length > 9 ? (
              <span className="absolute inset-0 flex items-center justify-center bg-canvas/70 text-lg font-semibold text-fg">
                +{loaded.length - 9}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {selected !== null ? (
        <MediaLightbox
          items={loaded}
          index={selected}
          onIndexChange={setSelected}
          onClose={() => {
            setSelected(null);
            requestAnimationFrame(() => triggerRef.current?.focus());
          }}
        />
      ) : null}
    </>
  );
}

function MediaLightbox({
  items,
  index,
  onIndexChange,
  onClose,
}: {
  items: readonly LoadedMedia[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const pointerStart = useRef<number | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const item = items[index];
  const move = (delta: number) =>
    onIndexChange((index + delta + items.length) % items.length);

  useEffect(() => {
    useUi.getState().enterOverlay();
    return () => useUi.getState().exitOverlay();
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        move(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        move(1);
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  });

  if (!item) return null;
  const alt = altOf(item, index);
  const extension = mimeExtension(
    item.kind === "blob"
      ? item.block.ref.mimeType
      : item.kind === "inline"
        ? item.mimeType
        : undefined,
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        canvasRef.current?.focus();
      }}
      size="lg"
      className="flex h-[calc(100dvh-32px)] max-w-[calc(100vw-32px)] flex-col overflow-hidden p-0 max-md:h-[100dvh] max-md:rounded-none"
    >
      <DialogTitle className="sr-only">Image gallery</DialogTitle>
      <div className="flex h-12 shrink-0 items-center border-b border-border-subtle px-3">
        <span className="text-sm font-medium text-fg">{alt}</span>
        <span
          className="ml-2 text-xs tabular-nums text-fg-muted"
          aria-live="polite"
        >
          {index + 1} of {items.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {item.url ? (
            <a
              href={item.url}
              download={`agena-image-${index + 1}.${extension}`}
              className="flex size-11 items-center justify-center rounded-md text-fg-muted hover:bg-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Download image"
            >
              <Download className="size-4" aria-hidden="true" />
            </a>
          ) : null}
          <IconButton
            label="Close image gallery"
            size="sm"
            className="size-11"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <div
        ref={canvasRef}
        tabIndex={-1}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-canvas p-4"
        onPointerDown={(event) => {
          pointerStart.current = event.clientX;
        }}
        onPointerUp={(event) => {
          const start = pointerStart.current;
          pointerStart.current = null;
          if (start === null || Math.abs(event.clientX - start) < 50) return;
          move(event.clientX < start ? 1 : -1);
        }}
      >
        {item.url ? (
          <img
            src={item.url}
            alt={alt}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <ImageOff className="size-10 text-fg-muted" aria-hidden="true" />
        )}
        {items.length > 1 ? (
          <>
            <button
              type="button"
              className="absolute left-3 flex size-11 items-center justify-center rounded-full border border-border bg-overlay text-fg shadow-overlay hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => move(-1)}
              aria-label="Previous image"
            >
              <ChevronLeft className="size-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="absolute right-3 flex size-11 items-center justify-center rounded-full border border-border bg-overlay text-fg shadow-overlay hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => move(1)}
              aria-label="Next image"
            >
              <ChevronRight className="size-5" aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

function mimeExtension(mimeType: string | undefined): string {
  switch (mimeType?.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/svg+xml":
      return "svg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    case "image/bmp":
      return "bmp";
    default:
      return "png";
  }
}
