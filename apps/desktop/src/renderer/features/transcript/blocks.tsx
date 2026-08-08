// Per-kind block renderings (plan §7.3). Pure view layer over store Block types.
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
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Cpu,
  FilePen,
  FileText,
  type LucideIcon,
  Paperclip,
  Shield,
  ShieldX,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import type {
  ApprovalBlock,
  AssistantBlock,
  Block,
  MarkerBlock,
  MarkerKind,
  RuntimeBlock,
  ToolBlock,
  UserBlock,
} from "../../store/index.ts";
import {
  Badge,
  Button,
  CodeBlock,
  cx,
  StreamingDots,
  toast,
} from "../../ui/index.ts";
import { stripAnsi } from "./ansi.ts";
import { Markdown } from "./markdown.tsx";

// ---- shared helpers ----------------------------------------------------------

export function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function fmtDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function UsageFooter({ usage }: { usage: UsageTotals }) {
  return (
    <div className="mt-1 font-mono text-[10px] text-ink-mute">
      {fmtTok(usage.inputTokens)} → {fmtTok(usage.outputTokens)} tok
    </div>
  );
}

/** Collapsed-by-default disclosure for thinking content (transcript + tail). */
export function ThinkingDisclosure({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[11px] text-ink-mute hover:text-ink-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <Brain className="size-3" />
        Thinking
      </button>
      {open ? (
        <div className="mt-1 whitespace-pre-wrap border-l border-border pl-3 text-xs italic text-ink-mute">
          {text}
        </div>
      ) : null}
    </div>
  );
}

/** Text → markdown, thinking → disclosure, blobs → tiny chips. */
function ContentView({ content }: { content: readonly ContentBlock[] }) {
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
            return (
              <Badge key={key} className="my-1">
                <Paperclip className="size-2.5" />
                image{b.alt ? ` — ${b.alt}` : ""}
              </Badge>
            );
          case "file":
            return (
              <Badge key={key} className="my-1">
                <Paperclip className="size-2.5" />
                {b.path ?? "file"}
              </Badge>
            );
          case "toolCall":
            return null; // tool calls render as their own ToolBlock rows
          default:
            return null; // unknown content types render nothing, never crash
        }
      })}
    </>
  );
}

// ---- user ----------------------------------------------------------------------

function UserRow({ block }: { block: UserBlock }) {
  return (
    <div className="ml-auto max-w-[85%] rounded-lg border border-border bg-raised px-3 py-2">
      {block.queued ? (
        <Badge tone="accent" className="mb-1">
          {block.queued === "steer" ? "steer" : "follow-up"}
        </Badge>
      ) : null}
      <ContentView content={block.content} />
    </div>
  );
}

// ---- assistant ------------------------------------------------------------------

function AssistantRow({ block }: { block: AssistantBlock }) {
  return (
    <div>
      <ContentView content={block.content} />
      {block.status === "aborted" ? (
        <Badge tone="warn" className="mt-1.5">
          aborted —{" "}
          {block.abortReason === "daemon_shutdown" ? "shutdown" : "user"}
        </Badge>
      ) : null}
      {block.status === "failed" ? (
        <div className="mt-1.5 flex items-center gap-2">
          <Badge tone="err">failed — {block.error?.code ?? "unknown"}</Badge>
          {block.error?.message ? (
            <span className="text-xs text-err">{block.error.message}</span>
          ) : null}
        </div>
      ) : null}
      {block.usage ? <UsageFooter usage={block.usage} /> : null}
    </div>
  );
}

// ---- tool -----------------------------------------------------------------------

function toolIcon(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n.includes("bash") || n.includes("shell")) return Terminal;
  if (n.includes("edit") || n.includes("write")) return FilePen;
  if (n.includes("read")) return FileText;
  return Wrench;
}

function argSummary(args: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    for (const k of ["command", "path", "file_path", "filePath"]) {
      if (typeof a[k] === "string") return a[k];
    }
  }
  let json = "";
  try {
    json = JSON.stringify(args) ?? "";
  } catch {
    json = String(args);
  }
  return json.length > 80 ? `${json.slice(0, 79)}…` : json;
}

