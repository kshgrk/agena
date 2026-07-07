import "./styles/theme.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EMPTY_PERSISTED } from "../shared/bridge.ts";
import { App } from "./app.tsx";
import { ensureBridge } from "./lib/bridge.ts";
import { connectAndBootstrap } from "./lib/connect.ts";
import { ingestBatch, useConnection, useUi } from "./store/index.ts";

function applyTheme(theme: "dark" | "light" | "system"): void {
  document.documentElement.dataset.theme =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
}

async function bootstrap(): Promise<void> {
  const bridge = await ensureBridge();
  const persisted = await bridge.loadPersisted().catch(() => EMPTY_PERSISTED);
  applyTheme(persisted.prefs.theme);
  useUi.setState({ theme: persisted.prefs.theme });

  // Wire the streams before connecting: nothing on the wire is ever missed.
  bridge.onBatch(ingestBatch);
  bridge.onStatus((state, detail) =>
    useConnection.getState().setStatus(state, detail),
  );

  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("#root element missing from index.html");
  createRoot(rootEl).render(
    <StrictMode>
      <App persisted={persisted} />
    </StrictMode>,
  );

  // Connect after first paint; failure keeps the shell usable (banner + toast).
  await connectAndBootstrap(persisted);
}

void bootstrap();
