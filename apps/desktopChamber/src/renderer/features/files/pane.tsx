// Files pane: lazy, virtualized worktree plus safe read-only source, Markdown,
// and raster-image previews over bridge.readFile. The daemon remains the only
// filesystem authority; renderer modules only receive validated bytes.

import type { GitWorktreeChanges } from "@agena/protocol";
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
import {
  pushToast,
  resolveAppearance,
  useSessions,
  useUi,
} from "../../store/index.ts";
import {
  clearPendingSourceReference,
  type FileReference,
  OPEN_SOURCE_REFERENCE_EVENT,
  pendingSourceReference,
  textFingerprint,
} from "../../store/source-reference.ts";
import {
  cx,
  EmptyState,
  IconButton,
  Panel,
  PanelBody,
  PanelHeader,
  Segmented,
  Spinner,
} from "../../ui/index.ts";
import { selectedLineRange } from "../composer/source-reference-ui.tsx";
import { CodeView } from "./code-view.tsx";
import {
  breadcrumbs,
  type DirState,
  detectFileRenderer,
  fileRootForSession,
  flattenTree,
  isMarkdownPath,
  isRasterImagePath,
  MAX_PREVIEW_BYTES,
  MAX_RASTER_BYTES_DESKTOP,
  MAX_RASTER_BYTES_MOBILE,
} from "./files-lib.ts";
import { MarkdownFilePreview, RasterImagePreview } from "./preview.tsx";

