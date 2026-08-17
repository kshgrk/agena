import {
  FileCode2,
  GitCompareArrows,
  MessageSquareQuote,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { registerCommands } from "../../store/commands.ts";
import { useSessions } from "../../store/sessions.ts";
import {
  MAX_REFERENCE_SNAPSHOT,
  requestSourceReferenceOpen,
  type SourceReference,
  sourceReferenceLabel,
} from "../../store/source-reference.ts";
import { pushToast, useUi } from "../../store/ui.ts";
import {
  Button,
  cx,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
} from "../../ui/index.ts";

type Candidate = {
  reference: SourceReference;
  sessionId: string;
  dismiss: () => void;
};
let candidate: Candidate | null = null;

if (typeof document !== "undefined") {
  document.addEventListener("selectionchange", () => {
    if (!window.getSelection()?.isCollapsed) return;
    candidate?.dismiss();
    candidate = null;
  });
}

function addCandidate(next: Candidate): void {
  useUi.getState().requestComposerReference(next.reference, next.sessionId);
  next.dismiss();
  candidate = null;
  window.getSelection()?.removeAllRanges();
}

registerCommands([
  {
    id: "composer.addSelection",
    title: "Add Selection to Chat",
    group: "Composer",
    shortcut: "mod+shift+l",
    keywords: ["quote", "reference", "context"],
    when: () => candidate !== null,
    run: () => {
      if (candidate) addCandidate(candidate);
    },
  },
]);

function referenceIcon(ref: SourceReference): ReactNode {
  const cls = "size-3.5 shrink-0";
  switch (ref.kind) {
    case "transcript":
      return <MessageSquareQuote className={cls} />;
    case "file":
      return <FileCode2 className={cls} />;
    case "diff":
      return <GitCompareArrows className={cls} />;
    case "terminal":
      return <SquareTerminal className={cls} />;
  }
}

export function openSourceReference(ref: SourceReference): void {
  useSessions.getState().setActive(ref.sessionId);
  if (ref.kind === "transcript") {
    useUi.getState().requestJump(ref.sessionId, ref.eventSeq);
    return;
  }
  requestSourceReferenceOpen(ref);
}

export function ComposerReferences({
  references,
  onRemove,
  onNoteChange,
}: {
  references: readonly SourceReference[];
  onRemove: (id: string) => void;
  onNoteChange: (id: string, note: string) => void;
}) {
  if (references.length === 0) return null;
  return (
    <div className="flex gap-2 overflow-x-auto px-2.5 pt-2.5">
      {references.map((ref) => (
        <Popover key={ref.id}>
          <div className="flex h-8 max-w-64 shrink-0 items-center rounded-lg border border-border-subtle bg-raised text-xs text-fg-secondary">
            <PopoverTrigger>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 text-left hover:text-fg"
                aria-label={`Preview ${sourceReferenceLabel(ref)}`}
              >
                <span className="text-accent">{referenceIcon(ref)}</span>
                <span className="truncate">{sourceReferenceLabel(ref)}</span>
                {ref.note ? (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-accent"
                    aria-hidden="true"
                  />
                ) : null}
              </button>
            </PopoverTrigger>
            <button
              type="button"
              onClick={() => onRemove(ref.id)}
              className="flex size-8 shrink-0 items-center justify-center rounded-r-lg text-fg-muted hover:bg-fg/6 hover:text-fg"
              aria-label={`Remove ${sourceReferenceLabel(ref)}`}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <PopoverContent
            className="w-[min(26rem,calc(100vw-24px))] p-3"
            align="start"
          >
            <div className="flex items-center gap-2 text-xs font-medium text-fg">
              <span className="text-accent">{referenceIcon(ref)}</span>
              <span className="min-w-0 flex-1 truncate">
                {sourceReferenceLabel(ref)}
              </span>
            </div>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-inset p-2.5 font-mono text-xs leading-5 text-fg-secondary">
              {ref.snapshot}
            </pre>
            <label
              className="mt-3 block text-xs font-medium text-fg-secondary"
              htmlFor={`reference-note-${ref.id}`}
            >
              Note for the agent
              <Textarea
                id={`reference-note-${ref.id}`}
                value={ref.note ?? ""}
                onChange={(event) =>
                  onNoteChange(ref.id, event.currentTarget.value)
                }
                placeholder="Add note…"
                rows={2}
                maxLength={2000}
                className="mt-1 min-h-16 resize-y text-sm"
              />
            </label>
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => openSourceReference(ref)}
              >
                Go to source
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ))}
    </div>
  );
}

export function SentReferences({
  references,
}: {
  references: readonly SourceReference[];
}) {
  if (references.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {references.map((ref) => (
        <button
          key={ref.id}
          type="button"
          onClick={() => openSourceReference(ref)}
          className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-border-subtle bg-raised px-2 text-xs text-fg-secondary hover:border-border hover:text-fg"
          title={ref.note || ref.snapshot}
        >
          <span className="text-accent">{referenceIcon(ref)}</span>
          <span className="truncate">{sourceReferenceLabel(ref)}</span>
        </button>
      ))}
      {references
        .filter((ref) => ref.note)
        .map((ref) => (
          <div
            key={`${ref.id}:note`}
            className="basis-full text-xs text-fg-muted"
          >
            <span className="font-medium text-fg-secondary">
              {sourceReferenceLabel(ref)}:
            </span>{" "}
            {ref.note}
          </div>
        ))}
    </div>
  );
}

