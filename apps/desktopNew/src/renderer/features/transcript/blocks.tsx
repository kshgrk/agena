// Per-kind block renderings over the store Block types (design.md §6/§8):
// user = quiet surface card, assistant = bare prose on canvas, approvals
// inline (resolved state; live pending ones are actioned by the approvals
// feature's banner), runtime rows, marker rows, unknown types never crash.
// Settled blocks are memoized — only the streaming tail re-renders.
import type {
  ApprovalResponse,
  ContentBlock,
  UsageTotals,
} from "@agena/protocol";
import {
  AlertTriangle,
  Archive,
  Brain,
  Camera,
  Check,
  CircleHelp,
  Copy,
  CornerDownRight,
  Cpu,
  type LucideIcon,
  Paperclip,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Split,
  Terminal,
} from "lucide-react";
import { memo, type ReactNode, useEffect, useState } from "react";
import { peekBridge } from "../../lib/bridge.ts";
import { formatRelativeTime, formatTokens } from "../../lib/format.ts";
import type {
  ApprovalBlock,
  AssistantBlock,
  Block,
  MarkerBlock,
  MarkerKind,
  RuntimeBlock,
  UserBlock,
} from "../../store/types.ts";
import { Badge, cx } from "../../ui/index.ts";
import { SubagentReceipt } from "../agents/task-group.tsx";
import { Markdown } from "./markdown.tsx";
import { UserMessageActions } from "./session-actions.tsx";
import { ThinkingDisclosure } from "./thinking.tsx";
import { ToolCard, textOf } from "./tool-card.tsx";

// ---- shared -----------------------------------------------------------------

function TranscriptImage({
  block,
}: {
  block: Extract<ContentBlock, { type: "image" }>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    void peekBridge()
      ?.readBlob(block.ref.blob)
      .then((bytes) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(
          new Blob(
            [
              bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              ) as ArrayBuffer,
            ],
            { type: block.ref.mimeType ?? "application/octet-stream" },
          ),
        );
        setUrl(objectUrl);
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [block.ref.blob, block.ref.mimeType]);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="my-2 block w-fit">
      <img
        src={url}
        alt={block.alt ?? "Attached image"}
        loading="lazy"
        className="max-h-[28rem] max-w-full rounded-xl border border-border object-contain"
      />
    </a>
  ) : (
    <Badge className="my-1">
      <Paperclip className="size-3" />
      Loading image…
    </Badge>
  );
}

/** Text → markdown, thinking → disclosure, images → lazy previews, unknown → nothing. */
export function ContentView({ content }: { content: readonly ContentBlock[] }) {
  return (
    <>
      {content.map((b, i) => {
        const key = `${b.type}-${i}`;
        switch (b.type) {
          case "text":
            return <Markdown key={key} text={b.text} />;
          case "thinking":
            return <ThinkingDisclosure key={key} text={b.text} />;
          case "image":
            return <TranscriptImage key={key} block={b} />;
          case "file":
            return (
              <Badge key={key} className="my-1">
                <Paperclip className="size-3" />
                {b.path ?? "file"}
              </Badge>
            );
          case "toolCall":
            return null; // tool calls render as their own ToolCard rows
          default:
            return null; // unknown content types render nothing, never crash
        }
      })}
    </>
  );
}

/** Hover-revealed time + copy row (design.md §6: no inline timestamps). */
function HoverMeta({
  at,
  copyText,
  children,
}: {
  at: string;
  copyText: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="pointer-events-none absolute -top-4 right-0 flex items-center gap-1.5 opacity-0 transition-opacity duration-100 group-hover/turn:pointer-events-auto group-hover/turn:opacity-100">
      <span className="text-2xs tabular-nums text-fg-faint">
        {formatRelativeTime(at)}
      </span>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy message"}
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard?.writeText(copyText).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="flex size-5 items-center justify-center rounded-sm text-fg-faint transition-colors duration-100 hover:bg-fg/6 hover:text-fg-muted"
      >
        {copied ? (
          <Check className="size-3 text-success" />
        ) : (
          <Copy className="size-3" />
        )}
      </button>
      {children}
    </div>
  );
}

// ---- user ---------------------------------------------------------------------

