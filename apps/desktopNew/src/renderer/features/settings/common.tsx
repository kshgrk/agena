// Shared scaffolding for settings sections: the load-state hook every section
// uses, section chrome per design.md §13, inline BridgeError rendering, and
// the DESKTOP_ONLY empty state for browser sessions.
import { MonitorSmartphone, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatBridgeError } from "../../lib/errors.ts";
import { Button, cx, EmptyState, Spinner } from "../../ui/index.ts";

// ---- load-state hook -----------------------------------------------------------

export type Loaded<T> = {
  data: T | null;
  loading: boolean;
  error: unknown;
  /** refresh=true forces a re-scan / daemon update-check where supported. */
  reload: (refresh?: boolean) => Promise<void>;
};

/**
 * Load-on-mount with refresh. `fn` must be referentially stable (useCallback).
 * A failed reload keeps the previous data so lists stay browsable; the error
 * renders alongside.
 */
export function useLoad<T>(fn: (refresh: boolean) => Promise<T>): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reload = useCallback(
    async (refresh = false) => {
      setLoading(true);
      setError(null);
      try {
        const next = await fn(refresh);
        if (alive.current) setData(next);
      } catch (err) {
        if (alive.current) setError(err);
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [fn],
  );
  useEffect(() => {
    void reload(false);
  }, [reload]);
  return { data, loading, error, reload };
}

// ---- section chrome ---------------------------------------------------------------

export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-fg">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-sm text-fg-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** 11px group label above a card/list (design.md §7 section-header spec). */
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-fg-muted">
      {children}
    </div>
  );
}

/** Bordered list container; children are the rows (divided, not gapped). */
export function ListCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "divide-y divide-border-subtle rounded-lg border border-border-subtle",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Label-above-control field per design.md §13. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-fg-secondary">{label}</div>
      {children}
      {hint ? <div className="mt-1 text-xs text-fg-muted">{hint}</div> : null}
    </div>
  );
}

export function RefreshButton({
  onClick,
  disabled,
  children = "Rescan",
}: {
  onClick: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      icon={<RefreshCw />}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

// ---- states -----------------------------------------------------------------------

/** Centered spinner for a list that has never loaded. */
export function LoadingRow() {
  return (
    <div className="flex h-24 items-center justify-center text-fg-muted">
      <Spinner />
    </div>
  );
}

/** Inline BridgeError box (code + message + retryable hint), with retry. */
export function InlineError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/35 bg-danger/10 p-3">
      <div className="min-w-0 text-sm text-danger">{formatBridgeError(error)}</div>
      {onRetry ? (
        <Button variant="ghost" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Empty state for Electron-only surfaces when running in a plain browser. */
export function DesktopOnlyState({ what }: { what: string }) {
  return (
    <EmptyState
      icon={MonitorSmartphone}
      title="Desktop app required"
      hint={`Scanning ${what} reads this machine's files, which needs the Agena desktop app. This browser session talks directly to the daemon.`}
      className="rounded-lg border border-border-subtle"
    />
  );
}

/** Quiet empty line inside a ListCard. */
export function EmptyRow({ children }: { children: ReactNode }) {
  return <div className="p-3 text-sm text-fg-muted">{children}</div>;
}
