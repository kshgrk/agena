// Renderer-side access to the bridge. Selection, in priority order:
//   1. `?mock` in the URL forces the mock world (skips preload AND ws config)
//   2. Electron preload (window.agenaPreload) adapted into a full AgenaBridge
//   3. window.agena already installed (mock or a test bridge)
//   4. a saved WS connection (localStorage "agena.connection") → WsBridge
//   5. nothing → ensureBridge() installs the mock (bare-browser `pnpm dev`)
import type {
  AgenaBridge,
  AgenaPreload,
  PtyHandle,
} from "../../shared/bridge.ts";
import { createWsBridge, getWsConfig } from "./ws-bridge.ts";

// the connect feature reads/writes the daemon connection through these
export { getWsConfig, setWsConfig, type WsConfig } from "./ws-bridge.ts";

let cached: AgenaBridge | null = null;

/** `?mock` forces the mock bridge even under Electron / with a saved WS config. */
function mockForced(): boolean {
  if (typeof location === "undefined") return false;
  return new URLSearchParams(location.search).has("mock");
}

/** Null-safe accessor (store modules use this; pure reducers stay Node-safe). */
export function peekBridge(): AgenaBridge | null {
  if (cached) return cached;
  if (typeof window === "undefined") return null;
  if (!mockForced() && window.agenaPreload) {
    cached = adaptPreload(window.agenaPreload);
    return cached;
  }
  if (window.agena) {
    // under ?mock this is the installed mock; otherwise a test-provided bridge
    cached = window.agena;
    return cached;
  }
  if (!mockForced()) {
    const cfg = getWsConfig();
    if (cfg) {
      cached = createWsBridge(cfg);
      return cached;
    }
  }
  return null;
}

export function getBridge(): AgenaBridge {
  const bridge = peekBridge();
  if (!bridge) {
    throw new Error(
      "no bridge installed. Run inside Electron (preload), save a WS connection, or call ensureBridge() first to install the mock bridge.",
    );
  }
  return bridge;
}

export async function ensureBridge(): Promise<AgenaBridge> {
  const existing = peekBridge();
  if (existing) return existing;
  const { installMockBridge } = await import("../mock/install.ts");
  await installMockBridge();
  return getBridge();
}

/** Adapt the thin preload transport into the full AgenaBridge. */
function adaptPreload(p: AgenaPreload): AgenaBridge {
  // PTY ports hop from the preload via window.postMessage transfer; they can
  // arrive before openPty's invoke resolves, so stash-or-wait keyed by ptyId.
  const ports = new Map<string, MessagePort>();
  const waiters = new Map<string, (port: MessagePort) => void>();
  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { type?: unknown; ptyId?: unknown } | null;
    const port = e.ports[0];
    if (d?.type !== "agena:pty-port" || typeof d.ptyId !== "string" || !port) {
      return;
    }
    const waiter = waiters.get(d.ptyId);
    if (waiter) {
      waiters.delete(d.ptyId);
      waiter(port);
    } else {
      ports.set(d.ptyId, port);
    }
  });

  const call =
    (method: string) =>
    async (...args: unknown[]): Promise<unknown> => {
      const res = await p.invoke(method, args);
      if (res.ok) return res.value;
      throw Object.assign(new Error(res.error.message), res.error);
    };

  const openPty = async (opts: unknown): Promise<PtyHandle> => {
    const { ptyId } = (await call("openPty")(opts)) as { ptyId: string };
    const stashed = ports.get(ptyId);
    if (stashed) {
      ports.delete(ptyId);
      return { ptyId, port: stashed };
    }
    const port = await new Promise<MessagePort>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        waiters.delete(ptyId);
        reject(new Error("pty port transfer timed out"));
      }, 10_000);
      waiters.set(ptyId, (got) => {
        window.clearTimeout(timer);
        resolve(got);
      });
    });
    return { ptyId, port };
  };

  return new Proxy({} as AgenaBridge, {
    get(_target, prop) {
      if (prop === "onBatch") return p.onBatch;
      if (prop === "onStatus") return p.onStatus;
      if (prop === "onBrowserState") return p.onBrowserState;
      if (prop === "openPty") return openPty;
      if (typeof prop !== "string") return undefined;
      // never look callable for promise/serialization protocol probes — a
      // callable `then` makes `await bridge` treat the proxy as a thenable
      if (
        prop === "then" ||
        prop === "catch" ||
        prop === "finally" ||
        prop === "toJSON"
      ) {
        return undefined;
      }
      return call(prop);
    },
  });
}
