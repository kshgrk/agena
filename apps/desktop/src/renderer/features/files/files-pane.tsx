// Read-only file browser over listFiles/readFile (plan D3). No save/edit
// affordance anywhere — the daemon has no write route yet.
import type { FileEntry, SessionSummary } from "@agena/protocol";
import {
  ChevronRight,
  Copy,
  File,
  FileCode,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import { useSessions } from "../../store/index.ts";
import {
  CodeBlock,
  cx,
  EmptyState,
  IconButton,
  PanelHeader,
  PanelShell,
  Spinner,
  toast,
} from "../../ui/index.ts";

const MAX_PREVIEW_BYTES = 512 * 1024;

const LANG_BY_EXT: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  json: "json",
  css: "css",
  html: "html",
  md: "md",
  py: "py",
  sh: "sh",
};

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "svg",
]);

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function fileIcon(name: string) {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return ImageIcon;
  if (ext === "json") return FileJson;
  if (ext === "md" || ext === "txt") return FileText;
  if (ext in LANG_BY_EXT) return FileCode;
  return File;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const errMessage = (err: unknown): string =>
  typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : String(err);

const sortEntries = (entries: FileEntry[]): FileEntry[] =>
  [...entries].sort(
    (a, b) =>
      (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) ||
      a.name.localeCompare(b.name),
  );

function workspaceRelative(path: string): string {
  const clean = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const rel = clean.startsWith("/workspace/")
    ? clean.slice("/workspace/".length)
    : clean === "/workspace"
      ? "."
      : clean.replace(/^\.?\/*/, "");
  return rel || ".";
}

export function fileRootForSession(
  session: Pick<SessionSummary, "scope" | "projectRoot"> | undefined,
): string {
  return session?.scope === "project" && session.projectRoot
    ? workspaceRelative(session.projectRoot)
    : ".";
}

type DirState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: FileEntry[] };

type ViewerState =
  | { status: "idle" }
  | { status: "loading"; path: string }
  | { status: "error"; path: string; message: string }
  | { status: "binary"; path: string; size: number }
  | { status: "image"; path: string; size: number }
  | {
      status: "text";
      path: string;
      size: number;
      content: string;
      lang: string;
    };

// ---- tree -------------------------------------------------------------------

type TreeCtx = {
  dirs: Readonly<Record<string, DirState>>;
  expanded: Readonly<Record<string, boolean>>;
  selected: string | null;
  onToggle: (path: string) => void;
  onOpenFile: (path: string, size: number) => void;
};

const rowCls =
  "flex w-full items-center gap-1.5 px-2 py-[3px] text-left text-xs " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent";

function DirRows({
  path,
  depth,
  ctx,
}: {
  path: string;
  depth: number;
  ctx: TreeCtx;
}) {
  const indent = { paddingLeft: depth * 12 + 8 };
  const state = ctx.dirs[path];
  if (!state || state.status === "loading") {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1 text-xs text-ink-mute"
        style={indent}
      >
        <Spinner /> loading…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="px-2 py-1 text-xs text-err" style={indent}>
        {state.message}
      </div>
    );
  }
  if (state.entries.length === 0) {
    return (
      <div className="px-2 py-1 text-xs italic text-ink-mute" style={indent}>
        empty
      </div>
    );
  }
  return (
    <>
      {state.entries.map((entry) => {
        const childPath = path === "." ? entry.name : `${path}/${entry.name}`;
        if (entry.type === "dir") {
          const open = ctx.expanded[childPath] === true;
          const FolderIcon = open ? FolderOpen : Folder;
          return (
            <Fragment key={childPath}>
              <button
                type="button"
                onClick={() => ctx.onToggle(childPath)}
                className={cx(
                  rowCls,
                  "text-ink-dim hover:bg-raised hover:text-ink",
                )}
                style={indent}
              >
                <ChevronRight
                  className={cx(
                    "size-3 shrink-0 text-ink-mute transition-transform",
                    open && "rotate-90",
                  )}
                />
                <FolderIcon className="size-3.5 shrink-0 text-ink-mute" />
                <span className="truncate">{entry.name}</span>
              </button>
              {open ? (
                <DirRows path={childPath} depth={depth + 1} ctx={ctx} />
              ) : null}
            </Fragment>
          );
        }
        const Icon = fileIcon(entry.name);
        const selected = ctx.selected === childPath;
        return (
          <button
            key={childPath}
            type="button"
            onClick={() => ctx.onOpenFile(childPath, entry.size)}
            className={cx(
              rowCls,
              selected
                ? "bg-accent/10 text-ink"
                : "text-ink-dim hover:bg-raised hover:text-ink",
            )}
            style={indent}
          >
            <span className="size-3 shrink-0" />
            <Icon className="size-3.5 shrink-0 text-ink-mute" />
            <span className="truncate">{entry.name}</span>
          </button>
        );
      })}
    </>
  );
}

// ---- viewer -------------------------------------------------------------------

function breadcrumb(path: string) {
  const parts = path.split("/");
  return (
    <span className="flex items-center gap-1 font-mono text-[11px] normal-case tracking-normal">
      {parts.map((part, i) => (
        <Fragment key={parts.slice(0, i + 1).join("/")}>
          {i > 0 ? <span className="text-ink-mute">/</span> : null}
          <span
            className={i === parts.length - 1 ? "text-ink" : "text-ink-mute"}
          >
            {part}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

function ViewerBody({
  viewer,
}: {
  viewer: Exclude<ViewerState, { status: "idle" }>;
}) {
  switch (viewer.status) {
    case "loading":
      return (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      );
    case "error":
      return (
        <EmptyState
          icon={File}
          title="Could not read file"
          hint={viewer.message}
        />
      );
    case "binary":
      return (
        <EmptyState
          icon={File}
          title="Binary or too large to preview"
          hint={`${humanSize(viewer.size)} — only text files up to 512 KB render here.`}
        />
      );
    case "image":
      return (
        <EmptyState
          icon={ImageIcon}
          title="No preview"
          hint="Image blob fetch lands later."
        />
      );
    case "text":
      return (
        <div className="min-h-0 flex-1 p-2">
          {/* ponytail: arbitrary-variant override of CodeBlock's internal
              max-h-96 so the viewer fills the pane; drop when CodeBlock grows
              a fill-height prop */}
          <CodeBlock
            code={viewer.content}
            lang={viewer.lang}
            className="h-full [&>div:last-child]:h-full [&>div:last-child]:max-h-none"
          />
        </div>
      );
  }
}