type ViewerState =
  | { kind: "idle" }
  | { kind: "loading"; path: string }
  | { kind: "error"; path: string; message: string }
  | { kind: "unsupported"; path: string; size: number; message: string }
  | { kind: "markdown"; path: string; size: number; content: string }
  | {
      kind: "image";
      path: string;
      size: number;
      bytes: Uint8Array;
      mediaType: string;
    }
  | { kind: "text"; path: string; size: number; content: string; lang: string };

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
  onOpenFile: (path: string, size?: number) => void;
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
      const row = rows[index];
      return row ? `${row.kind}:${row.path}` : index;
    },
  });
  return (
    <div ref={scrollRef} className="h-full overflow-y-auto p-1.5" role="tree">
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
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
              onClick={() => onOpenFile(row.path, row.size)}
              style={{ ...rowPos, ...indent }}
              className={cx(
                "flex items-center gap-1 rounded-md pr-2 text-left transition-colors",
                mobile && "active:bg-raised",
                selected ? "bg-raised" : "hover:bg-raised/60",
              )}
            >
              <span className="size-3.5 shrink-0" />
              {isRasterImagePath(row.path) ? (
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

function SourcePreview({
  content,
  lang,
  path,
  sessionId,
  worktree,
  root,
}: {
  content: string;
  lang: string;
  path: string;
  sessionId?: string;
  worktree: GitWorktreeChanges | null;
  root: string;
}) {
  const theme = useUi((state) => state.theme);
  const relativePath =
    root !== "." && path.startsWith(`${root}/`)
      ? path.slice(root.length + 1)
      : path;
  return (
    <CodeView
      code={content}
      lang={lang}
      theme={resolveAppearance(theme.appearance)}
      {...(sessionId
        ? {
            selection: {
              sessionId,
              makeReference: (snapshot, selection, selectionRoot) => {
                const range = selectedLineRange(selection, selectionRoot);
                if (!range) return null;
                return {
                  v: 1,
                  id: crypto.randomUUID(),
                  kind: "file",
                  sessionId,
                  ...(worktree?.worktreeId
                    ? { worktreeId: worktree.worktreeId }
                    : {}),
                  path: relativePath,
                  range,
                  contentHash: textFingerprint(content),
                  ...(worktree?.head ? { head: worktree.head } : {}),
                  snapshot,
                } satisfies FileReference;
              },
            },
          }
        : {})}
    />
  );
}

function Viewer({
  viewer,
  sessionId,
  worktree,
  root,
  mobile,
  markdownMode,
  onOpenFile,
}: {
  viewer: ViewerState;
  sessionId?: string;
  worktree: GitWorktreeChanges | null;
  root: string;
  mobile: boolean;
  markdownMode: "preview" | "source";
  onOpenFile: (path: string) => void;
}) {
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
    case "unsupported":
      return (
        <EmptyState
          icon={File}
          title="Preview unavailable"
          hint={`${viewer.message} (${formatBytes(viewer.size)})`}
        />
      );
    case "image":
      return (
        <RasterImagePreview
          bytes={viewer.bytes}
          mediaType={viewer.mediaType}
          alt={viewer.path.split("/").pop() ?? "Image"}
          mobile={mobile}
        />
      );
    case "markdown":
      return markdownMode === "preview" ? (
        <MarkdownFilePreview
          content={viewer.content}
          path={viewer.path}
          root={root}
          mobile={mobile}
          onOpenFile={onOpenFile}
        />
      ) : (
        <SourcePreview
          content={viewer.content}
          lang="markdown"
          path={viewer.path}
          {...(sessionId ? { sessionId } : {})}
          worktree={worktree}
          root={root}
        />
      );
    case "text":
      return (
        <SourcePreview
          content={viewer.content}
          lang={viewer.lang}
          path={viewer.path}
          {...(sessionId ? { sessionId } : {})}
          worktree={worktree}
          root={root}
        />
      );
  }
}

// ---- the pane ------------------------------------------------------------------------

export function FilesPane({ mobile = false }: { mobile?: boolean }) {
  const activeSession = useSessions((s) =>
    s.activeSessionId ? s.byId[s.activeSessionId] : undefined,
  );
  const activeSessionId = activeSession?.sessionId;

  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [viewer, setViewer] = useState<ViewerState>({ kind: "idle" });
  const [markdownModes, setMarkdownModes] = useState<
    Record<string, "preview" | "source">
  >({});
  const [worktrees, setWorktrees] = useState<GitWorktreeChanges[]>([]);
  const [requestedFile, setRequestedFile] = useState<FileReference | null>(
    null,
  );
  const readSeq = useRef(0);
  const worktree =
    worktrees.find((item) => item.worktreeId === requestedFile?.worktreeId) ??
    worktrees.find((item) => item.available) ??
    null;
  const root = worktree
    ? fileRootForSession({ scope: "project", projectRoot: worktree.root })
    : fileRootForSession(activeSession);

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

  useEffect(() => {
    setWorktrees([]);
    if (!activeSessionId) return;
    let live = true;
    void getBridge()
      .getSessionChanges(activeSessionId)
      .then((summary) => {
        if (live) setWorktrees(summary.worktrees);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [activeSessionId]);

  useEffect(() => {
    const receive = (event: Event) => {
      const ref = (event as CustomEvent<unknown>).detail;
      if (
        ref &&
        typeof ref === "object" &&
        (ref as { kind?: unknown }).kind === "file"
      ) {
        setRequestedFile(ref as FileReference);
      }
    };
    const pending = pendingSourceReference("file");
    if (pending?.kind === "file") setRequestedFile(pending);
    window.addEventListener(OPEN_SOURCE_REFERENCE_EVENT, receive);
    return () =>
      window.removeEventListener(OPEN_SOURCE_REFERENCE_EVENT, receive);
  }, []);

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

  const openFile = useCallback(
    (path: string, sizeHint?: number) => {
      const maxRasterBytes = mobile
        ? MAX_RASTER_BYTES_MOBILE
        : MAX_RASTER_BYTES_DESKTOP;
      if (
        sizeHint !== undefined &&
        ((isRasterImagePath(path) && sizeHint > maxRasterBytes) ||
          (!isRasterImagePath(path) && sizeHint > MAX_PREVIEW_BYTES))
      ) {
        setViewer({
          kind: "unsupported",
          path,
          size: sizeHint,
          message: isRasterImagePath(path)
            ? "This image is too large to preview safely."
            : isMarkdownPath(path)
              ? "Markdown preview is limited to 512 KB."
              : "Source previews are limited to 512 KB.",
        });
        return;
      }
      const request = ++readSeq.current;
      setViewer({ kind: "loading", path });
      (async () => getBridge().readFile(path))()
        .then((bytes) => {
          if (readSeq.current !== request) return;
          const decision = detectFileRenderer({
            path,
            size: bytes.byteLength,
            prefix: bytes.subarray(0, 1024),
            maxRasterBytes,
          });
          switch (decision.kind) {
            case "unsupported":
              setViewer({
                kind: "unsupported",
                path,
                size: bytes.byteLength,
                message: decision.reason,
              });
              return;
            case "image":
              setViewer({
                kind: "image",
                path,
                size: bytes.byteLength,
                bytes,
                mediaType: decision.mediaType,
              });
              return;
            case "markdown":
              setViewer({
                kind: "markdown",
                path,
                size: bytes.byteLength,
                content: new TextDecoder().decode(bytes),
              });
              return;
            case "source":
              setViewer({
                kind: "text",
                path,
                size: bytes.byteLength,
                content: new TextDecoder().decode(bytes),
                lang: decision.language,
              });
          }
        })
        .catch((err: unknown) => {
          if (readSeq.current !== request) return;
          setViewer({ kind: "error", path, message: formatBridgeError(err) });
        });
    },
    [mobile],
  );

  useEffect(() => {
    if (!requestedFile || requestedFile.sessionId !== activeSessionId) return;
    if (
      requestedFile.worktreeId &&
      worktree?.worktreeId !== requestedFile.worktreeId
    )
      return;
    const path =
      requestedFile.worktreeId && root !== "."
        ? `${root}/${requestedFile.path}`
        : requestedFile.path;
    openFile(path);
    clearPendingSourceReference(requestedFile.id);
    setRequestedFile(null);
  }, [activeSessionId, openFile, requestedFile, root, worktree]);

  const refresh = useCallback(() => {
    setDirs({});
    loadDir(root);
    for (const path of expanded) loadDir(path);
  }, [root, expanded, loadDir]);

  const copyContents = useCallback(() => {
    if (viewer.kind !== "text" && viewer.kind !== "markdown") return;
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
      {viewer.kind === "markdown" ? (
        <Segmented
          ariaLabel="Markdown view"
          value={markdownModes[viewer.path] ?? "preview"}
          onValueChange={(value) =>
            setMarkdownModes((current) => ({
              ...current,
              [viewer.path]: value,
            }))
          }
          options={[
            { value: "preview", label: "Preview" },
            { value: "source", label: "Source" },
          ]}
          {...(mobile ? { className: "h-9" } : {})}
        />
      ) : null}
      {viewer.kind === "text" || viewer.kind === "markdown" ? (
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
      {viewer.kind === "image" ? (
        <span className="text-2xs tabular-nums text-fg-muted">
          {formatBytes(viewer.size)}
        </span>
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
    <Panel className="relative" data-files-pane="true">
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
          <Viewer
            viewer={viewer}
            {...(activeSessionId ? { sessionId: activeSessionId } : {})}
            worktree={worktree}
            root={root}
            mobile={mobile}
            markdownMode={
              viewer.kind === "markdown"
                ? (markdownModes[viewer.path] ?? "preview")
                : "preview"
            }
            onOpenFile={openFile}
          />
        </div>
      </PanelBody>
    </Panel>
  );
}
