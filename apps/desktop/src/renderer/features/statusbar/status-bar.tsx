// Status bar (plan §7.10): connection · profile/url · active session · model ·
// approvals · theme/version. 24px, dense, never a blocking spinner (FN-1).
import { Moon, Sun } from "lucide-react";
import type { BridgeConnectionState } from "../../../shared/bridge.ts";
import { useCommands } from "../../store/commands.ts";
import { useConnection, useSessions, useUi } from "../../store/index.ts";
import { cx, IconButton, StatusDot, Tooltip, toast } from "../../ui/index.ts";
import { ApprovalChip } from "../approvals/approvals-host.tsx";

const CONN_LABEL: Record<BridgeConnectionState, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
};

function hostPort(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function StatusBar() {
  const state = useConnection((s) => s.state);
  const detail = useConnection((s) => s.detail);
  const info = useConnection((s) => s.info);
  const session = useSessions((s) =>
    s.activeSessionId ? s.byId[s.activeSessionId] : undefined,
  );
  const runtime = useConnection((s) =>
    session ? s.runtime[session.sessionId] : undefined,
  );
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-2 overflow-hidden border-t border-border bg-surface px-2 text-[11px] text-ink-dim">
      <Tooltip content={detail ?? info?.url ?? "No daemon connection"}>
        <button
          type="button"
          onClick={() =>
            toast(info ? `Daemon at ${info.url}` : "Not connected", {
              tone: state === "connected" ? "neutral" : "warn",
            })
          }
          className={cx(
            "flex h-5 shrink-0 items-center gap-1.5 rounded px-1 transition-colors hover:bg-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
            state === "reconnecting" && "text-warn",
            state === "closed" && "text-err",
          )}
        >
          <StatusDot status={state} />
          {CONN_LABEL[state]}
        </button>
      </Tooltip>

      {info ? (
        <span className="shrink-0 text-ink-mute">
          {info.profile} · {hostPort(info.url)}
        </span>
      ) : null}

      {session ? (
        <>
          <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
          <span className="flex min-w-0 items-center gap-1.5">
            <StatusDot status={session.status} />
            <span className="truncate text-ink">
              {session.title ?? session.sessionId}
            </span>
          </span>
        </>
      ) : null}

      {runtime ? (
        <Tooltip content="Model · thinking level — click to change">
          <button
            type="button"
            onClick={() => useCommands.getState().run("composer.focus")}
            className="h-5 shrink-0 rounded px-1 font-mono text-ink-dim transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {runtime.model ? `${runtime.model.id} · ` : ""}
            {runtime.thinkingLevel}
          </button>
        </Tooltip>
      ) : null}

      <ApprovalChip />

      <span className="ml-auto flex shrink-0 items-center gap-2">
        <IconButton
          label={
            theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
          }
          size="sm"
          className="size-5"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Sun /> : <Moon />}
        </IconButton>
        {info ? (
          <span className="text-ink-mute">
            daemon {info.daemonVersion} · protocol v{info.protocolVersion}
          </span>
        ) : null}
      </span>
    </footer>
  );
}