// ---- pane -------------------------------------------------------------------

export function FilesPane() {
  const rootPath = useSessions((s) => {
    const id = s.activeSessionId;
    return fileRootForSession(id ? s.byId[id] : undefined);
  });
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [viewer, setViewer] = useState<ViewerState>({ status: "idle" });
  const openReq = useRef(0);

  const loadDir = useCallback((path: string) => {
    setDirs((d) => ({ ...d, [path]: { status: "loading" } }));
    getBridge()
      .listFiles({ path })
      .then((entries) =>
        setDirs((d) => ({
          ...d,
          [path]: { status: "ready", entries: sortEntries(entries) },
        })),
      )
      .catch((err) =>
        setDirs((d) => ({
          ...d,
          [path]: { status: "error", message: errMessage(err) },
        })),
      );
  }, []);

  useEffect(() => {
    openReq.current += 1;
    setDirs({});
    setExpanded({});
    setViewer({ status: "idle" });
    loadDir(rootPath);
  }, [loadDir, rootPath]);

  const onToggle = useCallback(
    (path: string) => {
      const opening = expanded[path] !== true;
      setExpanded((e) => ({ ...e, [path]: opening }));
      if (opening && !dirs[path]) loadDir(path);
    },
    [expanded, dirs, loadDir],
  );

  const onOpenFile = useCallback((path: string, size: number) => {
    if (IMAGE_EXTS.has(extOf(path))) {
      setViewer({ status: "image", path, size });
      return;
    }
    const id = ++openReq.current;
    setViewer({ status: "loading", path });
    getBridge()
      .readFile(path)
      .then((bytes) => {
        if (openReq.current !== id) return;
        if (
          bytes.byteLength > MAX_PREVIEW_BYTES ||
          bytes.subarray(0, 1024).includes(0)
        ) {
          setViewer({ status: "binary", path, size: bytes.byteLength });
          return;
        }
        setViewer({
          status: "text",
          path,
          size: bytes.byteLength,
          content: new TextDecoder().decode(bytes),
          lang: LANG_BY_EXT[extOf(path)] ?? "text",
        });
      })
      .catch((err) => {
        if (openReq.current !== id) return;
        setViewer({ status: "error", path, message: errMessage(err) });
      });
  }, []);

  const ctx: TreeCtx = {
    dirs,
    expanded,
    selected: viewer.status === "idle" ? null : viewer.path,
    onToggle,
    onOpenFile,
  };

  return (
    <PanelShell>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-60 shrink-0 flex-col border-r border-border">
          <PanelHeader title="Files" />
          <div className="min-h-0 flex-1 overflow-auto py-1">
            <DirRows path={rootPath} depth={0} ctx={ctx} />
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {viewer.status === "idle" ? (
            <>
              <PanelHeader title="Preview" />
              <EmptyState
                icon={FileCode}
                title="No file selected"
                hint="Pick a file from the tree to preview it (read-only)."
              />
            </>
          ) : (
            <>
              <PanelHeader
                title={breadcrumb(viewer.path)}
                actions={
                  <>
                    {"size" in viewer ? (
                      <span className="text-[11px] text-ink-mute">
                        {humanSize(viewer.size)}
                      </span>
                    ) : null}
                    {viewer.status === "text" ? (
                      <IconButton
                        size="sm"
                        label="Copy file contents"
                        onClick={() => {
                          void navigator.clipboard.writeText(viewer.content);
                          toast("Copied file contents");
                        }}
                      >
                        <Copy />
                      </IconButton>
                    ) : null}
                  </>
                }
              />
              <ViewerBody viewer={viewer} />
            </>
          )}
        </div>
      </div>
    </PanelShell>
  );
}
