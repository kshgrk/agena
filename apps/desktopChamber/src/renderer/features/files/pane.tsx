// Files pane: lazy, virtualized workspace tree over bridge.listFiles plus a
// shiki-highlighted read-only viewer over bridge.readFile (binary/size
// guards, breadcrumb bar, refresh). The daemon has no write route — no
// save/edit affordance. Ported from apps/desktop features/files with the
// IMPROVE-ON fixes (refresh button, virtualized tree).
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  File,
  Folder,
  FolderOpen,
  Image,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import { formatBridgeError } from "../../lib/errors.ts";
import { formatBytes } from "../../lib/format.ts";
import { pushToast, useSessions, useUi } from "../../store/index.ts";
import {
  cx,
  EmptyState,
  IconButton,
  Panel,
  PanelBody,
  PanelHeader,
  Spinner,
} from "../../ui/index.ts";
import { CodeView } from "./code-view.tsx";
import {
  breadcrumbs,
  type DirState,
  fileRootForSession,
  flattenTree,
  isImagePath,
  looksBinary,
  MAX_PREVIEW_BYTES,
  shikiLangForPath,
} from "./files-lib.ts";

type ViewerState =
  | { kind: "idle" }
  | { kind: "loading"; path: string }
  | { kind: "error"; path: string; message: string }
  | { kind: "binary"; path: string; size: number }
  | { kind: "image"; path: string }
  | { kind: "text"; path: string; size: number; content: string; lang: string };

