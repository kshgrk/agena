import { Minus, Plus, Scan, Shrink } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { getBridge } from "../../lib/bridge.ts";
import { IconButton, Spinner } from "../../ui/index.ts";
import { Markdown } from "../transcript/markdown.tsx";
import {
  MAX_RASTER_BYTES_DESKTOP,
  MAX_RASTER_BYTES_MOBILE,
  resolveWorkspaceLink,
  sniffRasterMediaType,
} from "./files-lib.ts";

function objectUrl(bytes: Uint8Array, mediaType: string): string {
  return URL.createObjectURL(
    new Blob(
      [
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      ],
      { type: mediaType },
    ),
  );
}

function MarkdownImage({
  src,
  alt,
  title,
  path,
  root,
  mobile,
}: {
  src: string;
  alt: string;
  title?: string;
  path: string;
  root: string;
  mobile: boolean;
}) {
  const target = resolveWorkspaceLink(path, src, root);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; url: string }
    | { kind: "error"; message: string }
  >(
    target
      ? { kind: "loading" }
      : { kind: "error", message: "Remote image blocked" },
  );

  useEffect(() => {
    if (!target) {
      setState({ kind: "error", message: "Remote image blocked" });
      return;
    }
    let live = true;
    let url: string | null = null;
    setState({ kind: "loading" });
    void getBridge()
      .readFile(target)
      .then((bytes) => {
        if (!live) return;
        const limit = mobile
          ? MAX_RASTER_BYTES_MOBILE
          : MAX_RASTER_BYTES_DESKTOP;
        const mediaType = sniffRasterMediaType(bytes);
        if (bytes.byteLength > limit) {
          setState({ kind: "error", message: "Image is too large to preview" });
        } else if (!mediaType) {
          setState({ kind: "error", message: "Unsafe or unsupported image" });
        } else {
          url = objectUrl(bytes, mediaType);
          setState({ kind: "ready", url });
        }
      })
      .catch(() => {
        if (live) setState({ kind: "error", message: "Image unavailable" });
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [mobile, target]);

  if (state.kind === "loading") {
    return (
      <span className="my-3 flex min-h-20 items-center justify-center rounded-lg border border-border-subtle bg-inset text-fg-muted">
        <Spinner className="size-4" />
      </span>
    );
  }
  if (state.kind === "error") {
    return (
      <span className="my-3 block rounded-lg border border-border-subtle bg-inset px-3 py-2 text-xs text-fg-muted">
        {alt || state.message} · {state.message}
      </span>
    );
  }
  return (
    <img
      src={state.url}
      alt={alt}
      title={title}
      loading="lazy"
      className="my-4 max-h-[32rem] max-w-full rounded-lg border border-border object-contain"
    />
  );
}

export function MarkdownFilePreview({
  content,
  path,
  root,
  mobile,
  onOpenFile,
}: {
  content: string;
  path: string;
  root: string;
  mobile: boolean;
  onOpenFile: (path: string) => void;
}) {
  const onLink = useCallback(
    (href: string) => {
      const target = resolveWorkspaceLink(path, href, root);
      if (!target) return false;
      onOpenFile(target);
      return true;
    },
    [onOpenFile, path, root],
  );
  const renderImage = useCallback(
    (input: { src: string; alt: string; title?: string }): ReactNode => (
      <MarkdownImage {...input} path={path} root={root} mobile={mobile} />
    ),
    [mobile, path, root],
  );
  return (
    <article className="mx-auto w-full max-w-4xl px-5 py-6 md:px-8 md:py-9">
      <Markdown
        text={content}
        onLink={onLink}
        renderImage={renderImage}
        className="text-pretty [&_h1]:text-balance [&_h2]:text-balance [&_h3]:text-balance"
      />
    </article>
  );
}

export function RasterImagePreview({
  bytes,
  mediaType,
  alt,
  mobile,
}: {
  bytes: Uint8Array;
  mediaType: string;
  alt: string;
  mobile: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(1);

  useEffect(() => {
    setNatural({ width: 0, height: 0 });
    setScale(1);
    const next = objectUrl(bytes, mediaType);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, mediaType]);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !natural.width || !natural.height) return;
    setScale(
      Math.min(
        1,
        (viewport.clientWidth - 48) / natural.width,
        (viewport.clientHeight - 48) / natural.height,
      ),
    );
  }, [natural]);

  useLayoutEffect(() => {
    if (!natural.width) return;
    const frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [fit, natural.width]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-inset">
      <div ref={viewportRef} className="h-full overflow-auto">
        <div className="flex min-h-full min-w-full items-center justify-center p-6">
          {url ? (
            <img
              src={url}
              alt={alt}
              draggable={false}
              onLoad={(event) =>
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
              className="max-w-none shrink-0 select-none object-contain"
              style={{
                width: natural.width ? natural.width * scale : undefined,
                height: natural.height ? natural.height * scale : undefined,
              }}
            />
          ) : (
            <Spinner className="size-5 text-fg-muted" />
          )}
        </div>
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-border bg-overlay p-1 shadow-md">
        <IconButton
          label="Zoom out"
          size="sm"
          className={mobile ? "size-11" : undefined}
          onClick={() => setScale((value) => Math.max(0.1, value / 1.2))}
        >
          <Minus />
        </IconButton>
        <span className="w-11 text-center text-2xs tabular-nums text-fg-muted">
          {Math.round(scale * 100)}%
        </span>
        <IconButton
          label="Zoom in"
          size="sm"
          className={mobile ? "size-11" : undefined}
          onClick={() => setScale((value) => Math.min(8, value * 1.2))}
        >
          <Plus />
        </IconButton>
        <IconButton
          label="Actual size"
          size="sm"
          className={mobile ? "size-11" : undefined}
          onClick={() => setScale(1)}
        >
          <Scan />
        </IconButton>
        <IconButton
          label="Fit image"
          size="sm"
          className={mobile ? "size-11" : undefined}
          onClick={fit}
        >
          <Shrink />
        </IconButton>
      </div>
    </div>
  );
}
