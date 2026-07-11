// node --experimental-strip-types --test src/renderer/lib/ws-bridge.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PtyWsLike, WsLike } from "@agena/client";
import type { AgenaEvent, AgenaFrame } from "@agena/protocol";
import {
  EMPTY_PERSISTED,
  type PtyPortMessage,
  type UiBatch,
} from "../../shared/bridge.ts";
import { isDesktopOnlyError } from "./errors.ts";
import { createUiBatcher, createWsBridge, wirePtyPort } from "./ws-bridge.ts";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ---- batcher helpers ---------------------------------------------------------

function manualBatcher() {
  const batches: UiBatch[] = [];
  const flushes: Array<() => void> = [];
  const batcher = createUiBatcher(
    (b) => batches.push(b),
    (flush) => flushes.push(flush),
  );
  const flush = () => {
    for (const f of flushes.splice(0)) f();
  };
  return { batcher, batches, flush };
}

const textDelta = (
  messageId: string,
  blockIndex: number,
  delta: string,
  afterSeq = 1,
): AgenaFrame => ({
  sessionId: "s1",
  branchId: "b1",
  afterSeq,
  emittedAt: "2026-01-01T00:00:00.000Z",
  type: "message.assistant.text.delta",
  payload: { messageId, blockIndex, delta },
});

const toolDelta = (
  toolCallId: string,
  delta: string,
  reset = false,
  afterSeq = 1,
): AgenaFrame => ({
  sessionId: "s1",
  branchId: "b1",
  afterSeq,
  emittedAt: "2026-01-01T00:00:00.000Z",
  type: "tool.call.output.delta",
  payload: { toolCallId, delta, ...(reset ? { reset } : {}) },
});

const event = (seq: number): AgenaEvent => ({
  sessionId: "s1",
  branchId: "b1",
  seq,
  v: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  source: { kind: "daemon" },
  type: "session.title.changed",
  payload: { title: `t${seq}` },
});

// ---- coalescing rules ----------------------------------------------------------

test("text deltas coalesce by concatenation per (session,message,block)", () => {
  const { batcher, batches, flush } = manualBatcher();
  batcher.pushFrame(textDelta("m1", 0, "he", 1));
  batcher.pushFrame(textDelta("m1", 0, "llo", 2));
  batcher.pushFrame(textDelta("m1", 1, "x", 3));
  flush();
  assert.equal(batches.length, 1);
  const frames = batches[0]!.frames;
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0]!.payload, { messageId: "m1", blockIndex: 0, delta: "hello" });
  assert.equal(frames[0]!.afterSeq, 2); // afterSeq advances to the newest
  assert.deepEqual(frames[1]!.payload, { messageId: "m1", blockIndex: 1, delta: "x" });
});

test("tool deltas concatenate; reset discards the accumulation", () => {
  const { batcher, batches, flush } = manualBatcher();
  batcher.pushFrame(toolDelta("t1", "a"));
  batcher.pushFrame(toolDelta("t1", "b"));
  batcher.pushFrame(toolDelta("t2", "other"));
  batcher.pushFrame(toolDelta("t1", "R", true));
  batcher.pushFrame(toolDelta("t1", "S"));
  flush();
  const frames = batches[0]!.frames;
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0]!.payload, { toolCallId: "t1", delta: "RS", reset: true });
  assert.deepEqual(frames[1]!.payload, { toolCallId: "t2", delta: "other" });
});

test("events are never coalesced and keep arrival order", () => {
  const { batcher, batches, flush } = manualBatcher();
  batcher.pushEvent(event(1), true);
  batcher.pushEvent(event(2), false);
  flush();
  assert.deepEqual(
    batches[0]!.events.map((e) => [e.event.seq, e.replayed]),
    [
      [1, true],
      [2, false],
    ],
  );
});

test("coalescing never spans batches", () => {
  const { batcher, batches, flush } = manualBatcher();
  batcher.pushFrame(textDelta("m1", 0, "first"));
  flush();
  batcher.pushFrame(textDelta("m1", 0, "second"));
  flush();
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[1]!.frames[0]!.payload, {
    messageId: "m1",
    blockIndex: 0,
    delta: "second",
  });
});

test("unknown frame types pass through untouched", () => {
  const { batcher, batches, flush } = manualBatcher();
  const weird: AgenaFrame = {
    sessionId: "s1",
    branchId: "b1",
    afterSeq: 1,
    emittedAt: "2026-01-01T00:00:00.000Z",
    type: "future.frame",
    payload: { n: 1 },
  };
  batcher.pushFrame(weird);
  batcher.pushFrame({ ...weird, payload: { n: 2 } });
  batcher.pushSync({ sessionId: "s1", branchId: "b1", upToSeq: 4 });
  batcher.pushLostSession("gone");
  flush();
  const b = batches[0]!;
  assert.equal(b.frames.length, 2);
  assert.deepEqual(b.syncs, [{ sessionId: "s1", branchId: "b1", upToSeq: 4 }]);
  assert.deepEqual(b.lostSessions, ["gone"]);
});

