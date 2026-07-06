// Suites 6 & 7, M1 subset (§13.5): real WS against an ephemeral port with the
// FakeRuntimeAdapter — zero model calls (P16).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeRuntimeAdapter } from "@agena/core/testing";
import type { WireEnvelope } from "@agena/protocol";
import {
  assistantTextDeltaSchema,
  DURABLE_BACKLOG_LIMIT_BYTES,
  FRAME_COALESCE_BUFFERED_BYTES,
  FRAME_DROP_BUFFERED_BYTES,
  PROTOCOL_VERSION,
  promptAckSchema,
  subscribeAckSchema,
  WS_SUBPROTOCOL,
  wireEnvelopeSchema,
} from "@agena/protocol";
import { SqliteEventStore } from "@agena/storage-sqlite";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { type DaemonConfig, loadConfig } from "../src/config.ts";
import { backpressureAction } from "../src/gateway.ts";
import { type Daemon, startDaemon } from "../src/server.ts";

const TOKEN = "test-token";

let daemons: Daemon[] = [];
let clients: TestClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const c of clients) c.ws.terminate();
  clients = [];
  for (const d of daemons) await d.close();
  daemons = [];
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function boot(
  adapter = new FakeRuntimeAdapter(),
  config: Partial<DaemonConfig> = {},
): Promise<Daemon> {
  const daemon = await startDaemon(
    {
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      runtime: "fake",
      workspaceDir: "/tmp",
      stateDir: "/tmp",
      storage: "memory",
      ...config,
    },
    adapter,
  );
  daemons.push(daemon);
  return daemon;
}

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agena-daemon-"));
  dirs.push(dir);
  return dir;
}

async function closeDaemon(daemon: Daemon): Promise<void> {
  daemons = daemons.filter((d) => d !== daemon);
  await daemon.close();
}

type EventEnv = Extract<WireEnvelope, { kind: "event" }>;
const isEvent = (m: WireEnvelope): m is EventEnv => m.kind === "event";

class TestClient {
  ws: WebSocket;
  msgs: WireEnvelope[] = [];
  #waiters: Array<{
    pred: (m: WireEnvelope) => boolean;
    resolve: (m: WireEnvelope) => void;
  }> = [];

  constructor(port: number, token = TOKEN) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, WS_SUBPROTOCOL, {
      headers: { authorization: `Bearer ${token}` },
    });
    this.ws.on("message", (data) => {
      const msg = wireEnvelopeSchema.parse(JSON.parse(String(data)));
      this.msgs.push(msg);
      this.#waiters = this.#waiters.filter((w) => {
        if (!w.pred(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
    clients.push(this);
  }

  /** Open + hello/welcome handshake. */
  static async connect(port: number): Promise<TestClient> {
    const c = new TestClient(port);
    await new Promise<void>((resolve, reject) => {
      c.ws.on("open", resolve);
      c.ws.on("error", reject);
    });
    c.send({
      kind: "hello",
      protocolVersion: PROTOCOL_VERSION,
      client: { name: "test", version: "0.0.0", platform: "test" },
      clientId: "client-test",
    });
    await c.waitFor((m) => m.kind === "welcome");
    return c;
  }

  send(env: WireEnvelope): void {
    this.ws.send(JSON.stringify(env));
  }

  waitFor(
    pred: (m: WireEnvelope) => boolean,
    timeoutMs = 5_000,
  ): Promise<WireEnvelope> {
    const existing = this.msgs.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("waitFor timed out")),
        timeoutMs,
      );
      this.#waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }

  events(sessionId: string): EventEnv[] {
    return this.msgs
      .filter(isEvent)
      .filter((m) => m.event.sessionId === sessionId);
  }
}

function rejectedUpgradeStatus(
  port: number,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => reject(new Error("upgrade unexpectedly completed")));
    ws.on("error", () => {}); // follows unexpected-response; swallow
  });
}

