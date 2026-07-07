// Renderer-side access to the bridge. Under Electron the preload exposes
// window.agenaPreload (the real daemon transport) which we adapt into an
// AgenaBridge; in a bare browser (pnpm dev) ensureBridge() installs the mock.
import type {
  AgenaBridge,
  AgenaPreload,
  PtyHandle,
} from "../../shared/bridge.ts";

let cached: AgenaBridge | null = null;

/** Null-safe accessor (store modules use this; pure reducers stay Node-safe). */
export function peekBridge(): AgenaBridge | null {
  if (cached) return cached;
  if (typeof window === "undefined") return null;
  if (window.agenaPreload) {
    cached = adaptPreload(window.agenaPreload);
    return cached;
  }
  if (window.agena) {
    cached = window.agena;
    return cached;
  }
  return null;
}

export function getBridge(): AgenaBridge {
  const bridge = peekBridge();
  if (!bridge) {
    throw new Error(
      "no bridge installed. Run inside Electron (preload) or call ensureBridge() first to install the mock bridge.",
    );
  }
  return bridge;
}

export async function ensureBridge(): Promise<AgenaBridge> {
  if (cached || window.agenaPreload || window.agena) return getBridge();
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