test("default schedule flushes via the timer race when rAF never fires (hidden tab)", async () => {
  const g = globalThis as {
    requestAnimationFrame?: (cb: (t: number) => void) => number;
  };
  // hidden documents register rAF callbacks but never run them
  g.requestAnimationFrame = () => 0;
  try {
    const batches: UiBatch[] = [];
    const batcher = createUiBatcher((b) => batches.push(b)); // default schedule
    batcher.pushEvent(event(1), false);
    await tick(80); // > the 32ms timer fallback
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.events.length, 1);
  } finally {
    delete g.requestAnimationFrame;
  }
});

// ---- PTY port wiring ------------------------------------------------------------

type FakePty = PtyWsLike & {
  sent: Array<string | Uint8Array>;
  closed: { code?: number | undefined; reason?: string | undefined } | null;
};

function fakePtySocket(): FakePty {
  const sock: FakePty = {
    sent: [],
    closed: null,
    send(data) {
      sock.sent.push(data);
    },
    close(code, reason) {
      sock.closed = { code, reason };
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return sock;
}

test("wirePtyPort speaks the PtyPortMessage protocol over a fake socket", async () => {
  const sock = fakePtySocket();
  const port = wirePtyPort(sock);
  assert.equal(sock.binaryType, "arraybuffer");
  const received: PtyPortMessage[] = [];
  port.onmessage = (e: MessageEvent) => received.push(e.data as PtyPortMessage);

  // renderer traffic before the WS opens is queued, then flushed in order
  port.postMessage({ type: "resize", cols: 120, rows: 40 });
  port.postMessage({ type: "data", data: Uint8Array.from([104, 105]).buffer });
  await tick();
  assert.equal(sock.sent.length, 0);
  sock.onopen?.();
  assert.equal(sock.sent.length, 2);
  assert.equal(sock.sent[0], JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
  assert.deepEqual([...(sock.sent[1] as Uint8Array)], [104, 105]);

  // daemon binary frame → {type:"data"} with an ArrayBuffer
  sock.onmessage?.({ data: Uint8Array.from([111, 107]).buffer });
  // daemon exit control frame → {type:"exit", exitCode}
  sock.onmessage?.({ data: JSON.stringify({ type: "exit", exitCode: 3, signal: null }) });
  // non-exit text frames are ignored
  sock.onmessage?.({ data: "not json" });
  await tick();
  assert.equal(received.length, 2);
  assert.equal(received[0]!.type, "data");
  assert.deepEqual(
    [...new Uint8Array((received[0] as { data: ArrayBuffer }).data)],
    [111, 107],
  );
  assert.deepEqual(received[1], { type: "exit", exitCode: 3 });

  // renderer close → WS close(1000, "client close")
  port.postMessage({ type: "close" });
  await tick();
  assert.deepEqual(sock.closed, { code: 1000, reason: "client close" });

  // WS close → exit with null code and a reason, then the port shuts down
  sock.onclose?.({ code: 1006, reason: "" });
  await tick();
  assert.deepEqual(received.at(-1), { type: "exit", exitCode: null, reason: "close 1006" });
  port.close();
});

// ---- full bridge over a fake main socket ----------------------------------------

type FakeMain = WsLike & { url: string; protocols: string[]; sent: string[] };

test("createWsBridge: connect, subscribe, events+frames flow into one batch", async () => {
  const socks: FakeMain[] = [];
  const flushes: Array<() => void> = [];
  const bridge = createWsBridge(
    { url: "http://127.0.0.1:7777", token: "tok-1" },
    {
      createSocket: (url, init) => {
        const sock: FakeMain = {
          url,
          protocols: init.protocols ?? [],
          sent: [],
          send(data) {
            sock.sent.push(data);
          },
          close(code, reason) {
            sock.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
          },
          onopen: null,
          onmessage: null,
          onclose: null,
          onerror: null,
        };
        socks.push(sock);
        return sock;
      },
      schedule: (flush) => flushes.push(flush),
    },
  );

  const batches: UiBatch[] = [];
  bridge.onBatch((b) => batches.push(b));
  const statuses: string[] = [];
  bridge.onStatus((s) => statuses.push(s));

  const connecting = bridge.connect();
  const sock = socks[0]!;
  // browser WS auth: token rides as a query param; subprotocol is agena.v1
  assert.match(sock.url, /^ws:\/\/127\.0\.0\.1:7777\/v1\/ws\?token=tok-1$/);
  assert.deepEqual(sock.protocols, ["agena.v1"]);

  sock.onopen?.();
  const hello = JSON.parse(sock.sent[0]!) as {
    kind: string;
    protocolVersion: number;
    clientId: string;
  };
  assert.equal(hello.kind, "hello");
  assert.equal(hello.protocolVersion, 1);
  sock.onmessage?.({
    data: JSON.stringify({
      kind: "welcome",
      protocolVersion: 1,
      daemonVersion: "9.9.9",
      serverTime: "2026-01-01T00:00:00.000Z",
      limits: { maxEnvelopeBytes: 1, maxPromptBytes: 1, maxSubscriptions: 64 },
    }),
  });
  const info = await connecting;
  assert.equal(info.daemonVersion, "9.9.9");
  assert.equal(info.profile, "browser");
  assert.equal(info.clientId, hello.clientId);
  assert.deepEqual(statuses, ["connecting", "connected"]);

  // subscribe → ack carries the branchId later syncs ride on
  const subscribing = bridge.subscribe("s1", 0);
  const cmd = JSON.parse(sock.sent.at(-1)!) as { requestId: string; name: string };
  assert.equal(cmd.name, "subscribe");
  sock.onmessage?.({
    data: JSON.stringify({
      kind: "ack",
      requestId: cmd.requestId,
      result: { lastSeq: 2, branchId: "b1", replayCount: 2 },
    }),
  });
  const ack = await subscribing;
  assert.equal(ack.branchId, "b1");

  // replay: two events, sync, then live frames that coalesce
  sock.onmessage?.({ data: JSON.stringify({ kind: "event", replayed: true, event: event(1) }) });
  sock.onmessage?.({ data: JSON.stringify({ kind: "event", replayed: true, event: event(2) }) });
  sock.onmessage?.({
    data: JSON.stringify({ kind: "sync", sessionId: "s1", branchId: "b1", upToSeq: 2 }),
  });
  sock.onmessage?.({
    data: JSON.stringify({ kind: "frame", frame: textDelta("m1", 0, "he", 2) }),
  });
  sock.onmessage?.({
    data: JSON.stringify({ kind: "frame", frame: textDelta("m1", 0, "llo", 2) }),
  });

  assert.equal(flushes.length, 1); // one armed flush per unflushed batch
  for (const flush of flushes.splice(0)) flush();
  assert.equal(batches.length, 1);
  const batch = batches[0]!;
  assert.deepEqual(
    batch.events.map((e) => e.event.seq),
    [1, 2],
  );
  assert.deepEqual(batch.syncs, [{ sessionId: "s1", branchId: "b1", upToSeq: 2 }]);
  assert.equal(batch.frames.length, 1);
  assert.deepEqual(batch.frames[0]!.payload, { messageId: "m1", blockIndex: 0, delta: "hello" });

  await bridge.disconnect();
  assert.equal(statuses.at(-1), "closed");
});

test("commands before connect reject DISCONNECTED (retryable)", async () => {
  const bridge = createWsBridge({ url: "http://127.0.0.1:1", token: "" });
  await assert.rejects(bridge.prompt("s1", "hi"), (err: Error & { code: string; retryable: boolean }) => {
    assert.equal(err.code, "DISCONNECTED");
    assert.equal(err.retryable, true);
    return true;
  });
});

test("local-machine-only methods reject with DESKTOP_ONLY", async () => {
  const bridge = createWsBridge({ url: "http://127.0.0.1:1", token: "" });
  const desktopOnly = [
    bridge.importScan(),
    bridge.importRun({ projects: [] }),
    bridge.mcpImportScan(),
    bridge.mcpImportRun({ ids: [] }),
    bridge.skillImportScan(),
    bridge.skillImportRun({ ids: [] }),
    bridge.openProjectFolder(),
    bridge.browserOpen("http://localhost:3000"),
    bridge.browserNavigate({ kind: "back" }),
    bridge.browserSetBounds({ x: 0, y: 0, width: 1, height: 1 }),
    bridge.browserSetVisible(false),
    bridge.browserOpenDevTools(),
    bridge.browserOpenExternal(),
    bridge.browserClose(),
  ];
  for (const p of desktopOnly) {
    await assert.rejects(p, (err: Error & { code: string; retryable: boolean }) => {
      assert.equal(isDesktopOnlyError(err), true);
      assert.equal(err.retryable, false);
      return true;
    });
  }
  // subscription-shaped, so it returns an unsubscribe instead of rejecting
  const off = bridge.onBrowserState(() => {});
  assert.equal(typeof off, "function");
  off();
});

test("loadPersisted returns defaults when no storage exists", async () => {
  const bridge = createWsBridge({ url: "http://127.0.0.1:1", token: "" });
  assert.deepEqual(await bridge.loadPersisted(), EMPTY_PERSISTED);
  await bridge.savePersisted({ lastActiveSessionId: "s1" }); // no-op without storage
});
