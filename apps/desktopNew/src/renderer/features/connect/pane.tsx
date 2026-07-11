// Full-screen connect surface — the shell renders this instead of the
// workbench when no daemon connection was ever established. Two host modes:
//   Electron — pick a profile from listProfiles() and connect(profile).
//   Browser  — daemon URL + token form persisted via setWsConfig(); bridge
//              selection happens once at boot, so saving a new config reloads.
// Plus a "try the demo" escape hatch onto the mock bridge (?mock).
import { FlaskConical, Plug, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ProfileSummary } from "../../../shared/bridge.ts";
import { getBridge, getWsConfig, peekBridge, setWsConfig } from "../../lib/bridge.ts";
import { formatBridgeError } from "../../lib/errors.ts";
import {
  connectAndBootstrap,
  savePersistedPatch,
  useConnection,
} from "../../store/index.ts";
import {
  Badge,
  Button,
  cx,
  Input,
  Spinner,
  StatusDot,
} from "../../ui/index.ts";

const isElectron = (): boolean =>
  typeof window !== "undefined" &&
  window.agenaPreload !== undefined &&
  !new URLSearchParams(window.location.search).has("mock");

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

export function ConnectPane() {
  const state = useConnection((s) => s.state);
  const detail = useConnection((s) => s.detail);
  const busy = state === "connecting" || state === "reconnecting";

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-canvas p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6">
        <div className="flex items-center gap-2">
          <Plug className="size-4 text-fg-muted" />
          <h1 className="text-lg font-semibold text-fg">Connect to Agena</h1>
        </div>
        <p className="mt-1 text-sm text-fg-muted">
          {isElectron()
            ? "Pick a daemon profile to connect to."
            : "Point this browser at a running Agena daemon."}
        </p>

        <div className="mt-4 flex items-center gap-2 text-sm text-fg-secondary">
          <StatusDot className={STATE_DOT[state]} label={STATE_LABEL[state]} />
          <span>{STATE_LABEL[state]}</span>
          {busy ? <Spinner className="size-3.5" /> : null}
        </div>

        {state === "closed" && detail ? (
          <div className="mt-2 rounded-md border border-danger/35 bg-danger/10 px-2.5 py-2 text-xs text-danger">
            {detail}
          </div>
        ) : null}

        <div className="mt-4">
          {isElectron() ? <ProfileList busy={busy} /> : <WsForm busy={busy} />}
        </div>

        <div className="mt-5 border-t border-border-subtle pt-3 text-xs text-fg-muted">
          <FlaskConical className="mr-1 inline size-3.5 align-[-2px]" />
          No daemon handy?{" "}
          <a href="?mock" className="text-accent hover:underline">
            Try the demo (mock bridge)
          </a>
          .
        </div>
      </div>
    </div>
  );
}

// ---- Electron: profile picker -------------------------------------------------

function ProfileList({ busy }: { busy: boolean }) {
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setProfiles(await getBridge().listProfiles());
    } catch (err) {
      setProfiles([]);
      setLoadError(formatBridgeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = (name: string) => {
    // remembered as the boot-time default for the next launch
    savePersistedPatch({ activeProfile: name });
    void connectAndBootstrap(name);
  };

  if (profiles === null) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-fg-muted">
        <Spinner className="size-3.5" /> Loading profiles…
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {loadError ? (
        <div className="rounded-md border border-danger/35 bg-danger/10 px-2.5 py-2 text-xs text-danger">
          {loadError}
        </div>
      ) : null}
      {profiles.length === 0 && !loadError ? (
        <div className="py-2 text-sm text-fg-muted">
          No profiles configured — check ~/.config/agena/config.json.
        </div>
      ) : null}
      {profiles.map((p) => (
        <div
          key={p.name}
          className="flex items-center gap-2 rounded-lg border border-border-subtle p-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-fg">
                {p.name}
              </span>
              {p.isDefault ? <Badge tone="accent">default</Badge> : null}
            </div>
            <div className="truncate font-mono text-xs text-fg-muted">
              {p.url}
            </div>
          </div>
          <Button
            size="sm"
            variant={p.isDefault ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => connect(p.name)}
          >
            Connect
          </Button>
        </div>
      ))}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw />}
          disabled={busy}
          onClick={() => void load()}
        >
          Reload profiles
        </Button>
      </div>
    </div>
  );
}

// ---- Browser: daemon URL + token form --------------------------------------------

function WsForm({ busy }: { busy: boolean }) {
  const saved = getWsConfig();
  const [url, setUrl] = useState(saved?.url ?? "http://127.0.0.1:7777");
  const [token, setToken] = useState(saved?.token ?? "");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = url.trim();
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("bad protocol");
      }
    } catch {
      setFormError("Enter a valid http(s) daemon URL, e.g. http://127.0.0.1:7777");
      return;
    }
    setFormError(null);
    const cfg = { url: trimmed, token };
    const unchanged =
      saved !== null && saved.url === cfg.url && saved.token === cfg.token;
    if (unchanged && peekBridge()) {
      // same daemon, bridge already built — plain retry, no reload needed
      void connectAndBootstrap();
      return;
    }
    // bridge selection is decided once at boot (lib/ws-bridge.ts) → reload
    setWsConfig(cfg);
    window.location.reload();
  };

  const clear = () => {
    setWsConfig(null);
    window.location.reload();
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-fg-secondary">
          Daemon URL
        </span>
        <Input
          value={url}
          disabled={busy}
          placeholder="http://127.0.0.1:7777"
          autoFocus={saved === null}
          className={cx("font-mono", formError && "border-danger/35")}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-fg-secondary">
          Token <span className="text-fg-muted">(AGENA_TOKEN)</span>
        </span>
        <Input
          type="password"
          value={token}
          disabled={busy}
          placeholder="daemon bearer token"
          className="font-mono"
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      {formError ? (
        <div className="rounded-md border border-danger/35 bg-danger/10 px-2.5 py-2 text-xs text-danger">
          {formError}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        {saved !== null ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={clear}>
            Clear saved connection
          </Button>
        ) : null}
        <Button size="sm" variant="primary" type="submit" disabled={busy}>
          {saved !== null ? "Save & connect" : "Connect"}
        </Button>
      </div>
      <p className="text-xs text-fg-muted">
        Saved in this browser (localStorage). Local scans, native pickers, and
        the embedded browser stay desktop-only in this mode.
      </p>
    </form>
  );
}