function resolvedTheme(theme: "dark" | "light" | "system"): "dark" | "light" {
  if (theme !== "system") return theme;
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

// ---- tree ------------------------------------------------------------------------

function TreeRows({
  root,
  dirs,
  expanded,
  selectedPath,
  onToggleDir,
  onOpenFile,
  mobile = false,
}: {
  root: string;
  dirs: Readonly<Record<string, DirState>>;
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  mobile?: boolean;
}) {
  const rows = useMemo(
    () => flattenTree(root, dirs, expanded),
    [root, dirs, expanded],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (mobile ? 44 : 28),
    overscan: 12,
    getItemKey: (index) => {
      const row = rows[index]!;
      return `${row.kind}:${row.path}`;
    },
  });
  return (
    <div ref={scrollRef} className="h-full overflow-y-auto p-1.5" role="tree">
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          const indent = { paddingLeft: `${8 + row.depth * 12}px` };
          const rowPos = {
            position: "absolute" as const,
            top: 0,
            left: 0,
            width: "100%",
            height: `${item.size}px`,
            transform: `translateY(${item.start}px)`,
          };
          if (row.kind === "note") {
            return (
              <div
                key={item.key}
                style={{ ...rowPos, ...indent }}
                className={cx(
                  "flex items-center gap-2 text-xs",
                  row.note === "error" ? "text-danger" : "italic text-fg-muted",
                )}
              >
                {row.note === "loading" ? (
                  <>
                    <Spinner className="size-3.5" /> loading…
                  </>
                ) : row.note === "error" ? (
                  <span className="truncate" title={row.message}>
                    {row.message ?? "failed to load"}
                  </span>
                ) : (
                  "empty"
                )}
              </div>
            );
          }
          if (row.kind === "dir") {
            return (
              <button
                key={item.key}
                type="button"
                role="treeitem"
                aria-expanded={row.expanded}
                onClick={() => onToggleDir(row.path)}
                style={{ ...rowPos, ...indent }}
                className={cx(
                  "flex items-center gap-1 rounded-md pr-2 text-left transition-colors hover:bg-raised/60",
                  mobile && "active:bg-raised",
                )}
              >
                <ChevronRight
                  className={cx(
                    "size-3.5 shrink-0 text-fg-faint transition-transform",
                    row.expanded && "rotate-90",
                  )}
                />
                {row.expanded ? (
                  <FolderOpen className="size-4 shrink-0 text-fg-muted" />
                ) : (
                  <Folder className="size-4 shrink-0 text-fg-muted" />
                )}
                <span className="truncate text-sm text-fg-secondary">
                  {row.name}
                </span>
              </button>
            );
          }
          const selected = row.path === selectedPath;
          return (
            <button
              key={item.key}
              type="button"
              role="treeitem"
              aria-selected={selected}
              onClick={() => onOpenFile(row.path)}
              style={{ ...rowPos, ...indent }}
              className={cx(
                "flex items-center gap-1 rounded-md pr-2 text-left transition-colors",
                mobile && "active:bg-raised",
                selected ? "bg-raised" : "hover:bg-raised/60",
              )}
            >
              <span className="size-3.5 shrink-0" />
              {isImagePath(row.path) ? (
                <Image className="size-4 shrink-0 text-fg-muted" />
              ) : (
                <File className="size-4 shrink-0 text-fg-muted" />
              )}
              <span
                className={cx(
                  "truncate text-sm",
                  selected ? "text-fg" : "text-fg-secondary",
                )}
              >
                {row.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- viewer -----------------------------------------------------------------------

function Breadcrumb({ path }: { path: string }) {
  const segments = breadcrumbs(path);
  let prefix = "";
  const keyedSegments = segments.map((segment) => {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    return { key: prefix, segment };
  });
  return (
    <span className="flex min-w-0 items-center font-mono text-sm" title={path}>
      {keyedSegments.map(({ key, segment }, i) => {
        const last = i === keyedSegments.length - 1;
        return (
          <span key={key} className="flex min-w-0 items-center">
            {i > 0 ? <span className="px-1 text-fg-faint">/</span> : null}
            <span
              className={cx("truncate", last ? "text-fg" : "text-fg-muted")}
            >
              {segment}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function Viewer({ viewer }: { viewer: ViewerState }) {
  const theme = useUi((s) => s.theme);
  switch (viewer.kind) {
    case "idle":
      return (
        <EmptyState
          icon={File}
          title="No file open"
          hint="Pick a file in the tree to preview it."
        />
      );
    case "loading":
      return (
        <div className="flex h-full items-center justify-center">
          <Spinner className="text-fg-muted" />
        </div>
      );
    case "error":
      return (
        <EmptyState
          icon={File}
          title="Failed to read file"
          hint={viewer.message}
        />
      );
    case "binary":
      return (
        <EmptyState
          icon={File}
          title="Binary or too large to preview"
          hint={`${formatBytes(viewer.size)} — text previews stop at ${formatBytes(MAX_PREVIEW_BYTES)}.`}
        />
      );
    case "image":
      return (
        <EmptyState
          icon={Image}
          title="Image preview"
          hint="Image blob fetch lands with a later milestone."
        />
      );
    case "text":
      return (
        <CodeView
          code={viewer.content}
          lang={viewer.lang}
          theme={resolvedTheme(theme)}
        />
      );
  }
}

// ---- the pane ------------------------------------------------------------------------

export function FilesPane({ mobile = false }: { mobile?: boolean }) {
  const activeSession = useSessions((s) =>
    s.activeSessionId ? s.byId[s.activeSessionId] : undefined,
  );
  const root = fileRootForSession(activeSession);

  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [viewer, setViewer] = useState<ViewerState>({ kind: "idle" });
  const readSeq = useRef(0);

  const loadDir = useCallback((path: string) => {
    setDirs((d) => ({ ...d, [path]: { status: "loading" } }));
    // async wrapper folds a synchronous getBridge() throw into the catch
    (async () => getBridge().listFiles({ path }))()
      .then((entries) => {
        setDirs((d) => ({ ...d, [path]: { status: "ready", entries } }));
      })
      .catch((err: unknown) => {
        setDirs((d) => ({
          ...d,
          [path]: { status: "error", message: formatBridgeError(err) },
        }));
      });
  }, []);

  // root change (session/project switch) resets everything and reloads
  useEffect(() => {
    setDirs({});
    setExpanded(new Set());
    setViewer({ kind: "idle" });
    readSeq.current++;
    loadDir(root);
  }, [root, loadDir]);

  const toggleDir = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      setDirs((d) => {
        if (d[path]) return d;
        // first open: kick off the lazy load (outside the state updater)
        queueMicrotask(() => loadDir(path));
        return d;
      });
    },
    [loadDir],
  );

  const openFile = useCallback((path: string) => {
    if (isImagePath(path)) {
      readSeq.current++;
      setViewer({ kind: "image", path });
      return;
    }
    const request = ++readSeq.current;
    setViewer({ kind: "loading", path });
    (async () => getBridge().readFile(path))()
      .then((bytes) => {
        if (readSeq.current !== request) return; // stale response
        if (bytes.byteLength > MAX_PREVIEW_BYTES || looksBinary(bytes)) {
          setViewer({ kind: "binary", path, size: bytes.byteLength });
          return;
        }
        setViewer({
          kind: "text",
          path,
          size: bytes.byteLength,
          content: new TextDecoder().decode(bytes),
          lang: shikiLangForPath(path),
        });
      })
      .catch((err: unknown) => {
        if (readSeq.current !== request) return;
        setViewer({ kind: "error", path, message: formatBridgeError(err) });
      });
  }, []);

  const refresh = useCallback(() => {
    setDirs({});
    loadDir(root);
    for (const path of expanded) loadDir(path);
  }, [root, expanded, loadDir]);

  const copyContents = useCallback(() => {
    if (viewer.kind !== "text") return;
    navigator.clipboard
      .writeText(viewer.content)
      .then(() => pushToast({ kind: "ok", title: "Copied file contents" }))
      .catch(() =>
        pushToast({
          kind: "err",
          title: "Copy failed",
          detail: "Clipboard unavailable",
        }),
      );
  }, [viewer]);

  const openPath = viewer.kind === "idle" ? null : viewer.path;

  const headerTitle = openPath ? (
    <Breadcrumb path={openPath} />
  ) : root === "." ? (
    "Files"
  ) : (
    root
  );

  const headerActions = (
    <>
      {viewer.kind === "text" ? (
        <>
          <span className="text-2xs tabular-nums text-fg-muted">
            {formatBytes(viewer.size)}
          </span>
          <IconButton
            label="Copy file contents"
            size="sm"
            className={mobile ? "size-11" : undefined}
            onClick={copyContents}
          >
            <Copy />
          </IconButton>
        </>
      ) : null}
      <IconButton
        label="Refresh tree"
        size="sm"
        className={mobile ? "size-11" : undefined}
        onClick={refresh}
      >
        <RefreshCw />
      </IconButton>
    </>
  );

  return (
    <Panel>
      {mobile ? (
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border-subtle px-1">
          {openPath ? (
            <button
              type="button"
              aria-label="Back to files"
              onClick={() => setViewer({ kind: "idle" })}
              className="flex size-11 shrink-0 items-center justify-center rounded-md text-fg-secondary active:bg-raised"
            >
              <ChevronLeft className="size-5" />
            </button>
          ) : null}
          <div className="min-w-0 flex-1 truncate px-2 text-sm font-medium text-fg-secondary">
            {headerTitle}
          </div>
          <div className="flex shrink-0 items-center">{headerActions}</div>
        </div>
      ) : (
        <PanelHeader title={headerTitle} actions={headerActions} />
      )}
      <PanelBody scroll={false} className="flex">
        <div
          className={cx(
            "border-r border-border-subtle",
            mobile ? (openPath ? "hidden" : "w-full") : "w-60 shrink-0",
          )}
        >
          <TreeRows
            root={root}
            dirs={dirs}
            expanded={expanded}
            selectedPath={openPath}
            onToggleDir={toggleDir}
            onOpenFile={openFile}
            mobile={mobile}
          />
        </div>
        <div
          className={cx(
            "min-w-0 flex-1 overflow-auto bg-inset",
            mobile && !openPath && "hidden",
          )}
        >
          <Viewer viewer={viewer} />
        </div>
      </PanelBody>
    </Panel>
  );
}
