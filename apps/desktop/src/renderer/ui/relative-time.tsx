import { useEffect, useReducer } from "react";

// One shared interval for every mounted <RelativeTime/>.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  timer ??= setInterval(() => {
    for (const l of listeners) l();
  }, 30_000);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** "just now" / "2m ago" / "3h ago" / "yesterday" / "3d ago" / locale date. */
export function formatRelative(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

export function RelativeTime({
  iso,
  className,
}: {
  iso: string;
  className?: string;
}) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribe(tick), []);
  return (
    <time
      dateTime={iso}
      title={new Date(iso).toLocaleString()}
      className={className}
    >
      {formatRelative(iso)}
    </time>
  );
}
