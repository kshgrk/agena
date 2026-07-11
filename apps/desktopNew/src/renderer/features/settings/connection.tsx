// Connection section: active profile/URL, live connection state, theme
// preference, and the daemon diagnostics report (versions, protocol,
// workspace, .agena discovery with per-descriptor errors).
import type { DiagnosticsResponse, DiscoveryEntry } from "@agena/protocol";
import { useCallback } from "react";
import { getBridge } from "../../lib/bridge.ts";
import { formatDuration } from "../../lib/format.ts";
import { useConnection, useUi } from "../../store/index.ts";
import { Badge, type BadgeTone, Segmented, StatusDot } from "../../ui/index.ts";
import {
  Field,
  GroupLabel,
  InlineError,
  ListCard,
  LoadingRow,
  RefreshButton,
  SectionHeader,
  useLoad,
} from "./common.tsx";

const STATE_LABEL = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
} as const;

const STATE_DOT = {
  connecting: "bg-warn animate-pulse-soft",
  connected: "bg-success",
  reconnecting: "bg-warn animate-pulse-soft",
  closed: "bg-danger",
} as const;

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-2">
      <span className="shrink-0 text-xs text-fg-muted">{label}</span>
      <span
        className={
          mono
            ? "min-w-0 truncate font-mono text-sm text-fg"
            : "min-w-0 truncate text-sm text-fg"
        }
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

const DISCOVERY_TONE: Record<DiscoveryEntry["status"], BadgeTone> = {
  ok: "success",
  invalid: "danger",
  collision: "warn",
};

function DiscoveryReport({ entries }: { entries: readonly DiscoveryEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="p-3 text-sm text-fg-muted">
        No .agena tools, skills, or hooks discovered in the workspace.
      </div>
    );
  }
  return (
    <>
      {entries.map((e) => (
        <div key={`${e.kind}:${e.file}:${e.name}`} className="px-3 py-2">
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{e.kind}</Badge>
            <span className="min-w-0 truncate text-sm font-medium text-fg">
              {e.name}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-right font-mono text-sm text-fg-muted"
              title={e.file}
            >
              {e.file}
            </span>
            <Badge tone={DISCOVERY_TONE[e.status]}>{e.status}</Badge>
          </div>
          {e.reason ? (
            <div className="mt-1 text-xs text-danger">{e.reason}</div>
          ) : null}
        </div>
      ))}
    </>
  );
}

export function ConnectionSection() {
  const state = useConnection((s) => s.state);
  const detail = useConnection((s) => s.detail);
  const info = useConnection((s) => s.info);
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);

  const loadDiagnostics = useCallback(
    (_refresh: boolean): Promise<DiagnosticsResponse> => getBridge().diagnostics(),
    [],
  );
  const diag = useLoad(loadDiagnostics);

  return (
    <div>
      <SectionHeader
        title="Connection"
        description="Where this app is connected and what the daemon reports."
        actions={
          <RefreshButton disabled={diag.loading} onClick={() => void diag.reload()}>
            Refresh
          </RefreshButton>
        }
      />
      <div className="space-y-5">
        <div>
          <GroupLabel>Active profile</GroupLabel>
          <ListCard>
            <div className="flex items-center gap-2 px-3 py-2">
              <StatusDot className={STATE_DOT[state]} label={STATE_LABEL[state]} />
              <span className="text-sm font-medium text-fg">
                {STATE_LABEL[state]}
              </span>
              {detail ? (
                <span className="min-w-0 truncate text-xs text-fg-muted">
                  {detail}
                </span>
              ) : null}
            </div>
            {info ? (
              <>
                <InfoRow label="Profile" value={info.profile} />
                <InfoRow label="URL" value={info.url} mono />
                <InfoRow label="Client id" value={info.clientId} mono />
              </>
            ) : (
              <div className="px-3 py-2 text-sm text-fg-muted">
                No daemon connection yet.
              </div>
            )}
          </ListCard>
        </div>

        <Field
          label="Theme"
          hint="System follows your OS appearance. The terminal stays dark in both."
        >
          <Segmented
            ariaLabel="Theme"
            value={theme}
            onValueChange={setTheme}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "system", label: "System" },
            ]}
          />
        </Field>

        <div>
          <GroupLabel>Daemon diagnostics</GroupLabel>
          {diag.error ? (
            <InlineError error={diag.error} onRetry={() => void diag.reload()} />
          ) : diag.data === null ? (
            <ListCard>
              <LoadingRow />
            </ListCard>
          ) : (
            <div className="space-y-3">
              <ListCard>
                <InfoRow label="Daemon version" value={diag.data.daemon.version} mono />
                <InfoRow
                  label="Uptime"
                  value={formatDuration(diag.data.daemon.uptimeMs)}
                />
                <InfoRow
                  label="Protocol version"
                  value={`v${diag.data.protocol.version}`}
                />
                <InfoRow label="Workspace" value={diag.data.workspace.path} mono />
              </ListCard>
              <div>
                <GroupLabel>.agena discovery</GroupLabel>
                <ListCard>
                  <DiscoveryReport entries={diag.data.discovery.entries} />
                </ListCard>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
