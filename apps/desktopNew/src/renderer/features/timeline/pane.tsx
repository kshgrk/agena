// Timeline: a compact horizontal density strip of the active session's durable
// events, color-coded by family. Click or brush (drag) to scroll the
// transcript; the strip always spans the full 1..lastSeq range so it live-
// follows streaming as durable events append (frames never re-render it —
// the rawEvents reference only changes on durable appends).
//
// Jump contract: `useUi.requestJump` is the transcript scroll-to request
// (store/types.ts `jump`); `transcript.jumpTo` is run as an optional
// flash/focus hook the transcript feature may register (no-op otherwise).
import { History } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { runCommand, useSessions, useTranscripts, useUi } from "../../store/index.ts";
import { EmptyState, Panel, PanelHeader, Segmented } from "../../ui/index.ts";
import {
  bucketize,
  EVENT_FAMILIES,
  familyCounts,
  seqAtFraction,
  TIMELINE_FILTERS,
  type TimelineFilter,
} from "./timeline-logic.ts";

/** 2px dot + 1px gap. */
const DOT_PITCH = 3;

export function TimelinePane() {
  const activeSessionId = useSessions((s) => s.activeSessionId);
  if (!activeSessionId) {
    return (
      <Panel>
        <PanelHeader title="Timeline" />
        <EmptyState
          icon={History}
          title="No session"
          hint="Pick a session to see its event timeline."
        />
      </Panel>
    );
  }
  return <TimelineStrip key={activeSessionId} sessionId={activeSessionId} />;
}

function TimelineStrip({ sessionId }: { sessionId: string }) {
  const rawEvents = useTranscripts((s) => s.bySession[sessionId]?.rawEvents);
  const lastSeq = useTranscripts((s) => s.bySession[sessionId]?.lastSeq ?? 0);
  const streaming = useTranscripts(
    (s) => s.bySession[sessionId]?.inFlight !== null,
  );
  const selectedSeq = useUi((s) =>
    s.selected?.sessionId === sessionId ? s.selected.seq : null,
  );
  const [filter, setFilter] = useState<TimelineFilter>("all");

  // pixel buckets track the strip's rendered width
  const barRef = useRef<HTMLDivElement | null>(null);
  const [buckets, setBuckets] = useState(0);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () =>
      setBuckets((prev) => {
        const n = Math.max(1, Math.floor(el.clientWidth / DOT_PITCH));
        return prev === n ? prev : n;
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = rawEvents ?? [];
  const dots = useMemo(
    () => bucketize(rows, lastSeq, buckets, filter),
    [rows, lastSeq, buckets, filter],
  );
  const counts = useMemo(() => familyCounts(rows), [rows]);

  const jumpTo = (seq: number) => {
    const ui = useUi.getState();
    ui.requestJump(sessionId, seq);
    ui.setSelected({ sessionId, seq });
    runCommand("transcript.jumpTo"); // optional hook, see header comment
  };

  // ---- brush: drag across the strip scrubs the transcript -------------------
  const brushing = useRef(false);
  const lastBrushSeq = useRef<number | null>(null);
  const brushAt = (clientX: number) => {
    const el = barRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const seq = seqAtFraction(rows, lastSeq, (clientX - rect.left) / rect.width);
    if (seq !== null && seq !== lastBrushSeq.current) {
      lastBrushSeq.current = seq;
      jumpTo(seq);
    }
  };

  // keyboard: step the selection through loaded events
  const stepSelected = (dir: 1 | -1) => {
    if (rows.length === 0) return;
    let i: number;
    if (selectedSeq === null) {
      i = dir === 1 ? 0 : rows.length - 1;
    } else {
      // nearest loaded index at or after the selected seq
      i = rows.findIndex((r) => r.seq >= selectedSeq);
      if (i < 0) i = rows.length - 1;
      i = Math.min(rows.length - 1, Math.max(0, i + dir));
    }
    const row = rows[i];
    if (row) jumpTo(row.seq);
  };

  return (
    <Panel>
      <PanelHeader
        title="Timeline"
        actions={
          <span className="text-2xs text-fg-muted tabular-nums">
            {rows.length} {rows.length === 1 ? "event" : "events"}
          </span>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <Segmented
          value={filter}
          onValueChange={setFilter}
          options={TIMELINE_FILTERS.map((f) => ({ value: f.id, label: f.label }))}
          ariaLabel="Timeline filters"
          className="self-start"
        />

        {/* the density strip — one brush surface, dots are decoration */}
        <div
          ref={barRef}
          role="slider"
          aria-label="Timeline brush — drag to scroll the transcript"
          aria-valuemin={1}
          aria-valuemax={Math.max(1, lastSeq)}
          aria-valuenow={selectedSeq ?? lastSeq}
          tabIndex={0}
          onPointerDown={(e) => {
            brushing.current = true;
            lastBrushSeq.current = null;
            e.currentTarget.setPointerCapture(e.pointerId);
            brushAt(e.clientX);
          }}
          onPointerMove={(e) => {
            if (brushing.current) brushAt(e.clientX);
          }}
          onPointerUp={() => {
            brushing.current = false;
          }}
          onPointerCancel={() => {
            brushing.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              stepSelected(-1);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              stepSelected(1);
            }
          }}
          className="relative h-10 w-full shrink-0 cursor-crosshair touch-none overflow-hidden rounded-md border border-border-subtle bg-inset"
        >
          {rows.length === 0 ? (
            <span className="absolute inset-0 flex items-center justify-center text-xs text-fg-muted">
              No events yet
            </span>
          ) : (
            <>
              {/* ponytail: native title tooltips — a radix Tooltip per dot is
                  hundreds of extra nodes; upgrade if design review demands. */}
              {dots.map((d) => (
                <span
                  key={d.index}
                  title={
                    d.count === 1
                      ? `${d.type} · #${d.firstSeq}`
                      : `${d.count} events · #${d.firstSeq}–#${d.lastSeq}`
                  }
                  style={{ left: d.index * DOT_PITCH }}
                  className={`absolute top-1/2 w-[2px] -translate-y-1/2 rounded-full ${
                    d.count > 1 ? "h-5" : "h-3"
                  } ${EVENT_FAMILIES[d.rank]?.dotClass ?? "bg-fg/35"}`}
                />
              ))}
              {streaming ? (
                <span
                  aria-hidden
                  className="absolute right-0.5 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-full bg-accent animate-pulse-soft"
                />
              ) : null}
            </>
          )}
        </div>

        {/* legend with live per-family counts */}
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {EVENT_FAMILIES.map((f, rank) =>
            (counts[rank] ?? 0) > 0 ? (
              <span
                key={f.label}
                className="inline-flex items-center gap-1.5 text-xs text-fg-muted"
              >
                <span className={`size-2 rounded-full ${f.dotClass}`} />
                {f.label}
                <span className="text-fg-faint tabular-nums">
                  {counts[rank]}
                </span>
              </span>
            ) : null,
          )}
        </div>
      </div>
    </Panel>
  );
}