export type SelectionActionsProps = {
  children: ReactNode;
  sessionId: string;
  makeReference: (
    snapshot: string,
    selection: Selection,
    root: HTMLElement,
  ) => SourceReference | null;
  className?: string;
};

export function SelectionActions({
  children,
  sessionId,
  makeReference,
  className,
}: SelectionActionsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [action, setAction] = useState<{
    left: number;
    top: number;
    reference: SourceReference;
  } | null>(null);
  const dismiss = useCallback(() => setAction(null), []);

  const inspect = useCallback(() => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (
      !root ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      setAction(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    const snapshot = selection.toString().trim();
    if (!snapshot) return;
    if (snapshot.length > MAX_REFERENCE_SNAPSHOT) {
      setAction(null);
      pushToast({
        kind: "warn",
        title: "Selection is too large",
        detail: "Select less than 8,000 characters.",
      });
      return;
    }
    const reference = makeReference(snapshot, selection, root);
    if (!reference) return;
    const rect = range.getBoundingClientRect();
    const left = Math.max(
      12,
      Math.min(window.innerWidth - 12, rect.left + rect.width / 2),
    );
    const top = Math.max(12, rect.top - 8);
    candidate?.dismiss();
    candidate = { reference, sessionId, dismiss };
    setAction({ left, top, reference });
  }, [dismiss, makeReference, sessionId]);

  useEffect(() => {
    return () => {
      if (candidate?.dismiss === dismiss) candidate = null;
    };
  }, [dismiss]);

  const onPointerUp = (_event: PointerEvent<HTMLDivElement>) => {
    window.setTimeout(inspect, 0);
  };
  const onKeyUp = (_event: KeyboardEvent<HTMLDivElement>) => inspect();
  const add = () => {
    if (action)
      addCandidate({ reference: action.reference, sessionId, dismiss });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: pointer/key-up observe native text selection; the child content remains independently semantic.
    <div
      ref={rootRef}
      className={cx("relative", className)}
      onPointerUp={onPointerUp}
      onKeyUp={onKeyUp}
    >
      {children}
      {action
        ? createPortal(
            <div
              className="fixed z-50 flex -translate-x-1/2 -translate-y-full items-center rounded-lg border border-border bg-overlay p-1 shadow-md"
              style={{ left: action.left, top: action.top }}
              role="toolbar"
              aria-label="Text selection actions"
              onPointerDown={(event) => event.preventDefault()}
            >
              <button
                type="button"
                onClick={add}
                className="flex min-h-8 items-center rounded-md px-2.5 text-xs font-medium text-fg hover:bg-raised max-md:min-h-11 max-md:px-3"
              >
                Add to chat
              </button>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard.writeText(action.reference.snapshot)
                }
                className="flex min-h-8 items-center rounded-md px-2.5 text-xs text-fg-secondary hover:bg-raised hover:text-fg max-md:min-h-11 max-md:px-3"
              >
                Copy
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function selectedLineRange(
  selection: Selection,
  root: HTMLElement,
  selector = "[data-source-line]",
): { startLine: number; endLine: number } | null {
  if (selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const lines = [...root.querySelectorAll<HTMLElement>(selector)].filter(
    (line) => {
      try {
        return range.intersectsNode(line);
      } catch {
        return false;
      }
    },
  );
  const numbers = lines
    .map((line) => Number(line.dataset.sourceLine))
    .filter((line) => Number.isInteger(line) && line > 0);
  if (numbers.length === 0) return null;
  return { startLine: Math.min(...numbers), endLine: Math.max(...numbers) };
}

export function selectedDiffRanges(
  selection: Selection,
  root: HTMLElement,
): Pick<
  Extract<SourceReference, { kind: "diff" }>,
  "side" | "oldRange" | "newRange"
> {
  if (selection.rangeCount === 0) return { side: "mixed" };
  const range = selection.getRangeAt(0);
  const rows = [
    ...root.querySelectorAll<HTMLElement>(".diff-line[data-state]"),
  ].filter((row) => {
    try {
      return range.intersectsNode(row);
    } catch {
      return false;
    }
  });
  const oldLines: number[] = [];
  const newLines: number[] = [];
  for (const row of rows) {
    const old = row.querySelector<HTMLElement>(
      "[data-line-old-num], .diff-line-old-num [data-line-num]",
    );
    const next = row.querySelector<HTMLElement>(
      "[data-line-new-num], .diff-line-new-num [data-line-num]",
    );
    const oldLine = Number(old?.dataset.lineOldNum ?? old?.dataset.lineNum);
    const newLine = Number(next?.dataset.lineNewNum ?? next?.dataset.lineNum);
    if (Number.isInteger(oldLine) && oldLine > 0) oldLines.push(oldLine);
    if (Number.isInteger(newLine) && newLine > 0) newLines.push(newLine);
  }
  const toRange = (lines: number[]) =>
    lines.length > 0
      ? { startLine: Math.min(...lines), endLine: Math.max(...lines) }
      : undefined;
  const oldRange = toRange(oldLines);
  const newRange = toRange(newLines);
  return {
    side:
      oldRange && newRange
        ? "mixed"
        : oldRange
          ? "old"
          : newRange
            ? "new"
            : "mixed",
    ...(oldRange ? { oldRange } : {}),
    ...(newRange ? { newRange } : {}),
  };
}
