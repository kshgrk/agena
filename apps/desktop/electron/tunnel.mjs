// Host→container port tunnels for the embedded browser pane. Mirrors the PTY
// WS bridge (pty-manager.ts): the daemon's GET /v1/tunnels/:port/ws bridges a
// binary WS ↔ net.connect(127.0.0.1:port) inside the container. Here (main
// process) we run a local loopback TCP listener and pipe each connection
// through that WS with the bearer header. The WebContentsView loads the
// listener's http://127.0.0.1:<ephemeral> URL, so it's real host-loopback —
// HMR/WebSockets/cookies just work, no URL rewriting.
import net from "node:net";
import { WebSocket } from "ws";

/** http://localhost:PORT | 127.0.0.1:PORT | 0.0.0.0:PORT (any path) → PORT, else null. */
export function parseLocalPort(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:") return null;
  if (!["localhost", "127.0.0.1", "0.0.0.0"].includes(u.hostname)) return null;
  const port = Number(u.port);
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function createTunnelPool({ url, token }) {
  const wsBase = url.replace(/^http/, "ws").replace(/\/+$/, "");
  const tunnels = new Map(); // containerPort → { server, url, sockets:Set<net.Socket> }

  const ensureTunnel = (containerPort) => {
    const existing = tunnels.get(containerPort);
    if (existing) return Promise.resolve(existing.url);

    return new Promise((resolve, reject) => {
      const sockets = new Set();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        const ws = new WebSocket(`${wsBase}/v1/tunnels/${containerPort}/ws`, {
          headers: { authorization: `Bearer ${token}` },
        });
        ws.binaryType = "arraybuffer";

        // The socket can push bytes before the WS finishes connecting (same race
        // the PTY bridge guards against). Queue until open, drop if it dies.
        let wsOpen = false;
        const outbox = [];
        const teardown = () => {
          sockets.delete(socket);
          try {
            socket.destroy();
          } catch {
            /* already gone */
          }
          try {
            ws.close();
          } catch {
            /* already gone */
          }
        };
        ws.on("open", () => {
          wsOpen = true;
          for (const chunk of outbox) ws.send(chunk);
          outbox.length = 0;
        });
        ws.on("message", (data) => {
          try {
            socket.write(Buffer.from(data));
          } catch {
            teardown();
          }
        });
        ws.on("close", teardown);
        ws.on("error", teardown);
        socket.on("data", (buf) => {
          if (wsOpen) ws.send(buf);
          else outbox.push(buf);
        });
        socket.on("close", teardown);
        socket.on("error", teardown);
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const localUrl = `http://127.0.0.1:${server.address().port}`;
        tunnels.set(containerPort, { server, url: localUrl, sockets });
        resolve(localUrl);
      });
    });
  };

  const closeTunnel = (containerPort) => {
    const t = tunnels.get(containerPort);
    if (!t) return;
    tunnels.delete(containerPort);
    for (const s of t.sockets) {
      try {
        s.destroy();
      } catch {
        /* already gone */
      }
    }
    try {
      t.server.close();
    } catch {
      /* already gone */
    }
  };

  const closeAll = () => {
    for (const port of [...tunnels.keys()]) closeTunnel(port);
  };

  return { ensureTunnel, closeTunnel, closeAll };
}