function ToolStatus({ block }: { block: ToolBlock }) {
  switch (block.status) {
    case "running":
      return <StreamingDots />;
    case "completed":
      return (
        <span className="flex items-center gap-1 text-[11px] text-ok">
          <Check className="size-3" />
          {block.durationMs !== undefined
            ? fmtDuration(block.durationMs)
            : null}
        </span>
      );
    case "failed":
      return (
        <span className="flex items-center gap-1 text-[11px] text-err">
          <X className="size-3" />
          {block.error?.code ?? "failed"}
        </span>
      );
    case "aborted":
      return <span className="text-[11px] text-warn">aborted</span>;
    case "denied":
      return (
        <span className="flex items-center gap-1 text-[11px] text-err">
          <ShieldX className="size-3" />
          {block.deniedReason ?? "denied"}
        </span>
      );
  }
}

/** Mono output with sticky follow-scroll while streaming and a 400-line fold. */
function ToolOutput({ text, streaming }: { text: string; streaming: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: text is the trigger (re-scroll on new output)
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && streaming && followRef.current) el.scrollTop = el.scrollHeight;
  }, [text, streaming]);

  if (!text) {
    return streaming ? null : (
      <div className="text-[11px] text-ink-mute">no output</div>
    );
  }
  const lines = text.split("\n");
  const folded = lines.length > 400 && !showAll;
  // ponytail: streaming fold keeps the tail (follow matters), finished keeps the head
  const shown = folded
    ? (streaming ? lines.slice(-400) : lines.slice(0, 400)).join("\n")
    : text;
  return (
    <div>
      <pre
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
        }}
        className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-app p-2 font-mono text-xs leading-5 text-ink-dim"
      >
        {shown}
      </pre>
      {folded ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1"
          onClick={() => setShowAll(true)}
        >
          show all ({lines.length} lines)
        </Button>
      ) : null}
    </div>
  );
}

function ToolRow({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const [showArgs, setShowArgs] = useState(false);
  const Icon = toolIcon(block.name);

  let argsJson = "";
  try {
    argsJson = JSON.stringify(block.args, null, 2) ?? "";
  } catch {
    argsJson = String(block.args);
  }
  const argsFolded = argsJson.split("\n").length >= 6 && !showArgs;

  const doneOutput = stripAnsi(
    textOf(block.result ?? block.partialOutput ?? []),
  );

  return (
    <div className="rounded border border-border bg-surface">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-ink-mute" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-ink-mute" />
        )}
        <Icon className="size-3.5 shrink-0 text-ink-dim" />
        <span className="shrink-0 font-mono text-xs text-ink">
          {block.name}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-mute">
          {argSummary(block.args)}
        </span>
        <span className="shrink-0">
          <ToolStatus block={block} />
        </span>
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border px-2 py-2">
          {argsFolded ? (
            <Button size="sm" variant="ghost" onClick={() => setShowArgs(true)}>
              show args ({argsJson.split("\n").length} lines)
            </Button>
          ) : (
            <CodeBlock code={argsJson} lang="json" />
          )}
          {block.status === "running" ? (
            <ToolOutput text={stripAnsi(block.liveOutput)} streaming />
          ) : (
            <ToolOutput text={doneOutput} streaming={false} />
          )}
          {block.status === "failed" && block.error ? (
            <div className="text-xs text-err">
              {block.error.code}: {block.error.message}
            </div>
          ) : null}
        </div>
      ) : null}
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