test("bad or missing token ⇒ raw HTTP 401 upgrade rejection; /health stays open", async () => {
  const daemon = await boot();
  expect(
    await rejectedUpgradeStatus(daemon.port, { authorization: "Bearer nope" }),
  ).toBe(401);
  expect(await rejectedUpgradeStatus(daemon.port, {})).toBe(401);

  const res = await fetch(`http://127.0.0.1:${daemon.port}/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    status: "ok",
    protocolVersion: PROTOCOL_VERSION,
  });
});

test("POST/GET /v1/sessions: bearer-gated create + list (the `agena` boot path)", async () => {
  const daemon = await boot();
  const base = `http://127.0.0.1:${daemon.port}/v1/sessions`;
  const auth = { authorization: `Bearer ${TOKEN}` };

  expect((await fetch(base)).status).toBe(401);

  const created = await fetch(base, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ title: "hi" }),
  });
  expect(created.status).toBe(201);
  const { sessionId } = (await created.json()) as { sessionId: string };
  expect(typeof sessionId).toBe("string");

  const listed = await fetch(base, { headers: auth });
  const { sessions } = (await listed.json()) as {
    sessions: Array<{ sessionId: string; title?: string }>;
  };
  expect(sessions).toMatchObject([{ sessionId, title: "hi" }]);
});

