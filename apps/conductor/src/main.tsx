import "../../desktopNew/src/renderer/styles/theme.css";
import { ulid } from "@agena/client";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Connection = { url: string; token: string };
const CONNECTION_KEY = "agena.connection";
const CLIENT_ID_KEY = "agena.clientId";

async function readConnection(): Promise<Connection | null> {
  const value = await SecureStorage.get(CONNECTION_KEY);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Date
  )
    return null;
  const url = value.url;
  const token = value.token;
  return typeof url === "string" && typeof token === "string"
    ? { url, token }
    : null;
}

async function saveConnection(connection: Connection | null): Promise<void> {
  if (connection) await SecureStorage.set(CONNECTION_KEY, connection);
  else await SecureStorage.remove(CONNECTION_KEY);
}

async function clientId(): Promise<string> {
  const existing = await SecureStorage.get(CLIENT_ID_KEY);
  if (typeof existing === "string") return existing;
  const id = ulid();
  await SecureStorage.set(CLIENT_ID_KEY, id);
  return id;
}

function pairingParts(value: string): { url: string; token: string } {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "agena:" || parsed.hostname !== "pair") {
    throw new Error("This is not an Agena pairing link.");
  }
  const url = parsed.searchParams.get("url");
  const token = parsed.searchParams.get("token");
  if (!url || !token) throw new Error("The pairing link is incomplete.");
  const daemon = new URL(url);
  if (daemon.protocol !== "https:") {
    throw new Error("The daemon URL must use HTTPS.");
  }
  return { url: daemon.toString().replace(/\/$/, ""), token };
}

function PairingScreen({ initialUrl }: { initialUrl?: string }) {
  const [link, setLink] = useState(initialUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redeem = useCallback(async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const pairing = pairingParts(value);
      const response = await fetch(`${pairing.url}/v1/pairings/redeem`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${pairing.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId: await clientId(),
          deviceName: `${Capacitor.getPlatform()} phone`,
          platform: Capacitor.getPlatform(),
        }),
      });
      if (!response.ok) throw new Error("Pairing expired or was already used.");
      const body = (await response.json()) as {
        daemonUrl: string;
        token: string;
      };
      await saveConnection({ url: body.daemonUrl, token: body.token });
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let remove: (() => Promise<void>) | undefined;
    void CapacitorApp.addListener("appUrlOpen", ({ url }) => {
      if (active) void redeem(url);
    }).then((handle) => {
      remove = () => handle.remove();
    });
    return () => {
      active = false;
      void remove?.();
    };
  }, [redeem]);

  useEffect(() => {
    if (initialUrl) void redeem(initialUrl);
  }, [initialUrl, redeem]);

  return (
    <main className="flex min-h-full items-center justify-center bg-canvas p-6 pt-[env(safe-area-inset-top)] text-fg">
      <form
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void redeem(link);
        }}
      >
        <p className="text-xs font-medium uppercase tracking-widest text-accent">
          Agena Conductor
        </p>
        <h1 className="mt-2 text-2xl font-semibold">Pair this phone</h1>
        <p className="mt-2 text-sm leading-6 text-fg-muted">
          Scan the QR shown by Agena Desktop with your phone camera. If it does
          not open automatically, paste the pairing link below.
        </p>
        <label
          className="mt-6 block text-sm font-medium"
          htmlFor="pairing-link"
        >
          Pairing link
        </label>
        <input
          id="pairing-link"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="agena://pair?..."
          className="mt-2 min-h-12 w-full rounded-lg border border-border bg-canvas px-3 text-sm outline-none focus:border-accent"
        />
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
        <button
          type="submit"
          disabled={busy || !link.trim()}
          className="mt-5 min-h-12 w-full rounded-lg bg-accent px-4 font-medium text-white disabled:opacity-50"
        >
          {busy ? "Pairing…" : "Pair phone"}
        </button>
      </form>
    </main>
  );
}

async function boot(): Promise<void> {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("#root element missing");
  const root = createRoot(rootElement);
  const connection = await readConnection();
  if (!connection) {
    const launch = await CapacitorApp.getLaunchUrl();
    root.render(
      <StrictMode>
        <PairingScreen {...(launch?.url ? { initialUrl: launch.url } : {})} />
      </StrictMode>,
    );
    return;
  }

  globalThis.__AGENA_MOBILE__ = {
    connection,
    setConnection(next) {
      void saveConnection(next);
    },
  };
  const [{ App }, { ensureBridge }] = await Promise.all([
    import("../../desktopNew/src/renderer/app.tsx"),
    import("../../desktopNew/src/renderer/lib/bridge.ts"),
  ]);
  await ensureBridge();
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

declare global {
  var __AGENA_MOBILE__:
    | {
        connection: Connection | null;
        setConnection(connection: Connection | null): void;
      }
    | undefined;
}

void boot();
