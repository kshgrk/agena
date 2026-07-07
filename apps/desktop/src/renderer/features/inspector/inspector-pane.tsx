// Right inspector (plan §7.5): the raw canonical event for the current
// selection — payload JSON, provenance, derived timings. Also the debugging
// story for Agena itself.
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  MousePointerClick,
  SearchX,
  Timer,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { RawEventRow } from "../../store/index.ts";
import { useTranscripts, useUi } from "../../store/index.ts";
import {
  Badge,
  Button,
  CodeBlock,
  EmptyState,
  IconButton,
  PanelHeader,
  PanelShell,
  RelativeTime,
} from "../../ui/index.ts";

// ---- helpers --------------------------------------------------------------------

/** rawEvents is seq-ascending; binary search the exact seq. */
function indexOfSeq(rows: readonly RawEventRow[], seq: number): number {
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = rows[mid]?.seq ?? Number.NaN;
    if (s === seq) return mid;
    if (s < seq) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function num(payload: unknown, key: string): number | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

function str(payload: unknown, key: string): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Derived timing (plan §7.5): tool.call.* carry durationMs in the payload;
 * assistant terminal events measure back to their message.assistant.started.
 */
function derivedTiming(
  rows: readonly RawEventRow[],
  index: number,
): string | null {
  const row = rows[index];
  if (!row) return null;
  const durationMs = num(row.payload, "durationMs");
  if (durationMs !== undefined) return `duration ${fmtMs(durationMs)}`;
  if (
    row.type === "message.assistant.completed" ||
    row.type === "message.assistant.aborted" ||
    row.type === "message.assistant.failed"
  ) {
    const messageId = str(row.payload, "messageId");
    if (messageId === undefined) return null;
    for (let i = index - 1; i >= 0; i -= 1) {
      const r = rows[i];
      if (
        r !== undefined &&
        r.type === "message.assistant.started" &&
        str(r.payload, "messageId") === messageId
      ) {
        const ms = Date.parse(row.at) - Date.parse(r.at);
        return Number.isFinite(ms) && ms >= 0
          ? `${fmtMs(ms)} since started (#${r.seq})`
          : null;
      }
    }
  }
  return null;
}

type BlobNote = { path: string; ref: string };

/** Find blob-ref shapes ({ blob: "sha256:…" }) anywhere in the payload. */
function collectBlobRefs(
  value: unknown,
  path = "",
  out: BlobNote[] = [],
): BlobNote[] {
  if (out.length >= 8 || value === null || typeof value !== "object")
    return out;
  const rec = value as Record<string, unknown>;
  const blob = rec.blob;
  if (typeof blob === "string" && blob.startsWith("sha256:")) {
    out.push({ path, ref: blob });
    return out;
  }
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) {
      collectBlobRefs(v, `${path}[${i}]`, out);
    }
    return out;
  }
  for (const [k, v] of Object.entries(rec)) {
    collectBlobRefs(v, path === "" ? k : `${path}.${k}`, out);
  }
  return out;
}

function shortRef(ref: string): string {
  // "sha256:" + 12 hex chars = 19.
  return ref.length > 19 ? `${ref.slice(0, 19)}…` : ref;
}

function useCopied(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy: (text) => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    },
  };
}

// ---- pane -----------------------------------------------------------------------

