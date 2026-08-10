// The tool call card — the signature component (design.md §7, followed to the
// letter): 32px collapsed row with status glyph / mono name / one-line arg
// summary / right meta / chevron; expanded Input + Output/Error wells; every
// card starts collapsed; running border-accent/35; ANSI-colored live output
// from frames with pin-to-bottom follow. Structure adapted from ai-elements
// tool.tsx (https://github.com/vercel/ai-elements, Apache-2.0, © Vercel, Inc.
// — see docs/oss/LICENSES.md): 'ai' ToolUIPart states → @agena/protocol-driven
// ToolBlock states, shadcn cn → ui/cx, restyled to theme tokens.
import type { ContentBlock } from "@agena/protocol";
import {
  Ban,
  Check,
  ChevronDown,
  CircleDashed,
  FilePen,
  FileText,
  Globe,
  LoaderCircle,
  type LucideIcon,
  Search,
  ShieldX,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatDuration } from "../../lib/format.ts";
import { useApprovals } from "../../store/index.ts";
import type { ToolBlock } from "../../store/types.ts";
import { Button, cx } from "../../ui/index.ts";
import { type AnsiSpan, parseAnsi } from "./ansi.ts";
import { CodeBlock } from "./code-block.tsx";
import {
  argSummary,
  outputLineLabel,
  type ToolVisualState,
  toolVisualState,
} from "./layout.ts";

export type { ToolVisualState };

// ---- helpers -------------------------------------------------------------------

export function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function toolIcon(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n.includes("bash") || n.includes("shell") || n.includes("exec")) {
    return Terminal;
  }
  if (n.includes("edit") || n.includes("write")) return FilePen;
  if (n.includes("read") || n.includes("cat")) return FileText;
  if (
    n.includes("grep") ||
    n.includes("search") ||
    n.includes("find") ||
    n.includes("glob")
  ) {
    return Search;
  }
  if (
    n.includes("web") ||
    n.includes("fetch") ||
    n.includes("browser") ||
    n.includes("http")
  ) {
    return Globe;
  }
  return Wrench;
}

/** Live elapsed time while a card runs; freezes when inactive. */
function useElapsed(sinceIso: string, active: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  if (!active) return "";
  const ms = now - new Date(sinceIso).getTime();
  return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : "";
}

// ---- status glyph / meta (design.md §7 table) -----------------------------------

function StatusGlyph({ state }: { state: ToolVisualState }) {
  switch (state) {
    case "pending":
      return <CircleDashed className="size-4 shrink-0 text-tool-pending" />;
    case "running":
      return (
        <LoaderCircle className="size-4 shrink-0 animate-spin text-tool-running" />
      );
    case "success":
      return <Check className="size-4 shrink-0 text-tool-success" />;
    case "error":
      return <X className="size-4 shrink-0 text-tool-error" />;
    case "aborted":
      return <Ban className="size-4 shrink-0 text-tool-aborted" />;
    case "denied":
      return <ShieldX className="size-4 shrink-0 text-tool-denied" />;
  }
}

function Meta({
  state,
  block,
  elapsed,
}: {
  state: ToolVisualState;
  block: ToolBlock;
  elapsed: string;
}) {
  const output = outputLineLabel(
    textOf(block.result ?? block.partialOutput ?? []),
  );
  switch (state) {
    case "pending":
      return <span className="text-xs text-warn">waiting for approval</span>;
    case "running":
      return (
        <span className="text-xs tabular-nums text-fg-muted">{elapsed}</span>
      );
    case "success":
      return (
        <span className="text-xs tabular-nums text-fg-muted">
          done
          {block.durationMs !== undefined && block.durationMs > 0
            ? ` · ${formatDuration(block.durationMs)}`
            : ""}
          {output ? ` · ${output}` : ""}
        </span>
      );
    case "error":
      return (
        <span className="max-w-40 truncate text-xs text-danger">
          {block.error?.code ?? "failed"}
        </span>
      );
    case "aborted":
      return <span className="text-xs text-fg-muted">stopped</span>;
    case "denied":
      return (
        <span className="text-xs text-warn">
          {(block.deniedReason ?? "denied").replace(/_/g, " ")}
        </span>
      );
  }
}

