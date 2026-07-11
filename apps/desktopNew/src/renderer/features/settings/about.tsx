// About section: what this app is talking to, and how.
import { useConnection } from "../../store/index.ts";
import { GroupLabel, ListCard, SectionHeader } from "./common.tsx";

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
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

/** Host mode is a boot-time fact — safe to read once at module scope. */
const HOST_MODE =
  typeof window !== "undefined" && window.agenaPreload
    ? "Desktop (Electron)"
    : "Browser (direct WebSocket)";

export function AboutSection() {
  const info = useConnection((s) => s.info);
  return (
    <div>
      <SectionHeader
        title="About"
        description="Agena — a local-feeling harness for remote agent sessions."
      />
      <GroupLabel>Versions</GroupLabel>
      <ListCard>
        <Row label="Host" value={HOST_MODE} />
        <Row label="Daemon" value={info?.daemonVersion ?? "not connected"} mono />
        <Row
          label="Protocol"
          value={info ? `v${info.protocolVersion}` : "not connected"}
          mono
        />
        <Row label="Profile" value={info?.profile ?? "—"} />
        <Row label="Daemon URL" value={info?.url ?? "—"} mono />
        <Row label="Client id" value={info?.clientId ?? "—"} mono />
      </ListCard>
    </div>
  );
}
