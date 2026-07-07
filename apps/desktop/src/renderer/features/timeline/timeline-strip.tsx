// Timeline strip (plan §7.4): filter chips + a density bar over the full seq
// range. Dots are rawEvents bucketed by pixel; clicking one jumps the
// transcript and selects the event for the inspector.
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useTranscripts, useUi } from "../../store/index.ts";
import { cx } from "../../ui/index.ts";

// ---- shared filter state ------------------------------------------------------

export type TimelineFilter =
  | "all"
  | "agent"
  | "tools"
  | "terminal"
  | "approvals"
  | "snapshots"
  | "errors";

export type TimelineFilterStore = {
  filter: TimelineFilter;
  setFilter: (filter: TimelineFilter) => void;
};

/** Shared so TranscriptPane can filter blocks by the same chip selection. */
export const useTimelineFilter = create<TimelineFilterStore>((set) => ({
  filter: "all",
  setFilter: (filter) => set({ filter }),
}));

/** failed / denied / aborted suffixes (covers snapshot.restore_failed). */
const ERRORISH = /[._](failed|denied|aborted)$/;

export function matchesTimelineFilter(
  type: string,
  filter: TimelineFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "agent":
      return type.startsWith("message.") || type.startsWith("run.");
    case "tools":
      return type.startsWith("tool.call.");
    case "terminal":
      return type.startsWith("terminal.");
    case "approvals":
      return type.startsWith("approval.");
    case "snapshots":
      return type.startsWith("snapshot.");
    case "errors":
      return ERRORISH.test(type);
  }
}

// ---- dot color coding -----------------------------------------------------------

/** Cluster color priority: lower rank wins when seqs share a pixel bucket. */
const RANK_CLS = [
  "bg-err", // error-ish
  "bg-warn", // approval
  "bg-accent", // user
  "bg-ok", // snapshot
  "bg-info", // tool
  "bg-ink-dim", // assistant
  "bg-ink-mute", // marker / everything else
] as const;

function rankOf(type: string): number {
  if (ERRORISH.test(type)) return 0;
  if (type.startsWith("approval.")) return 1;
  if (type === "message.user.created") return 2;
  if (type.startsWith("snapshot.")) return 3;
  if (type.startsWith("tool.call.")) return 4;
  if (type.startsWith("message.assistant.")) return 5;
  return 6;
}

// ---- strip ----------------------------------------------------------------------

const FILTERS: ReadonlyArray<{ id: TimelineFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "agent", label: "Agent" },
  { id: "tools", label: "Tools" },
  { id: "terminal", label: "Terminal" },
  { id: "approvals", label: "Approvals" },
  { id: "snapshots", label: "Snapshots" },
  { id: "errors", label: "Errors" },
];

/** 2px dot + 1px gap. */
const DOT_PITCH = 3;

type Dot = {
  left: number;
  seq: number;
  cls: string;
  label: string;
  cluster: boolean;
};

export function TimelineStrip({ sessionId }: { sessionId: string }) {
  // rawEvents ref only changes on durable appends — frames never re-render this.
  const rawEvents = useTranscripts((s) => s.bySession[sessionId]?.rawEvents);
  const lastSeq = useTranscripts((s) => s.bySession[sessionId]?.lastSeq ?? 0);
  const filter = useTimelineFilter((s) => s.filter);
  const setFilter = useTimelineFilter((s) => s.setFilter);

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

  const dots = useMemo<Dot[]>(() => {
    if (
      !rawEvents ||
      rawEvents.length === 0 ||
      buckets === 0 ||
      lastSeq === 0
    ) {
      return [];
    }
    type Acc = {
      firstSeq: number;
      lastSeq: number;
      count: number;
      rank: number;
      type: string;
    };
    const byBucket = new Map<number, Acc>();
    for (const r of rawEvents) {
      if (!matchesTimelineFilter(r.type, filter)) continue;
      const i = Math.min(
        buckets - 1,
        Math.floor(((r.seq - 1) / lastSeq) * buckets),
      );
      const rank = rankOf(r.type);
      const cur = byBucket.get(i);
      if (cur === undefined) {
        byBucket.set(i, {
          firstSeq: r.seq,
          lastSeq: r.seq,
          count: 1,
          rank,
          type: r.type,
        });
      } else {
        cur.lastSeq = r.seq;
        cur.count += 1;
        if (rank < cur.rank) {
          cur.rank = rank;
          cur.type = r.type;
        }
      }
    }
    return [...byBucket.entries()].map(([i, b]) => ({
      left: i * DOT_PITCH,
      seq: b.firstSeq,
      cls: RANK_CLS[b.rank] ?? "bg-ink-mute",
      label:
        b.count === 1
          ? `${b.type} · #${b.firstSeq}`
          : `${b.count} events · #${b.firstSeq}–#${b.lastSeq}`,
      cluster: b.count > 1,
    }));
  }, [rawEvents, lastSeq, buckets, filter]);

  const jumpTo = (seq: number) => {
    const ui = useUi.getState();
    ui.requestJump(sessionId, seq);
    ui.setSelected({ sessionId, seq });
  };

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-surface px-2">
      {/* biome-ignore lint/a11y/useSemanticElements: segmented control; fieldset default styling fights the flex layout */}
      <div
        role="group"
        aria-label="Timeline filters"
        className="flex shrink-0 items-center gap-0.5"
      >
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cx(
              "h-[18px] rounded-full border px-1.5 text-[11px] leading-none transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
              filter === f.id
                ? "border-accent/40 bg-accent/10 text-accent"
                : "border-transparent text-ink-mute hover:bg-raised hover:text-ink-dim",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div
        ref={barRef}
        className="relative h-full min-w-0 flex-1 overflow-hidden"
      >
        {!rawEvents || rawEvents.length === 0 ? (
          <span className="absolute inset-y-0 left-0 flex items-center text-[11px] text-ink-mute">
            No events yet
          </span>
        ) : (
          // ponytail: native title tooltips — a radix Tooltip per dot is ~hundreds
          // of extra nodes; upgrade to <Tooltip> if design review demands.
          dots.map((d) => (
            <button
              key={d.left}
              type="button"
              title={d.label}
              aria-label={`Jump to ${d.label}`}
              onClick={() => jumpTo(d.seq)}
              style={{ left: d.left }}
              className={cx(
                "absolute top-1/2 w-[2px] -translate-y-1/2 rounded-full transition-transform hover:scale-x-[2.5] hover:scale-y-110",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                d.cluster ? "h-3" : "h-2",
                d.cls,
              )}
            />
          ))
        )}
      </div>
    </div>
  );
}
