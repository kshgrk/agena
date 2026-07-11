// Small pure display formatters shared across features. No locale machinery —
// transcript/statusbar strings are deliberately compact and en-only for v1.

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Compact relative time: "just now", "5m ago", "2h ago", "3d ago", then a
 * short absolute date. Future timestamps render as "in 5m" etc.
 */
export function formatRelativeTime(
  when: string | number | Date,
  now: number = Date.now(),
): string {
  const t = new Date(when).getTime();
  if (Number.isNaN(t)) return "";
  const delta = now - t;
  const abs = Math.abs(delta);
  if (abs < 45_000) return "just now";
  let text: string;
  if (abs < HOUR) text = `${Math.round(abs / MINUTE)}m`;
  else if (abs < DAY) text = `${Math.round(abs / HOUR)}h`;
  else if (abs < 14 * DAY) text = `${Math.round(abs / DAY)}d`;
  else {
    const d = new Date(t);
    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    });
  }
  return delta >= 0 ? `${text} ago` : `in ${text}`;
}

/** Binary-scaled byte sizes: "0 B", "512 B", "1.5 KB", "3.2 MB", "1.1 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  const text = value >= 100 ? Math.round(value).toString() : value.toFixed(1);
  return `${trimZero(text)} ${units[unit]}`;
}

/** Token counts: 950 → "950", 12_340 → "12.3k", 1_200_000 → "1.2M". */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${trimZero((count / 1000).toFixed(1))}k`;
  return `${trimZero((count / 1_000_000).toFixed(1))}M`;
}

/** Durations: "820ms", "4.2s", "42s", "3m 12s", "1h 4m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${trimZero((ms / 1000).toFixed(1))}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function trimZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}
