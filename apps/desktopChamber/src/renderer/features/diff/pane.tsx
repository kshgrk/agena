// Diff pane (design.md §9): renders one prepared diff via @git-diff-view/react
// (unified/split), or — when nothing is open — the list of file edits parsed
// from the active session's transcript ("view diff" wiring for tool calls).
import "@git-diff-view/react/styles/diff-view.css";
import "./diff.css";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import { ChevronLeft, FileDiff, FilePen, X } from "lucide-react";
import { useMemo } from "react";
import { useSessions } from "../../store/sessions.ts";
import { resolveAppearance } from "../../store/theme.ts";
import { useTranscripts } from "../../store/transcript.ts";
import { useUi } from "../../store/ui.ts";
import {
  EmptyState,
  IconButton,
  Panel,
  PanelBody,
  PanelHeader,
  RelativeTime,
  Segmented,
} from "../../ui/index.ts";
import {
  bindDiffPaneHost,
  type DiffEntry,
  type DiffMode,
  openEditDiff,
  useDiff,
} from "./diff-store.ts";
import { listFileEdits } from "./edit-tools.ts";

const MODE_OPTIONS = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
] as const;

function compactPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

function PathTitle({
  path,
  compact = false,
}: {
  path: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <span className="truncate font-mono text-sm text-fg" title={path}>
        {compactPath(path)}
      </span>
    );
  }
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return (
    <span className="truncate font-mono text-sm" title={path}>
      {dir ? <span className="text-fg-muted">{dir}</span> : null}
      <span className="text-fg">{base}</span>
    </span>
  );
}

function DiffStats({ adds, dels }: { adds: number; dels: number }) {
  return (
    <span className="shrink-0 text-xs tabular-nums">
      <span className="text-diff-add-fg">+{adds}</span>{" "}
      <span className="text-diff-del-fg">−{dels}</span>
    </span>
  );
}

function DiffBody({ entry, mode }: { entry: DiffEntry; mode: DiffMode }) {
  const theme = useUi((s) => s.theme);
  const data = useMemo(
    () => ({
      oldFile: {
        fileName: entry.path,
        fileLang: entry.lang,
        content: entry.oldText,
      },
      newFile: {
        fileName: entry.path,
        fileLang: entry.lang,
        content: entry.newText,
      },
      hunks: entry.hunks,
    }),
    [entry],
  );
  if (entry.hunks.length === 0) {
    return (
      <EmptyState
        icon={FileDiff}
        title="No changes"
        hint="Old and new contents are identical."
      />
    );
  }
  return (
    <DiffView
      key={`${entry.path}:${entry.nonce}`}
      data={data}
      diffViewMode={
        mode === "split" ? DiffModeEnum.Split : DiffModeEnum.Unified
      }
      diffViewTheme={resolveAppearance(theme.appearance)}
      diffViewHighlight
      diffViewFontSize={13}
    />
  );
}

/** File edits parsed from the active transcript — the "view diff" offer. */
function EditsList({ mobile = false }: { mobile?: boolean }) {
  const activeSessionId = useSessions((s) => s.activeSessionId);
  // Subscribe to rawEvents, not blocks: rawEvents identity changes only on
  // durable events, so streaming tool-output frames (which replace the blocks
  // array every rAF flush) don't re-run the full-transcript edit scan.
  const rawEvents = useTranscripts((s) =>
    activeSessionId ? s.bySession[activeSessionId]?.rawEvents : undefined,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: rawEvents is the durable trigger for the getState() blocks read
  const edits = useMemo(() => {
    const blocks = activeSessionId
      ? useTranscripts.getState().bySession[activeSessionId]?.blocks
      : undefined;
    return blocks ? listFileEdits(blocks) : [];
  }, [activeSessionId, rawEvents]);
  if (edits.length === 0) {
    return (
      <EmptyState
        icon={FileDiff}
        title="No diff open"
        hint="File edits made by the agent in this session will appear here."
      />
    );
  }
  return (
    <div className="flex flex-col gap-0.5 p-2">
      <div className="px-2 pb-1 pt-1 text-2xs font-medium uppercase tracking-wider text-fg-muted">
        Edits in this session
      </div>
      {edits.map(({ block, edit }) => (
        <button
          key={block.toolCallId}
          type="button"
          onClick={() => openEditDiff(edit)}
          className={
            mobile
              ? "flex min-h-13 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-left active:bg-raised"
              : "flex h-7 items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-raised/60"
          }
        >
          <FilePen
            className={
              mobile
                ? "size-5 shrink-0 text-fg-muted"
                : "size-3.5 shrink-0 text-fg-muted"
            }
          />
          {mobile ? (
            <span className="min-w-0 flex-1" title={edit.path}>
              <span className="block truncate font-mono text-sm font-medium text-fg-secondary">
                {compactPath(edit.path)}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-fg-muted">
                <span className="truncate">{block.name}</span>
                <span aria-hidden="true" className="text-fg-faint">
                  ·
                </span>
                <RelativeTime iso={block.at} className="shrink-0" />
              </span>
            </span>
          ) : (
            <>
              <span
                className="min-w-0 flex-1 truncate font-mono text-sm text-fg-secondary"
                title={edit.path}
              >
                {edit.path}
              </span>
              <span className="shrink-0 font-mono text-2xs text-fg-faint">
                {block.name}
              </span>
              <RelativeTime
                iso={block.at}
                className="shrink-0 text-2xs text-fg-muted"
              />
            </>
          )}
        </button>
      ))}
    </div>
  );
}

export function DiffPane({ mobile = false }: { mobile?: boolean }) {
  const entry = useDiff((s) => s.entry);
  const mode = useDiff((s) => s.mode);
  const setMode = useDiff((s) => s.setMode);
  const clear = useDiff((s) => s.clear);
  return (
    <div
      ref={bindDiffPaneHost}
      className="h-full min-h-0"
      data-mobile={mobile || undefined}
    >
      <Panel>
        {!mobile || entry ? (
          <PanelHeader
            {...(mobile ? { className: "h-11 pl-1 pr-1" } : {})}
            title={
              entry ? (
                <span className="flex min-w-0 items-center gap-2">
                  {mobile ? (
                    <button
                      type="button"
                      aria-label="Back to edits"
                      onClick={clear}
                      className="-ml-1 flex size-11 shrink-0 items-center justify-center rounded-md text-fg-secondary active:bg-raised"
                    >
                      <ChevronLeft className="size-5" />
                    </button>
                  ) : null}
                  <PathTitle path={entry.path} compact={mobile} />
                  <DiffStats adds={entry.adds} dels={entry.dels} />
                </span>
              ) : (
                "Diff"
              )
            }
            actions={
              entry ? (
                <>
                  {!mobile ? (
                    <Segmented
                      ariaLabel="Diff layout"
                      value={mode}
                      onValueChange={setMode}
                      options={MODE_OPTIONS}
                    />
                  ) : null}
                  {!mobile ? (
                    <IconButton label="Close diff" size="sm" onClick={clear}>
                      <X />
                    </IconButton>
                  ) : null}
                </>
              ) : undefined
            }
          />
        ) : null}
        <PanelBody className={entry ? "bg-inset" : ""}>
          {entry ? (
            <DiffBody entry={entry} mode={mobile ? "unified" : mode} />
          ) : (
            <EditsList mobile={mobile} />
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
