// Statusbar per design.md §5: 24px, bg-canvas, top hairline, text-2xs
// fg-muted, tabular-nums. Left: connection (dot + profile) · session status.
// Right: pending approvals · model · thinking level · quota or session cost.
import { Zap } from "lucide-react";
import type { ReactNode } from "react";
import type { BridgeConnectionState } from "../../shared/bridge.ts";
import { formatUsageStatus } from "../lib/runtime-status.ts";
import {
  pushToast,
  runCommand,
  useApprovals,
  useConnection,
  useSessions,
  useTranscripts,
} from "../store/index.ts";
import { OPEN_APPROVAL_EVENT } from "./panes.ts";

const CONN_LABEL: Record<BridgeConnectionState, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
};

/** Statusbar hover target — the only interaction styling statusbar items get. */
function BarButton({
  onClick,
  title,
  children,
}: {
  onClick?: () => void;
  title?: string | undefined;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-full items-center gap-1.5 px-1 transition-colors hover:text-fg-secondary"
    >
      {children}
    </button>
  );
}

function ConnectionItem() {
  const state = useConnection((s) => s.state);
  const detail = useConnection((s) => s.detail);
  const info = useConnection((s) => s.info);
  return (
    <BarButton
      title={detail ?? info?.url}
      onClick={() =>
        pushToast({
          kind: "info",
          title: info ? `Daemon at ${info.url}` : "Not connected",
          ...(info
            ? {
                detail: `${info.profile} · daemon ${info.daemonVersion} · protocol v${info.protocolVersion}`,
              }
            : detail
              ? { detail }
              : {}),
        })
      }
    >
      <span>
        {state === "connected" && info ? info.profile : CONN_LABEL[state]}
      </span>
    </BarButton>
  );
}

function SessionItem({ sessionId }: { sessionId: string }) {
  const session = useSessions((s) => s.byId[sessionId]);
  const running = useTranscripts((s) => {
    const rs = s.bySession[sessionId]?.runtimeStatus;
    return rs && rs.state !== "idle" ? rs.state : null;
  });
  if (!session) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-1">
      <span className="truncate">
        {session.title ?? `session ${session.sessionId.slice(-6)}`}
      </span>
      {running ? <span className="text-fg-faint">· {running}</span> : null}
    </div>
  );
}

function ApprovalsChip() {
  const count = useApprovals((s) => Object.keys(s.pending).length);
  if (count === 0) return null;
  const openOldest = () => {
    const pending = Object.values(useApprovals.getState().pending).sort(
      (a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.seq - b.seq,
    );
    const oldest = pending[0];
    if (!oldest) return;
    window.dispatchEvent(
      new CustomEvent(OPEN_APPROVAL_EVENT, {
        detail: { approvalId: oldest.approvalId },
      }),
    );
  };
  return (
    <BarButton onClick={openOldest} title="Review pending approvals">
      <span className="inline-flex items-center gap-1 rounded-full bg-warn/10 px-1.5 py-px font-medium text-warn">
        {count} approval{count === 1 ? "" : "s"}
      </span>
    </BarButton>
  );
}

function RuntimeItem({ sessionId }: { sessionId: string }) {
  const runtime = useConnection((s) => s.runtime[sessionId]);
  if (!runtime) return null;
  return (
    <BarButton
      title="Model · thinking level — click to change in the composer"
      onClick={() => runCommand("composer.focus")}
    >
      {runtime.fastMode?.active ? (
        <Zap className="size-3.5 text-warn" aria-label="Fast mode active" />
      ) : null}
      <span className="font-mono">
        {runtime.model ? runtime.model.id : "default model"} ·{" "}
        {runtime.thinkingLevel}
      </span>
    </BarButton>
  );
}

function UsageItem({ sessionId }: { sessionId: string }) {
  const runtime = useConnection((s) => s.runtime[sessionId]);
  const label = formatUsageStatus(
    runtime?.subscriptionUsage,
    runtime?.sessionUsage,
  );
  if (!label) return null;
  return (
    <span
      className="px-1 font-mono"
      title={
        runtime?.subscriptionUsage
          ? "ChatGPT Codex weekly quota remaining"
          : "Cumulative cost for this session"
      }
    >
      {label}
    </span>
  );
}

export function StatusBar() {
  const activeSessionId = useSessions((s) => s.activeSessionId);
  return (
    <footer className="flex h-6 shrink-0 items-center gap-2 border-t border-border-subtle bg-canvas px-2 text-2xs text-fg-muted tabular-nums">
      <ConnectionItem />
      {activeSessionId ? (
        <>
          <span className="text-fg-faint">·</span>
          <SessionItem sessionId={activeSessionId} />
        </>
      ) : null}
      <div className="min-w-0 flex-1" />
      <ApprovalsChip />
      {activeSessionId ? (
        <>
          <RuntimeItem sessionId={activeSessionId} />
          <UsageItem sessionId={activeSessionId} />
        </>
      ) : null}
    </footer>
  );
}