test("subscribe → prompt: requestId acks and an ordered, gap-free stream", async () => {
  const daemon = await boot();
  const session = await daemon.store.createSession({ workspaceId: "ws-1" });
  const c = await TestClient.connect(daemon.port);

  c.send({
    kind: "cmd",
    requestId: "r-sub",
    name: "subscribe",
    payload: { sessionId: session.sessionId, fromSeq: 0 },
  });
  const subAck = await c.waitFor(
    (m) => m.kind === "ack" && m.requestId === "r-sub",
  );
  expect(
    subscribeAckSchema.parse(
      (subAck as Extract<WireEnvelope, { kind: "ack" }>).result,
    ),
  ).toEqual({
    lastSeq: 1,
    branchId: session.rootBranchId,
    replayCount: 1,
  });
  await c.waitFor((m) => m.kind === "sync" && m.upToSeq === 1);
  await c.waitFor(
    (m) =>
      m.kind === "snapshot" &&
      m.snapshot.sessionId === session.sessionId &&
      m.snapshot.afterSeq === 1,
  );

  c.send({
    kind: "cmd",
    requestId: "r-prompt",
    name: "prompt",
    payload: {
      sessionId: session.sessionId,
      content: [{ type: "text", text: "hi" }],
    },
  });
  const promptAck = await c.waitFor(
    (m) => m.kind === "ack" && m.requestId === "r-prompt",
  );
  const ackResult = promptAckSchema.parse(
    (promptAck as Extract<WireEnvelope, { kind: "ack" }>).result,
  );
  expect(ackResult.seq).toBe(2); // seq of message.user.created (§5.4)
  await c.waitFor((m) => isEvent(m) && m.event.type === "run.completed");

  // exactly one terminal ack/error per requestId (P13)
  expect(
    c.msgs.filter(
      (m) =>
        (m.kind === "ack" || m.kind === "error") && m.requestId === "r-prompt",
    ),
  ).toHaveLength(1);

  const events = c.events(session.sessionId);
  expect(events.map((m) => m.event.type)).toEqual([
    "session.created",
    "message.user.created",
    "run.started",
    "message.assistant.started",
    "message.assistant.completed",
    "run.completed",
  ]);
  expect(events.map((m) => m.event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(events.map((m) => m.replayed)).toEqual([
    true, // history
    false, // live tail
    false,
    false,
    false,
    false,
  ]);

  // live text-delta frames arrived and concatenate to the fake's echo
  const deltas = c.msgs
    .filter(
      (m): m is Extract<WireEnvelope, { kind: "frame" }> => m.kind === "frame",
    )
    .map((m) => assistantTextDeltaSchema.parse(m.frame.payload).delta);
  expect(deltas.join("")).toBe("echo: hi");
});

test("duplicate requestId replays the original ack without duplicating a prompt", async () => {
  const daemon = await boot();
  const session = await daemon.store.createSession({ workspaceId: "ws-1" });
  const c = await TestClient.connect(daemon.port);

  c.send({
    kind: "cmd",
    requestId: "r-sub",
    name: "subscribe",
    payload: { sessionId: session.sessionId, fromSeq: 0 },
  });
  await c.waitFor((m) => m.kind === "snapshot");

  const prompt = {
    kind: "cmd",
    requestId: "r-once",
    name: "prompt",
    payload: {
      sessionId: session.sessionId,
      content: [{ type: "text", text: "hi" }],
    },
  } as const;
  c.send(prompt);
  await c.waitFor((m) => isEvent(m) && m.event.type === "run.completed");
  c.send(prompt);
  await new Promise((r) => setTimeout(r, 50));

  expect(
    c.msgs.filter((m) => m.kind === "ack" && m.requestId === "r-once"),
  ).toHaveLength(2);
  const replay = await daemon.store.readEvents(session.sessionId, 0, 20);
  expect(
    replay.events.filter((e) => e.type === "message.user.created"),
  ).toHaveLength(1);
});

test("two subscribed clients receive the same durable event stream", async () => {
  const daemon = await boot();
  const session = await daemon.store.createSession({ workspaceId: "ws-1" });
  const c1 = await TestClient.connect(daemon.port);
  const c2 = await TestClient.connect(daemon.port);

  for (const [requestId, client] of [
    ["r-sub-1", c1],
    ["r-sub-2", c2],
  ] as const) {
    client.send({
      kind: "cmd",
      requestId,
      name: "subscribe",
      payload: { sessionId: session.sessionId, fromSeq: 0 },
    });
    await client.waitFor((m) => m.kind === "sync");
  }

  c1.send({
    kind: "cmd",
    requestId: "r-prompt",
    name: "prompt",
    payload: {
      sessionId: session.sessionId,
      content: [{ type: "text", text: "same" }],
    },
  });
  await c1.waitFor((m) => isEvent(m) && m.event.type === "run.completed");
  await c2.waitFor((m) => isEvent(m) && m.event.type === "run.completed");

  const durable = (c: TestClient) =>
    c.events(session.sessionId).map((m) => [m.event.seq, m.event.type]);
  expect(durable(c2)).toEqual(durable(c1));
});

test("subscribe during generation receives replay, sync, and in-flight snapshot", async () => {
  const daemon = await boot(
    new FakeRuntimeAdapter({
      delayMs: 20,
      script: () => ["a", "b", "c"],
    }),
  );
  const session = await daemon.store.createSession({ workspaceId: "ws-1" });
  const c1 = await TestClient.connect(daemon.port);
  c1.send({
    kind: "cmd",
    requestId: "r-sub-1",
    name: "subscribe",
    payload: { sessionId: session.sessionId, fromSeq: 0 },
  });
  await c1.waitFor((m) => m.kind === "sync");
  c1.send({
    kind: "cmd",
    requestId: "r-prompt",
    name: "prompt",
    payload: {
      sessionId: session.sessionId,
      content: [{ type: "text", text: "go" }],
    },
  });
  await c1.waitFor(
    (m) =>
      m.kind === "frame" &&
      assistantTextDeltaSchema.parse(m.frame.payload).delta === "a",
  );

  const c2 = await TestClient.connect(daemon.port);
  c2.send({
    kind: "cmd",
    requestId: "r-sub-2",
    name: "subscribe",
    payload: { sessionId: session.sessionId, fromSeq: 0 },
  });
  await c2.waitFor((m) => m.kind === "sync");
  const snapshot = await c2.waitFor((m) => m.kind === "snapshot");
  expect(snapshot).toMatchObject({
    kind: "snapshot",
    snapshot: {
      sessionId: session.sessionId,
      status: { state: "generating" },
    },
  });
  expect(
    (snapshot as Extract<WireEnvelope, { kind: "snapshot" }>).snapshot.assistant
      ?.blocks[0],
  ).toMatchObject({ type: "text", text: expect.stringContaining("a") });
  await c2.waitFor((m) => isEvent(m) && m.event.type === "run.completed");
});

test("kill socket mid-stream → reconnect with fromSeq ⇒ no gaps, no dupes", async () => {
  const daemon = await boot(
    new FakeRuntimeAdapter({
      delayMs: 15,
      script: () => ["a", "b", "c", "d", "e"],
    }),
  );
  const session = await daemon.store.createSession({ workspaceId: "ws-1" });

  const c1 = await TestClient.connect(daemon.port);
  c1.send({
    kind: "cmd",
    requestId: "r-sub-1",
    name: "subscribe",
    payload: { sessionId: session.sessionId, fromSeq: 0 },
  });
  await c1.waitFor((m) => m.kind === "sync");
  c1.send({
    kind: "cmd",
    requestId: "r-prompt",
    name: "prompt",
    payload: {
      sessionId: session.sessionId,
      content: [{ type: "text", text: "go" }],
    },
  });
  await c1.waitFor((m) => isEvent(m) && m.event.type === "run.started");
  c1.ws.terminate(); // mid-stream: generation keeps running daemon-side
  await new Promise((r) => setTimeout(r, 30)); // let in-flight deliveries settle
  const c1Seqs = c1.events(session.sessionId).map((m) => m.event.seq);
  const lastApplied = Math.max(...c1Seqs);

  const c2 = await TestClient.connect(daemon.port);
  c2.send({
    kind: "cmd",
    requestId: "r-sub-2",
    name: "subscribe",
    payload: { sessionId: session.sessionId, fromSeq: lastApplied },
  });
  await c2.waitFor((m) => isEvent(m) && m.event.type === "run.completed");
  const c2Seqs = c2.events(session.sessionId).map((m) => m.event.seq);

  // resumes exactly after the cursor: contiguous, no dupes, through run.completed (seq 6)
  const expected = [];
  for (let s = lastApplied + 1; s <= 6; s++) expected.push(s);
  expect(c2Seqs).toEqual(expected);
  // and the union of both connections covers 1..6 with no gaps
  expect([...new Set([...c1Seqs, ...c2Seqs])].sort((a, b) => a - b)).toEqual([
    1, 2, 3, 4, 5, 6,
  ]);
});

test("malformed input ⇒ error envelopes: no requestId for garbage, requestId for bad cmd payload", async () => {
  const daemon = await boot();
  const session = await daemon.store.createSession({ workspaceId: "ws-1" });
  const c = await TestClient.connect(daemon.port);

  c.ws.send("not json {");
  const garbage = await c.waitFor((m) => m.kind === "error");
  expect(garbage).toMatchObject({
    kind: "error",
    error: { code: "INVALID_PAYLOAD" },
  });
  expect("requestId" in garbage && garbage.requestId).toBeFalsy();

  c.send({
    kind: "cmd",
    requestId: "r-bad",
    name: "prompt",
    payload: { sessionId: session.sessionId }, // missing content
  });
  const bad = await c.waitFor(
    (m) => m.kind === "error" && m.requestId === "r-bad",
  );
  expect(bad).toMatchObject({ error: { code: "INVALID_PAYLOAD" } });

  c.send({
    kind: "cmd",
    requestId: "r-missing",
    name: "subscribe",
    payload: { sessionId: "01NOSUCHSESSION0000000000X", fromSeq: 0 },
  });
  const missing = await c.waitFor(
    (m) => m.kind === "error" && m.requestId === "r-missing",
  );
  expect(missing).toMatchObject({ error: { code: "SESSION_NOT_FOUND" } });
});

test("graceful daemon close terminalizes an active assistant with partial content", async () => {
  const dir = stateDir();
  const daemon = await boot(
    new FakeRuntimeAdapter({
      delayMs: 20,
      script: () => ["a", "b", "c"],
    }),
    { stateDir: dir, storage: "sqlite" },
  );
  const session = await daemon.store.createSession({ workspaceId: "ws-1" });
  const c = await TestClient.connect(daemon.port);
  c.send({
    kind: "cmd",
    requestId: "r-sub",
    name: "subscribe",
    payload: { sessionId: session.sessionId, fromSeq: 0 },
  });
  await c.waitFor((m) => m.kind === "sync");
  c.send({
    kind: "cmd",
    requestId: "r-prompt",
    name: "prompt",
    payload: {
      sessionId: session.sessionId,
      content: [{ type: "text", text: "stop" }],
    },
  });
  await c.waitFor((m) => m.kind === "frame");

  await closeDaemon(daemon);
  const store = new SqliteEventStore(join(dir, "db", "agena.db"));
  const replay = await store.readEvents(session.sessionId, 0, 20);
  store.close();
  const types = replay.events.map((e) => e.type);
  expect(types).toContain("message.assistant.aborted");
  expect(types).toContain("run.aborted");
  const aborted = replay.events.find(
    (e) => e.type === "message.assistant.aborted",
  );
  expect(aborted?.payload).toMatchObject({ reason: "daemon_shutdown" });
  expect(
    (aborted?.payload as { partialContent?: Array<{ text?: string }> })
      .partialContent?.[0]?.text,
  ).not.toBe("");
});

test("boot sweep turns open work into daemon_restart failures before clients connect", async () => {
  const dir = stateDir();
  const store = new SqliteEventStore(join(dir, "db", "agena.db"));
  const session = await store.createSession({ workspaceId: "ws-1" });
  await store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [
      {
        type: "run.started",
        v: 1,
        source: { kind: "runtime" },
        payload: {
          runId: "run-open",
          trigger: "prompt",
          triggerMessageId: "user-1",
        },
      },
      {
        type: "message.assistant.started",
        v: 1,
        source: { kind: "runtime" },
        payload: {
          messageId: "assistant-open",
          runId: "run-open",
          turnId: "turn-open",
          model: { provider: "fake", id: "fake-1" },
          inResponseTo: "user-1",
        },
      },
    ],
  });
  store.close();

  const daemon = await boot(new FakeRuntimeAdapter(), {
    stateDir: dir,
    storage: "sqlite",
  });
  const replay = await daemon.store.readEvents(session.sessionId, 0, 20);
  expect(replay.events.map((e) => e.type)).toEqual([
    "session.created",
    "run.started",
    "message.assistant.started",
    "message.assistant.failed",
    "run.failed",
  ]);
  const failed = replay.events.find(
    (e) => e.type === "message.assistant.failed",
  );
  expect(failed?.payload).toMatchObject({
    messageId: "assistant-open",
    partialContent: [],
    error: { code: "daemon_restart" },
    recovered: true,
  });
});