// ---- ANSI output well -------------------------------------------------------------

const FOLD_LINES = 400;

/**
 * Last `n` lines of `text`, scanning newlines from the END so the per-frame
 * cost while output streams is bounded by the fold — never O(total output).
 */
export function tailLines(text: string, n: number): string {
  let i = text.length;
  for (let k = 0; k < n; k++) {
    const j = text.lastIndexOf("\n", i - 1);
    if (j === -1) return text; // fewer than n lines
    i = j;
  }
  return text.slice(i + 1);
}

function AnsiLine({ spans }: { spans: AnsiSpan[] }) {
  return (
    <>
      {spans.map((s, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional fragments of one string
          key={i}
          style={s.color ? { color: s.color } : undefined}
          className={cx(
            s.bold && "font-semibold",
            s.dim && "opacity-60",
            s.italic && "italic",
            s.underline && "underline",
          )}
        >
          {s.text}
        </span>
      ))}
    </>
  );
}

/**
 * Mono tool output with ANSI colors, sticky follow-scroll while streaming
 * (same pin rule as the transcript) and a 400-line fold — streaming keeps the
 * TAIL (follow matters), finished keeps the HEAD. Output appends with NO
 * animation (design.md streaming rules).
 */
export function ToolOutput({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: text is the trigger (re-pin on new output)
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && streaming && followRef.current) el.scrollTop = el.scrollHeight;
  }, [text, streaming]);

  if (!text) {
    return streaming ? null : (
      <div className="text-xs text-fg-muted">no output</div>
    );
  }
  // streaming keeps the TAIL (bounded scan from the end, per-frame safe);
  // finished keeps the HEAD (one split at settle time is fine)
  let shown = text;
  let foldedCount: number | null = null;
  if (!showAll) {
    if (streaming) {
      shown = tailLines(text, FOLD_LINES);
    } else {
      const lines = text.split("\n");
      if (lines.length > FOLD_LINES) {
        shown = lines.slice(0, FOLD_LINES).join("\n");
        foldedCount = lines.length;
      }
    }
  }
  const folded = shown.length < text.length;
  return (
    <div>
      <pre
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
        }}
        className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-inset p-2.5 font-mono text-sm text-fg"
      >
        <AnsiLine spans={parseAnsi(shown)} />
      </pre>
      {folded ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1"
          onClick={() => setShowAll(true)}
        >
          {foldedCount !== null
            ? `show all (${foldedCount} lines)`
            : "show all"}
        </Button>
      ) : null}
    </div>
  );
}

// ---- sections ----------------------------------------------------------------------

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-fg-muted">
      {children}
    </div>
  );
}

function InputSection({ args }: { args: unknown }) {
  // bash-style commands highlight as bash; everything else as JSON
  const command =
    args &&
    typeof args === "object" &&
    typeof (args as { command?: unknown }).command === "string"
      ? (args as { command: string }).command
      : null;
  let json = "";
  try {
    json = JSON.stringify(args, null, 2) ?? "";
  } catch {
    json = String(args);
  }
  return (
    <div>
      <SectionLabel>Input</SectionLabel>
      {command !== null ? (
        <CodeBlock bare code={command} language="bash" />
      ) : (
        <CodeBlock bare code={json} language="json" />
      )}
    </div>
  );
}