export function InspectorPane() {
  const selected = useUi((s) => s.selected);
  const setSelected = useUi((s) => s.setSelected);
  const rawEvents = useTranscripts((s) =>
    selected ? s.bySession[selected.sessionId]?.rawEvents : undefined,
  );

  const index =
    selected && rawEvents ? indexOfSeq(rawEvents, selected.seq) : -1;
  const row = index >= 0 && rawEvents ? rawEvents[index] : undefined;
  const prev = index > 0 && rawEvents ? rawEvents[index - 1] : undefined;
  const next = index >= 0 && rawEvents ? rawEvents[index + 1] : undefined;

  return (
    <PanelShell>
      <PanelHeader
        title="Inspector"
        actions={
          selected && row !== undefined ? (
            <div className="flex items-center gap-0.5">
              <IconButton
                size="sm"
                label="Previous event"
                disabled={prev === undefined}
                onClick={() => {
                  if (prev) {
                    setSelected({
                      sessionId: selected.sessionId,
                      seq: prev.seq,
                    });
                  }
                }}
              >
                <ChevronUp />
              </IconButton>
              <IconButton
                size="sm"
                label="Next event"
                disabled={next === undefined}
                onClick={() => {
                  if (next) {
                    setSelected({
                      sessionId: selected.sessionId,
                      seq: next.seq,
                    });
                  }
                }}
              >
                <ChevronDown />
              </IconButton>
            </div>
          ) : null
        }
      />
      {!selected ? (
        <EmptyState
          icon={MousePointerClick}
          title="Select any event"
          hint="Click a transcript block or a timeline dot to inspect its raw payload."
        />
      ) : row === undefined ? (
        <EmptyState
          icon={SearchX}
          title={`Event #${selected.seq} not loaded`}
          hint="It may be outside the loaded range — scroll back in the transcript to page older events in."
        />
      ) : (
        <EventDetail rows={rawEvents ?? []} index={index} row={row} />
      )}
    </PanelShell>
  );
}

function EventDetail({
  rows,
  index,
  row,
}: {
  rows: readonly RawEventRow[];
  index: number;
  row: RawEventRow;
}) {
  const json = useMemo(
    () => JSON.stringify(row.payload, null, 2) ?? "null",
    [row.payload],
  );
  const blobs = useMemo(() => collectBlobRefs(row.payload), [row.payload]);
  const timing = useMemo(() => derivedTiming(rows, index), [rows, index]);
  const copyJson = useCopied();
  const copyClient = useCopied();
  const clientId = row.source.clientId;

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-ink"
          title={row.type}
        >
          {row.type}
        </span>
        <Badge>#{row.seq}</Badge>
        <RelativeTime
          iso={row.at}
          className="shrink-0 text-[11px] text-ink-mute"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          tone={
            row.source.kind === "user"
              ? "accent"
              : row.source.kind === "runtime"
                ? "info"
                : "neutral"
          }
        >
          {row.source.kind}
        </Badge>
        {row.source.runtime !== undefined ? (
          <Badge className="font-mono">{row.source.runtime}</Badge>
        ) : null}
        {clientId !== undefined ? (
          <span className="flex min-w-0 items-center gap-0.5">
            <span
              className="max-w-36 truncate font-mono text-[11px] text-ink-mute"
              title={clientId}
            >
              {clientId}
            </span>
            <IconButton
              size="sm"
              label="Copy client id"
              onClick={() => copyClient.copy(clientId)}
            >
              {copyClient.copied ? <Check className="text-ok" /> : <Copy />}
            </IconButton>
          </span>
        ) : null}
      </div>

      {timing !== null ? (
        <div className="flex items-center gap-1.5 text-xs text-ink-dim">
          <Timer className="size-3 shrink-0 text-ink-mute" />
          {timing}
        </div>
      ) : null}

      <div className="space-y-1.5">
        <div className="flex h-6 items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-ink-mute">
            Payload
          </span>
          <Button
            size="sm"
            variant="ghost"
            icon={copyJson.copied ? <Check className="text-ok" /> : <Copy />}
            onClick={() => copyJson.copy(json)}
          >
            {copyJson.copied ? "Copied" : "Copy JSON"}
          </Button>
        </div>
        {blobs.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {blobs.map((b) => (
              <Badge key={b.path} tone="info" className="max-w-full">
                <span className="truncate font-mono">
                  {b.path === "" ? "" : `${b.path}: `}blob {shortRef(b.ref)}
                </span>
                <span className="shrink-0 opacity-70">
                  (lazy fetch lands with M7)
                </span>
              </Badge>
            ))}
          </div>
        ) : null}
        <CodeBlock code={json} lang="json" />
      </div>
    </div>
  );
}