test("backpressure decisions match the M2 thresholds", () => {
  expect(backpressureAction("event", DURABLE_BACKLOG_LIMIT_BYTES)).toBe("send");
  expect(backpressureAction("event", DURABLE_BACKLOG_LIMIT_BYTES + 1)).toBe(
    "close",
  );
  expect(backpressureAction("frame", FRAME_COALESCE_BUFFERED_BYTES)).toBe(
    "send",
  );
  expect(backpressureAction("frame", FRAME_COALESCE_BUFFERED_BYTES + 1)).toBe(
    "coalesce",
  );
  expect(backpressureAction("frame", FRAME_DROP_BUFFERED_BYTES + 1)).toBe(
    "drop",
  );
});

test("config: token is mandatory, defaults follow §3.2/§9.9", () => {
  expect(() => loadConfig({})).toThrow(/AGENA_AUTH_TOKEN/);
  expect(loadConfig({ AGENA_AUTH_TOKEN: "t" })).toEqual({
    host: "0.0.0.0",
    port: 7777,
    token: "t",
    runtime: "pi",
    workspaceDir: "/workspace",
    stateDir: "/var/lib/agena",
    storage: "sqlite",
  });
  expect(loadConfig({ AGENA_TOKEN: "alias" }).token).toBe("alias");
  expect(() =>
    loadConfig({ AGENA_AUTH_TOKEN: "t", AGENA_RUNTIME: "gpt" }),
  ).toThrow(/AGENA_RUNTIME/);
});