function ApprovalRow({
  block,
  sessionId,
}: {
  block: ApprovalBlock;
  sessionId: string;
}) {
  const [busy, setBusy] = useState(false);
  const req = block.request;

  const respond = (response: ApprovalResponse) => {
    setBusy(true);
    getBridge()
      .respondToApproval(sessionId, block.approvalId, response)
      .catch((err: unknown) => {
        const msg =
          typeof err === "object" && err !== null && "message" in err
            ? String((err as { message: unknown }).message)
            : "approval response failed";
        toast(msg, { tone: "err" });
      })
      .finally(() => setBusy(false));
  };

  const subject = req.subject;
  const subjectRows: Array<[string, string]> = [];
  if (subject) {
    // D-INV-3: every subject field verbatim
    if (subject.toolName !== undefined)
      subjectRows.push(["toolName", subject.toolName]);
    if (subject.command !== undefined)
      subjectRows.push(["command", subject.command]);
    if (subject.cwd !== undefined) subjectRows.push(["cwd", subject.cwd]);
    if (subject.action !== undefined)
      subjectRows.push(["action", subject.action]);
    if (subject.args !== undefined)
      subjectRows.push(["args", JSON.stringify(subject.args)]);
  }

  return (
    <div
      className={cx(
        "rounded border border-border border-l-2 border-l-accent bg-surface px-3 py-2",
        (block.state === "expired" || block.state === "cancelled") &&
          "opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        <Shield className="size-3.5 shrink-0 text-accent" />
        <span className="text-xs font-medium text-ink">
          {req.title ?? "Approval requested"}
        </span>
        {block.state === "pending" ? (
          <Badge tone="accent">pending</Badge>
        ) : null}
      </div>
      <div className="mt-1 text-[13px] text-ink-dim">{req.message}</div>
      {subjectRows.length > 0 ? (
        <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
          {subjectRows.map(([k, v]) => (
            <div key={k} className="contents">
              <span className="text-ink-mute">{k}</span>
              <span className="break-all text-ink">{v}</span>
            </div>
          ))}
        </div>
      ) : null}

      {block.state === "pending" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {req.kind === "confirm" ? (
            <>
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => respond({ kind: "confirm", accepted: false })}
              >
                Deny
              </Button>
              <Button
                variant="solid"
                size="sm"
                disabled={busy}
                onClick={() => respond({ kind: "confirm", accepted: true })}
              >
                Approve
              </Button>
            </>
          ) : null}
          {req.kind === "select"
            ? (req.options ?? []).map((opt) => (
                <Button
                  key={opt.id}
                  size="sm"
                  disabled={busy}
                  title={opt.description}
                  onClick={() => respond({ kind: "select", optionId: opt.id })}
                >
                  {opt.label}
                </Button>
              ))
            : null}
          {req.kind === "input" || req.kind === "editor" ? (
            // the approvals feature owns the input/editor modal; hand off
            <Button
              variant="solid"
              size="sm"
              disabled={busy}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("agena:open-approval", {
                    detail: { approvalId: block.approvalId },
                  }),
                )
              }
            >
              Review…
            </Button>
          ) : null}
        </div>
      ) : null}

      {block.state === "responded" && block.response ? (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-ok">
          <Check className="size-3" />
          {responseSummary(block.response)}
          {block.respondedBy ? (
            <span className="text-ink-mute">by {block.respondedBy}</span>
          ) : null}
        </div>
      ) : null}
      {block.state === "expired" ? (
        <div className="mt-2 text-xs text-ink-mute">expired unanswered</div>
      ) : null}
      {block.state === "cancelled" ? (
        <div className="mt-2 text-xs text-ink-mute">
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
    <div className="rounded border border-border bg-surface px-3 py-2 text-ink-dim">
      <div className="flex items-center gap-2 text-[11px] text-ink-mute">
        <Terminal className="size-3" />
        {block.runtimeType === "custom"
          ? (block.meta?.customType ?? "system")
          : block.runtimeType}
        {isBash &&
        block.meta?.exitCode !== undefined &&
        block.meta.exitCode !== null ? (
          <Badge tone={block.meta.exitCode === 0 ? "ok" : "err"}>
            exit {block.meta.exitCode}
          </Badge>
        ) : null}
      </div>
      {isBash && block.meta?.command ? (
        <div className="mt-1 font-mono text-xs text-ink">
          $ {block.meta.command}
        </div>
      ) : null}
      <div className="mt-1 whitespace-pre-wrap break-words font-mono text-xs">
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
  const Icon = markerIcon[block.markerKind];
  const warn =
    block.markerKind === "malformed" ||
    block.markerKind === "run-failed" ||
    block.markerKind === "compaction-failed";
  return (
    <div className="flex items-center gap-2 py-0.5">
      <div className="h-px flex-1 bg-border" />
      <Icon
        className={cx("size-3 shrink-0", warn ? "text-warn" : "text-ink-mute")}
      />
      <span className={cx("text-[11px]", warn ? "text-warn" : "text-ink-mute")}>
        {block.text}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

// ---- dispatch --------------------------------------------------------------------

export function BlockView({
  block,
  sessionId,
}: {
  block: Block;
  sessionId: string;
}) {
  switch (block.kind) {
    case "user":
      return <UserRow block={block} />;
    case "assistant":
      return <AssistantRow block={block} />;
    case "tool":
      return <ToolRow block={block} />;
    case "approval":
      return <ApprovalRow block={block} sessionId={sessionId} />;
    case "runtime":
      return <RuntimeRow block={block} />;
    case "marker":
      return <MarkerRow block={block} />;
  }
}
