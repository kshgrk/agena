// TCP-over-WS tunnel: bridges binary WS frames <-> net.connect(127.0.0.1:<port>)
// inside the container, so the host can load http://127.0.0.1:<ephemeral> and
// reach a dev server running in the container as if it were local-loopback.
// A clone of the PTY WS bridge (pty-manager.ts), minus the pty plumbing.

import type { IncomingMessage } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { WS_CLOSE_CODES } from "@agena/protocol";
import { type RawData, WebSocket, WebSocketServer } from "ws";

const CONNECT_TIMEOUT_MS = 10_000;

export class TunnelManager {
  readonly wss = new WebSocketServer({ noServer: true });
  readonly #sockets = new Set<net.Socket>();

  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    port: number,
  ): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      socket.write(
        "HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.#bridge(port, ws));
  }

  async close(): Promise<void> {
    for (const tcp of [...this.#sockets]) tcp.destroy();
    this.wss.close();
  }

  #bridge(port: number, ws: WebSocket): void {
    const tcp = net.connect({ host: "127.0.0.1", port });
    this.#sockets.add(tcp);
    const timer = setTimeout(() => {
      if (tcp.connecting) {
        tcp.destroy();
        if (ws.readyState === WebSocket.OPEN)
          ws.close(WS_CLOSE_CODES.goingAway, "tunnel connect failed");
      }
    }, CONNECT_TIMEOUT_MS);

    tcp.on("connect", () => clearTimeout(timer));
    // ponytail: simple unbounded pipe, ceiling is ws bufferedAmount memory
    // under a fast producer + slow consumer; add tcp.pause()/resume() on
    // ws.bufferedAmount thresholds (see pty-manager #onData) if it bites.
    tcp.on("data", (chunk) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
    });
    tcp.on("close", () => {
      clearTimeout(timer);
      this.#sockets.delete(tcp);
      if (ws.readyState === WebSocket.OPEN)
        ws.close(WS_CLOSE_CODES.normal, "tunnel closed");
    });
    tcp.on("error", () => {
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN)
        ws.close(WS_CLOSE_CODES.goingAway, "tunnel error");
    });

    ws.on("message", (data: RawData, isBinary) => {
      if (isBinary) tcp.write(toBuffer(data));
    });
    ws.on("close", () => tcp.destroy());
    ws.on("error", () => tcp.destroy());
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