function UserRow({
  block,
  sessionId,
}: {
  block: UserBlock;
  sessionId?: string;
}) {
  return (
    <div className="group/turn relative">
      <HoverMeta at={block.at} copyText={textOf(block.content)}>
        {sessionId ? (
          <UserMessageActions sessionId={sessionId} block={block} />
        ) : null}
      </HoverMeta>
      <div className="rounded-lg border border-border-subtle bg-surface px-4 py-3">
        {block.queued ? (
          <Badge tone="accent" className="mb-1.5">
            {block.queued === "steer" ? (
              <Split className="size-3" />
            ) : (
              <CornerDownRight className="size-3" />
            )}
            {block.queued === "steer"
              ? "Steer queued for this turn"
              : "Follow-up queued next"}
          </Badge>
        ) : null}
        <ContentView content={block.content} />
      </div>
    </div>
  );
}

// ---- assistant ------------------------------------------------------------------

function UsageFooter({ usage }: { usage: UsageTotals }) {
  return (
    <div className="mt-1.5 font-mono text-2xs tabular-nums text-fg-faint">
      {formatTokens(usage.inputTokens)} → {formatTokens(usage.outputTokens)} tok
      {usage.costUsd !== undefined ? ` · $${usage.costUsd.toFixed(3)}` : ""}
    </div>
  );
}

function AssistantRow({ block }: { block: AssistantBlock }) {
  return (
    <div className="group/turn relative">
      <HoverMeta at={block.at} copyText={textOf(block.content)} />
      <ContentView content={block.content} />
      {block.status === "aborted" ? (
        <Badge tone="warn" className="mt-1.5">
          aborted —{" "}
          {block.abortReason === "daemon_shutdown" ? "shutdown" : "user"}
        </Badge>
      ) : null}
      {block.status === "failed" ? (
        <div className="mt-1.5 flex items-center gap-2">
          <Badge tone="danger">failed — {block.error?.code ?? "unknown"}</Badge>
          {block.error?.message ? (
            <span className="text-xs text-danger">{block.error.message}</span>
          ) : null}
        </div>
      ) : null}
      {block.usage ? <UsageFooter usage={block.usage} /> : null}
    </div>
  );
}

// ---- approval -------------------------------------------------------------------

function responseSummary(response: ApprovalResponse): string {
  switch (response.kind) {
    case "confirm":
      return response.accepted ? "approved" : "denied";
    case "deny":
      return "denied";
    case "select":
      return `selected ${response.optionId}`;
    case "input":
    case "editor":
      return "responded";
  }
}

/**
 * Inline approval block. Resolved states render here in full; a PENDING one
 * renders as context (full subject, never truncated — design.md §8) while the
 * approvals feature owns the actionable banner/response UI.
 */
