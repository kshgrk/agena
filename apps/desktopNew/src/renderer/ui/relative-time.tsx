import { useEffect, useReducer } from "react";
import { formatRelative } from "./format-relative.ts";

// One shared 30s interval for every mounted <RelativeTime/>.
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
