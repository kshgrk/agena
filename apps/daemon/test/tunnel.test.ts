// Hermetic: real echo TCP server + real http.Server with TunnelManager on
// upgrade + real ws client. Send bytes through the WS, assert the echo comes
// back — proves the binary bidirectional bridge end to end.

import { createServer as createHttpServer, type Server } from "node:http";
import net from "node:net";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { TunnelManager } from "../src/tunnel-manager.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function listen(server: net.Server | Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

async function harness() {
  const echo = net.createServer((sock) => sock.pipe(sock));
  const echoPort = await listen(echo);
  cleanups.push(() => echo.close());

  const tunnels = new TunnelManager();
  const http = createHttpServer();
  http.on("upgrade", (req, socket, head) => {
    const port = Number(/\/v1\/tunnels\/(\d+)\/ws$/.exec(req.url ?? "")?.[1]);
    tunnels.handleUpgrade(req, socket, head, port);
  });
  const httpPort = await listen(http);
  cleanups.push(() => {
    void tunnels.close();
    http.close();
  });
  return { echoPort, httpPort };
}

test("bridges binary frames to the tcp target and back", async () => {
  const { echoPort, httpPort } = await harness();
  const ws = new WebSocket(
    `ws://127.0.0.1:${httpPort}/v1/tunnels/${echoPort}/ws`,
  );
  const got = new Promise<Buffer>((resolve) => {
    ws.on("open", () => ws.send(Buffer.from("hello tunnel"), { binary: true }));
    ws.on("message", (data) => resolve(data as Buffer));
  });
  expect((await got).toString()).toBe("hello tunnel");
  ws.close();
});

test("rejects an out-of-range port with a 400", async () => {
  const { httpPort } = await harness();
  const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/v1/tunnels/70000/ws`);
  const err = await new Promise<Error>((resolve) => ws.on("error", resolve));
  expect(err.message).toMatch(/400/);
});
