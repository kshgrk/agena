// Pure timeline projection: event-family classification, density bucketing,
// and brush math. Node-safe (no React/DOM) so it tests under
// `node --experimental-strip-types --test`. Ported from
// apps/desktop timeline-strip.tsx and re-tokenized for the new theme.

export type TimelineFilter =
  | "all"
  | "agent"
  | "tools"
  | "terminal"
  | "approvals"
  | "snapshots"
  | "errors";

export const TIMELINE_FILTERS: ReadonlyArray<{
  id: TimelineFilter;
  label: string;
}> = [
  { id: "all", label: "All" },
  { id: "agent", label: "Agent" },
  { id: "tools", label: "Tools" },
  { id: "terminal", label: "Term" },
  { id: "approvals", label: "Appr" },
  { id: "snapshots", label: "Snap" },
  { id: "errors", label: "Err" },
];

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

// ---- event families (rank = cluster priority; lower wins a shared pixel) ----

export type EventFamily = {
  /** Cluster priority — lower wins when seqs share a pixel bucket. */
  rank: number;
  label: string;
  /** bg-* theme-token utility for dots/legend swatches (design.md hard rule). */
  dotClass: string;
};

/** Rank-ordered families: error → approval → user → snapshot → tool → assistant → other. */
export const EVENT_FAMILIES: readonly EventFamily[] = [
  { rank: 0, label: "errors", dotClass: "bg-danger" },
  { rank: 1, label: "approvals", dotClass: "bg-warn" },
  { rank: 2, label: "user", dotClass: "bg-accent" },
  { rank: 3, label: "snapshots", dotClass: "bg-success" },
  { rank: 4, label: "tools", dotClass: "bg-info" },
  { rank: 5, label: "assistant", dotClass: "bg-fg/70" },
  { rank: 6, label: "other", dotClass: "bg-fg/35" },
];

export function rankOf(type: string): number {
  if (ERRORISH.test(type)) return 0;
  if (type.startsWith("approval.")) return 1;
  if (type === "message.user.created") return 2;
  if (type.startsWith("snapshot.")) return 3;
  if (type.startsWith("tool.call.")) return 4;
  if (type.startsWith("message.assistant.")) return 5;
  return 6;
}

export function familyOf(type: string): EventFamily {
  // rankOf always returns a valid index; the fallback keeps TS happy under
  // noUncheckedIndexedAccess.
  return EVENT_FAMILIES[rankOf(type)] ?? EVENT_FAMILIES[6]!;
}

// ---- density bucketing --------------------------------------------------------

export type TimelineBucket = {
  /** Pixel-bucket index (left = index * dotPitch). */
  index: number;
  firstSeq: number;
  lastSeq: number;
  count: number;
  /** Best (lowest) rank among the bucket's events. */
  rank: number;
  /** The type that won the rank contest (tooltip text). */
  type: string;
};

/**
 * Bucket seq-ascending rows into `buckets` horizontal slots over the 1..lastSeq
 * range. Rows failing the filter are skipped; empty buckets are omitted.
 */
export function bucketize(
  rows: ReadonlyArray<{ seq: number; type: string }>,
  lastSeq: number,
  buckets: number,
  filter: TimelineFilter,
): TimelineBucket[] {
  if (rows.length === 0 || buckets <= 0 || lastSeq <= 0) return [];
  const byBucket = new Map<number, TimelineBucket>();
  for (const r of rows) {
    if (!matchesTimelineFilter(r.type, filter)) continue;
    const index = Math.min(
      buckets - 1,
      Math.max(0, Math.floor(((r.seq - 1) / lastSeq) * buckets)),
    );
    const rank = rankOf(r.type);
    const cur = byBucket.get(index);
    if (cur === undefined) {
      byBucket.set(index, {
        index,
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
  return [...byBucket.values()].sort((a, b) => a.index - b.index);
}

/** Per-family counts for the legend, in EVENT_FAMILIES rank order. */
export function familyCounts(
  rows: ReadonlyArray<{ type: string }>,
): number[] {
  const counts = EVENT_FAMILIES.map(() => 0);
  for (const r of rows) {
    const rank = rankOf(r.type);
    counts[rank] = (counts[rank] ?? 0) + 1;
  }
  return counts;
}

/**
 * Brush math: pointer x-fraction over the strip → nearest loaded seq (rows are
 * seq-ascending). Returns null when nothing is loaded.
 */
export function seqAtFraction(
  rows: ReadonlyArray<{ seq: number }>,
  lastSeq: number,
  fraction: number,
): number | null {
  if (rows.length === 0 || lastSeq <= 0) return null;
  const f = Math.min(1, Math.max(0, fraction));
  const target = Math.max(1, Math.round(f * lastSeq));
  // binary search the first row with seq >= target, then pick the closer neighbor
  let lo = 0;
  let hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((rows[mid]?.seq ?? 0) < target) lo = mid + 1;
    else hi = mid;
  }
  const atOrAfter = rows[lo]?.seq ?? null;
  const before = lo > 0 ? (rows[lo - 1]?.seq ?? null) : null;
  if (atOrAfter === null) return before;
  if (before === null) return atOrAfter;
  return target - before < atOrAfter - target ? before : atOrAfter;
}
