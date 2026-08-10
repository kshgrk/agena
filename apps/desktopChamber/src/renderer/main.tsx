import "./styles/theme.css";
import "./styles/openchamber.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { ensureBridge } from "./lib/bridge.ts";

async function boot(): Promise<void> {
  // Bridge first: Electron preload if present, otherwise the mock installs.
  // Everything downstream (store actions, App effects) can call getBridge().
  await ensureBridge();

  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("#root element missing from index.html");
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