function OutputSection({
  block,
  state,
}: {
  block: ToolBlock;
  state: ToolVisualState;
}) {
  if (block.detailsState === "summary" || block.detailsState === "loading") {
    return (
      <div>
        <SectionLabel>Output</SectionLabel>
        <div className="text-xs text-fg-muted">
          {block.detailsState === "loading"
            ? "Loading full tool details…"
            : "Open this tool call to load its full output."}
        </div>
      </div>
    );
  }
  if (block.detailsState === "error") {
    return (
      <div>
        <SectionLabel>Output</SectionLabel>
        <div className="text-xs text-danger">
          Full tool details could not be loaded.
        </div>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div>
        <SectionLabel>Error</SectionLabel>
        <div className="max-h-80 overflow-auto rounded-md bg-danger/10 p-2.5">
          <div className="font-mono text-sm text-danger">
            {block.error
              ? `${block.error.code}: ${block.error.message}`
              : "failed"}
          </div>
          {block.partialOutput && block.partialOutput.length > 0 ? (
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-sm text-fg-secondary">
              <AnsiLine spans={parseAnsi(textOf(block.partialOutput))} />
            </pre>
          ) : null}
        </div>
      </div>
    );
  }
  if (state === "denied") {
    return (
      <div>
        <SectionLabel>Output</SectionLabel>
        <div className="text-xs text-fg-muted">
          denied — {(block.deniedReason ?? "not run").replace(/_/g, " ")}
        </div>
      </div>
    );
  }
  const live = state === "running" || state === "pending";
  const text = live
    ? block.liveOutput
    : textOf(block.result ?? block.partialOutput ?? []);
  return (
    <div>
      <SectionLabel>Output</SectionLabel>
      <ToolOutput text={text} streaming={live} />
    </div>
  );
}

// ---- the card -------------------------------------------------------------------------

export type ToolCardProps = {
  block: ToolBlock;
  /** Grouped with the previous/next same-tool success card (design.md §7). */
  flushTop?: boolean | undefined;
  flushBottom?: boolean | undefined;
  /** Chamber controls disclosure so the activity row has one source of truth. */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
};

export const ToolCard = memo(function ToolCard({
  block,
  flushTop = false,
  flushBottom = false,
  open: controlledOpen,
  onOpenChange,
}: ToolCardProps) {
  const hasPendingApproval = useApprovals((s) => {
    for (const p of Object.values(s.pending)) {
      if (p.request.toolCallId === block.toolCallId) return true;
    }
    return false;
  });
  const state = toolVisualState(block.status, hasPendingApproval);

  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };
  const elapsed = useElapsed(block.at, state === "running");
  const Icon = toolIcon(block.name);

  return (
    <div
      className={cx(
        "oc-tool-card border border-transparent bg-transparent",
        // grouped cards share one visual card: flush junction = the lower
        // card's top border only (the upper card drops its bottom border)
        flushTop ? "rounded-t-none border-t-border-subtle" : "rounded-t-lg",
        flushBottom ? "rounded-b-none border-b-0" : "rounded-b-lg",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-8 w-full items-center gap-2 rounded-[inherit] px-1.5 text-left transition-colors duration-100 hover:bg-raised/60"
      >
        <StatusGlyph state={state} />
        <Icon className="size-3.5 shrink-0 text-fg-muted" />
        <span
          className={cx(
            "shrink-0 font-mono text-sm",
            state === "running"
              ? "shimmer-text"
              : state === "aborted" || state === "denied"
                ? "text-fg-muted"
                : "text-fg-secondary",
          )}
        >
          {block.name}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg-muted">
          {argSummary(block.args)}
        </span>
        <span className="shrink-0">
          <Meta state={state} block={block} elapsed={elapsed} />
        </span>
        <ChevronDown
          className={cx(
            "size-4 shrink-0 text-fg-faint transition-transform duration-[140ms]",
            open && "rotate-180",
          )}
        />
      </button>
      <div
        className={cx(
          "grid ease-out",
          open
            ? "grid-rows-[1fr] transition-[grid-template-rows] duration-[180ms]"
            : "grid-rows-[0fr] transition-[grid-template-rows] duration-[140ms]",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {/* body mounts only while open: collapsed cards must not pay
              highlight/ANSI-parse cost (esp. per-frame while output streams).
              ponytail: close drops the 140ms collapse tween; open still animates */}
          {open ? (
            <div className="animate-fade-in space-y-3 border-t border-border-subtle p-3">
              <InputSection args={block.args} />
              <OutputSection block={block} state={state} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});