function ApprovalRow({ block }: { block: ApprovalBlock }) {
  const req = block.request;
  const pending = block.state === "pending";
  const dimmed = block.state === "expired" || block.state === "cancelled";

  const subjectRows: Array<[string, string]> = [];
  const s = req.subject;
  if (s) {
    // every present subject field, verbatim (D-INV-3)
    if (s.toolName !== undefined) subjectRows.push(["toolName", s.toolName]);
    if (s.command !== undefined) subjectRows.push(["command", s.command]);
    if (s.cwd !== undefined) subjectRows.push(["cwd", s.cwd]);
    if (s.action !== undefined) subjectRows.push(["action", s.action]);
    if (s.args !== undefined) {
      let json = "";
      try {
        json = JSON.stringify(s.args, null, 2) ?? "";
      } catch {
        json = String(s.args);
      }
      subjectRows.push(["args", json]);
    }
  }

  return (
    <div
      className={cx(
        "rounded-lg border p-3",
        pending
          ? "border-warn/35 bg-warn/10"
          : "border-border-subtle bg-surface",
        dimmed && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        {block.state === "responded" ? (
          block.response && responseSummary(block.response) === "denied" ? (
            <ShieldX className="size-4 shrink-0 text-fg-muted" />
          ) : (
            <ShieldCheck className="size-4 shrink-0 text-success" />
          )
        ) : (
          <ShieldAlert
            className={cx(
              "size-4 shrink-0",
              pending ? "text-warn" : "text-fg-muted",
            )}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
          {req.title ?? "Approval requested"}
        </span>
        {pending ? (
          <Badge tone="warn" className="animate-pulse-soft">
            pending
          </Badge>
        ) : null}
      </div>

      {req.message ? (
        <div className="mt-1 text-sm text-fg-secondary">{req.message}</div>
      ) : null}

      {subjectRows.length > 0 ? (
        <div className="mt-2 max-h-80 overflow-auto rounded-md bg-inset p-2.5">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-sm">
            {subjectRows.map(([k, v]) => (
              <div key={k} className="contents">
                <span className="text-fg-muted">{k}</span>
                <span className="whitespace-pre-wrap break-all text-fg">
                  {v}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {block.state === "responded" && block.response ? (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-success">
          <Check className="size-3" />
          {responseSummary(block.response)}
          {block.respondedBy ? (
            <span className="text-fg-muted">by {block.respondedBy}</span>
          ) : null}
        </div>
      ) : null}
      {block.state === "expired" ? (
        <div className="mt-2 text-xs text-fg-muted">expired unanswered</div>
      ) : null}
      {block.state === "cancelled" ? (
        <div className="mt-2 text-xs text-fg-muted">
          cancelled
          {block.cancelReason
            ? ` — ${block.cancelReason.replace(/_/g, " ")}`
            : ""}
        </div>
      ) : null}
    </div>
  );
}

// ---- runtime ---------------------------------------------------------------------

function RuntimeRow({ block }: { block: RuntimeBlock }) {
  const isBash = block.runtimeType === "bash";
  return (
    <div className="rounded-lg border border-border-subtle bg-surface px-3 py-2">
      <div className="flex items-center gap-2 text-2xs text-fg-muted">
        <Terminal className="size-3" />
        {block.runtimeType === "custom"
          ? (block.meta?.customType ?? "system")
          : block.runtimeType}
        {isBash &&
        block.meta?.exitCode !== undefined &&
        block.meta.exitCode !== null ? (
          <Badge tone={block.meta.exitCode === 0 ? "success" : "danger"}>
            exit {block.meta.exitCode}
          </Badge>
        ) : null}
      </div>
      {isBash && block.meta?.command ? (
        <div className="mt-1 font-mono text-sm text-fg">
          $ {block.meta.command}
        </div>
      ) : null}
      <div className="mt-1 whitespace-pre-wrap break-words font-mono text-sm text-fg-secondary">
        {textOf(block.content)}
      </div>
    </div>
  );
}

// ---- marker ----------------------------------------------------------------------

const markerIcon: Record<MarkerKind, LucideIcon> = {
  model: Cpu,
  thinking: Brain,
  compaction: Archive,
  "compaction-failed": Archive,
  "terminal-start": Terminal,
  "terminal-end": Terminal,
  "run-failed": AlertTriangle,
  session: Sparkles,
  snapshot: Camera,
  unknown: CircleHelp,
  malformed: CircleHelp,
};

function MarkerRow({ block }: { block: MarkerBlock }) {
  const Icon = markerIcon[block.markerKind] ?? CircleHelp;
  const warn =
    block.markerKind === "malformed" ||
    block.markerKind === "run-failed" ||
    block.markerKind === "compaction-failed";
  return (
    <div className="flex items-center gap-2 py-0.5">
      <div className="h-px flex-1 bg-border-subtle" />
      <Icon
        className={cx(
          "size-3.5 shrink-0",
          warn ? "text-warn" : "text-fg-muted",
        )}
      />
      <span className={cx("text-2xs", warn ? "text-warn" : "text-fg-muted")}>
        {block.text}
      </span>
      <div className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

// ---- dispatch --------------------------------------------------------------------

export type BlockViewProps = {
  block: Block;
  sessionId?: string;
  /** Tool-card grouping flags from rowMeta (design.md §7 stacked groups). */
  flushTop?: boolean;
  flushBottom?: boolean;
};

/** Memoized: settled blocks keep stable identity; only patched blocks re-render. */
export const BlockView = memo(function BlockView({
  block,
  sessionId,
  flushTop,
  flushBottom,
}: BlockViewProps) {
  switch (block.kind) {
    case "user":
      return sessionId ? (
        <UserRow block={block} sessionId={sessionId} />
      ) : (
        <UserRow block={block} />
      );
    case "assistant":
      return <AssistantRow block={block} />;
    case "tool":
      if (block.name === "subagent" && sessionId) {
        return (
          <SubagentReceipt
            parentSessionId={sessionId}
            parentToolCallId={block.toolCallId}
            running={block.status === "running"}
          />
        );
      }
      return (
        <ToolCard block={block} flushTop={flushTop} flushBottom={flushBottom} />
      );
    case "approval":
      return <ApprovalRow block={block} />;
    case "runtime":
      return <RuntimeRow block={block} />;
    case "marker":
      return <MarkerRow block={block} />;
    default:
      // forward-compat: an unknown block kind must never crash the transcript
      return null;
  }
});
