// Pure inspector helpers (Node-safe, tested).

/** rawEvents is seq-ascending; binary search the exact seq. -1 when absent. */
export function indexOfSeq(
  rows: ReadonlyArray<{ seq: number }>,
  seq: number,
): number {
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

/** Stable pretty JSON for the payload well ("undefined" payloads included). */
export function payloadJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2) ?? "undefined";
}

/** "12:04:31" — events are dense; time-of-day beats relative time here. */
export function eventClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString(undefined, { hour12: false });
}
