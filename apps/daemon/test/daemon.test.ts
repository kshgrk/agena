// Suites 6 & 7, M1 subset (§13.5): real WS against an ephemeral port with the
// FakeRuntimeAdapter — zero model calls (P16).

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTaskStore, EventStore, RuntimeAdapter } from "@agena/core";
import { FakeRuntimeAdapter } from "@agena/core/testing";
import type { WireEnvelope } from "@agena/protocol";
import {
  assistantTextDeltaSchema,
  createPtyResponseSchema,
  DURABLE_BACKLOG_LIMIT_BYTES,
  FRAME_COALESCE_BUFFERED_BYTES,
  FRAME_DROP_BUFFERED_BYTES,
  PROTOCOL_VERSION,
  promptAckSchema,
  ptyDaemonControlFrameSchema,
  subscribeAckSchema,
  WS_CLOSE_CODES,
  WS_SUBPROTOCOL,
  wireEnvelopeSchema,
} from "@agena/protocol";
import { SqliteEventStore } from "@agena/storage-sqlite";
import { afterEach, expect, test } from "vitest";
import WebSocket, { type RawData } from "ws";
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
  adapter: RuntimeAdapter = new FakeRuntimeAdapter(),
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

function compactErrorAdapter(errorMessage: string): RuntimeAdapter {
  return {
    id: "fake",
    version: "0.0.0",
    async createSession(input) {
      return {
        sessionId: input.sessionId,
        runtimeSessionRef: `fake:${input.sessionId}`,
        state: "idle",
        async *events() {
          await new Promise<never>(() => {});
        },
        async prompt() {},
        async steer() {},
        async followUp() {},
        async abort() {},
        async info() {
          const model = { provider: "fake", id: "fake-1" };
          return {
            model,
            thinkingLevel: "off",
            availableModels: [model],
            availableThinkingLevels: ["off"],
            slashCommands: [],
          };
        },
        async setModel() {},
        async setThinkingLevel() {},
        async setFastMode(enabled) {
          return { enabled, available: true, active: enabled };
        },
        async compact() {
          throw new Error(errorMessage);
        },
        async navigateTree() {
          return {};
        },
        async respondToApproval() {},
        getInFlightSnapshot() {
          return null;
        },
        async dispose() {},
      };
    },
    async dispose() {},
  };
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

async function createPty(
  port: number,
  body: Record<string, unknown>,
): Promise<{ ptyId: string; wsPath: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/ptys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return createPtyResponseSchema.parse(await res.json());
}

function attachPty(port: number, wsPath: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function collectPty(
  ws: WebSocket,
): Promise<{ output: string; exitCode: number | null }> {
  let output = "";
  let exitCode: number | null = null;
  return new Promise((resolve, reject) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        output += rawPty(data);
        return;
      }
      const exit = ptyDaemonControlFrameSchema.safeParse(
        JSON.parse(String(data)),
      );
      if (exit.success) exitCode = exit.data.exitCode;
    });
    ws.on("close", () => resolve({ output, exitCode }));
    ws.on("error", reject);
  });
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on("close", (code) => resolve(code)));
}

function rawPty(data: RawData): string {
  return Buffer.isBuffer(data)
    ? data.toString("utf8")
    : Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(data).toString("utf8");
}

function tarFile(name: string, content: string): Blob {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  writeTarOctal(header, 100, 8, 0o100644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, data.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  const tar = Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
  return new Blob([Uint8Array.from(tar)], { type: "application/x-tar" });
}

function writeTarOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  header.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1);
  header[offset + length - 1] = 0;
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

test("generic attachments are validated, stored, and readable by BlobRef", async () => {
  const daemon = await boot();
  const base = `http://127.0.0.1:${daemon.port}`;
  const uploaded = await fetch(
    `${base}/v1/attachments?name=${encodeURIComponent("notes.md")}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "text/markdown",
      },
      body: "# Notes\n",
    },
  );
  expect(uploaded.status).toBe(200);
  const body = (await uploaded.json()) as {
    ref: { blob: string; sizeBytes: number; mimeType: string };
  };
  expect(body.ref).toMatchObject({
    sizeBytes: 8,
    mimeType: "text/markdown",
  });
  const digest = body.ref.blob.slice("sha256:".length);
  const downloaded = await fetch(`${base}/v1/blobs/${digest}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(await downloaded.text()).toBe("# Notes\n");

  const rejected = await fetch(
    `${base}/v1/attachments?name=${encodeURIComponent("payload.exe")}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/octet-stream",
      },
      body: "MZ-not-an-attachment",
    },
  );
  expect(rejected.status).toBe(400);
});

test("remote image materialization rejects private-network targets", async () => {
  const daemon = await boot();
  const response = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/images/materialize`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "https://127.0.0.1/private.png" }),
    },
  );
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    code: "INVALID_PAYLOAD",
    message: expect.stringContaining("non-public"),
  });
});

test("image uploads accept safe SVG and reject executable SVG", async () => {
  const daemon = await boot();
  const url = `http://127.0.0.1:${daemon.port}/v1/images`;
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "image/svg+xml",
  };
  const accepted = await fetch(url, {
    method: "POST",
    headers,
    body: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>',
  });
  expect(accepted.status).toBe(200);
  await expect(accepted.json()).resolves.toMatchObject({
    ref: { mimeType: "image/svg+xml" },
  });

  const rejected = await fetch(url, {
    method: "POST",
    headers,
    body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  });
  expect(rejected.status).toBe(400);
});

test("Conductor pairing and browser WS tickets are short-lived one-use credentials", async () => {
  const daemon = await boot();
  const base = `http://127.0.0.1:${daemon.port}`;
  const auth = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };

  const ticketResponse = await fetch(`${base}/v1/ws-tickets`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ path: "/v1/ws" }),
  });
  expect(ticketResponse.status).toBe(200);
  const ticket = (await ticketResponse.json()) as { ticket: string };
  const ticketUrl = `${base.replace("http:", "ws:")}/v1/ws?ticket=${encodeURIComponent(ticket.ticket)}`;
  const socket = new WebSocket(ticketUrl, WS_SUBPROTOCOL);
  await new Promise<void>((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", reject);
  });
  socket.terminate();
  expect(
    await new Promise<number>((resolve) => {
      const replay = new WebSocket(ticketUrl, WS_SUBPROTOCOL);
      replay.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        replay.terminate();
      });
      replay.on("error", () => {});
    }),
  ).toBe(401);

  const pairingResponse = await fetch(`${base}/v1/pairings`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ daemonUrl: "https://agena.example" }),
  });
  expect(pairingResponse.status).toBe(200);
  const pairing = (await pairingResponse.json()) as { pairingUri: string };
  const pairingToken = new URL(pairing.pairingUri).searchParams.get("token");
  expect(pairingToken).toBeTruthy();
  const redeem = () =>
    fetch(`${base}/v1/pairings/redeem`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${pairingToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        clientId: "client-phone",
        deviceName: "Test phone",
        platform: "ios",
      }),
    });
  const redeemed = await redeem();
  expect(redeemed.status).toBe(200);
  expect(await redeemed.json()).toEqual({
    daemonUrl: "https://agena.example",
    token: TOKEN,
  });
  expect((await redeem()).status).toBe(401);
});

test("POST/GET /v1/sessions: bearer-gated create + list (the `agena` boot path)", async () => {
  const daemon = await boot();
  const base = `http://127.0.0.1:${daemon.port}/v1/sessions`;
  const auth = { authorization: `Bearer ${TOKEN}` };

  expect((await fetch(base)).status).toBe(401);

  const created = await fetch(base, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      title: "hi",
      scope: "project",
      projectId: "project-a",
      projectRoot: ".",
      cwd: ".",
    }),
  });
  expect(created.status).toBe(201);
  const { sessionId } = (await created.json()) as { sessionId: string };
  expect(typeof sessionId).toBe("string");

  await fetch(base, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      title: "other",
      scope: "project",
      projectId: "project-b",
      projectRoot: ".",
      cwd: ".",
    }),
  });
  const global = await fetch(base, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ title: "global", scope: "global" }),
  });
  expect(global.status).toBe(201);

  const listed = await fetch(`${base}?projectId=project-a`, { headers: auth });
  const { sessions } = (await listed.json()) as {
    sessions: Array<{
      sessionId: string;
      title?: string;
      scope: string;
      projectId?: string;
      cwd: string;
    }>;
  };
  expect(sessions).toMatchObject([
    {
      sessionId,
      title: "hi",
      scope: "project",
      projectId: "project-a",
      cwd: ".",
    },
  ]);

  const globals = await fetch(`${base}?scope=global`, { headers: auth });
  expect(
    ((await globals.json()) as { sessions: unknown[] }).sessions,
  ).toHaveLength(1);
});

test("GET /v1/sessions includes durable subagent hierarchy metadata", async () => {
  const dir = stateDir();
  const daemon = await boot(new FakeRuntimeAdapter(), {
    stateDir: dir,
    storage: "sqlite",
  });
  const parent = await daemon.store.createSession({ workspaceId: "ws-1" });
  const taskId = "task-review";
  const taskStore = daemon.store as EventStore & AgentTaskStore;
  const { session: child } = await taskStore.createSubagentSession({
    parentSessionId: parent.sessionId,
    source: { kind: "runtime", runtime: "pi" },
    task: {
      taskId,
      parentRunId: "run-review",
      parentMessageId: "message-review",
      parentToolCallId: "tool-review",
      role: "security",
      task: "Review auth handling",
      execution: "background",
      context: "fresh",
      workspaceMode: "shared_readonly",
      resolvedModel: { provider: "fake", id: "reviewer" },
    },
  });
  await daemon.store.appendEvents({
    sessionId: parent.sessionId,
    branchId: parent.rootBranchId,
    events: [
      {
        type: "agent.task.started",
        v: 1,
        source: { kind: "runtime", runtime: "pi" },
        payload: { taskId, startedAt: "2026-07-12T00:00:00.000Z" },
      },
    ],
  });

  const response = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/sessions?allProjects=1`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  );
  expect(response.status).toBe(200);
  const { sessions } = (await response.json()) as {
    sessions: Array<Record<string, unknown>>;
  };
  expect(
    sessions.find((session) => session.sessionId === child.sessionId),
  ).toMatchObject({
    sessionKind: "subagent",
    parentSessionId: parent.sessionId,
    parentTaskId: taskId,
    subagent: {
      taskId,
      role: "security",
      status: "running",
      createdAt: expect.any(String),
      startedAt: "2026-07-12T00:00:00.000Z",
    },
  });
});

test("POST /v1/sessions/:id/derived persists full side-chat access", async () => {
  const adapter = new FakeRuntimeAdapter();
  const daemon = await boot(adapter, {
    stateDir: stateDir(),
    storage: "sqlite",
  });
  const parent = await daemon.store.createSession({ workspaceId: "ws-1" });
  const response = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/sessions/${parent.sessionId}/derived`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        mode: "fork",
        purpose: "quick_chat",
        sideChatAccess: "full",
      }),
    },
  );
  expect(response.status).toBe(201);
  const { sessionId } = (await response.json()) as { sessionId: string };
  expect(await daemon.store.getSession(sessionId)).toMatchObject({
    sideChatAccess: "full",
  });
  expect(adapter.createInputs[0]?.toolNames).toBeUndefined();
  expect(adapter.createInputs[0]?.systemPromptAppendix).toContain(
    "full-access side chat",
  );
});

test("provider auth routes save and remove keys without returning them", async () => {
  let key = "";
  const provider = (configured: boolean) => ({
    id: "anthropic",
    name: "Anthropic",
    methods: ["api_key" as const],
    modelCount: 1,
    configured,
    ...(configured ? { credentialKind: "api_key" as const } : {}),
  });
  const providers = {
    list: () => [provider(Boolean(key))],
    async saveApiKey(_id: string, value: string) {
      key = value;
      return provider(true);
    },
    async remove() {
      key = "";
      return provider(false);
    },
    async loginOAuth() {
      return provider(false);
    },
  };
  const daemon = await boot(
    Object.assign(new FakeRuntimeAdapter(), { providers }),
  );
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };

  const saved = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/providers/anthropic/api-key`,
    { method: "PUT", headers, body: JSON.stringify({ apiKey: "secret" }) },
  );
  expect(saved.status).toBe(200);
  expect(JSON.stringify(await saved.json())).not.toContain("secret");
  expect(key).toBe("secret");

  const listed = await fetch(`http://127.0.0.1:${daemon.port}/v1/providers`, {
    headers,
  });
  expect(await listed.json()).toMatchObject({
    providers: [{ id: "anthropic", configured: true }],
  });

  const removed = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/providers/anthropic/auth`,
    { method: "DELETE", headers },
  );
  expect(removed.status).toBe(200);
  expect(key).toBe("");

  const oversized = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/providers/${"x".repeat(129)}/api-key`,
    { method: "PUT", headers, body: JSON.stringify({ apiKey: "key" }) },
  );
  expect(oversized.status).toBe(400);
});

test("GET /v1/search returns project-filtered sqlite FTS hits", async () => {
  const dir = stateDir();
  const daemon = await boot(new FakeRuntimeAdapter(), {
    stateDir: dir,
    storage: "sqlite",
  });
  const a = await daemon.store.createSession({
    workspaceId: "ws-1",
    projectId: "project-a",
  });
  const b = await daemon.store.createSession({
    workspaceId: "ws-1",
    projectId: "project-b",
  });
  await daemon.store.appendEvents({
    sessionId: a.sessionId,
    branchId: a.rootBranchId,
    events: [
      {
        type: "message.user.created",
        v: 1,
        source: { kind: "user" },
        payload: {
          messageId: "message-a",
          content: [{ type: "text", text: "needle alpha" }],
        },
      },
    ],
  });
  await daemon.store.appendEvents({
    sessionId: b.sessionId,
    branchId: b.rootBranchId,
    events: [
      {
        type: "message.user.created",
        v: 1,
        source: { kind: "user" },
        payload: {
          messageId: "message-b",
          content: [{ type: "text", text: "needle beta" }],
        },
      },
    ],
  });

  const res = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/search?q=needle&projectId=project-a`,
    { headers: { authorization: `Bearer ${TOKEN}` } },
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    hits: [
      {
        sessionId: a.sessionId,
        messageId: "message-a",
        seq: 2,
      },
    ],
  });
});

test("POST /v1/sessions rejects cwd escapes through symlinks", async () => {
  const workspace = stateDir();
  mkdirSync(join(workspace, "repo"), { recursive: true });
  const outside = stateDir();
  symlinkSync(outside, join(workspace, "repo", "escape"));
  const daemon = await boot(new FakeRuntimeAdapter(), {
    workspaceDir: workspace,
  });
  const res = await fetch(`http://127.0.0.1:${daemon.port}/v1/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      scope: "project",
      projectId: "project-a",
      projectRoot: "repo",
      cwd: "repo/escape",
    }),
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ code: "INVALID_PAYLOAD" });
});

test("GET /v1/files lists and reads workspace files, rejecting escapes", async () => {
  const workspace = stateDir();
  mkdirSync(join(workspace, "repo"), { recursive: true });
  writeFileSync(join(workspace, "repo", "a.txt"), "hello");
  const outside = stateDir();
  symlinkSync(outside, join(workspace, "repo", "escape"));
  const daemon = await boot(new FakeRuntimeAdapter(), {
    workspaceDir: workspace,
  });
  const headers = { authorization: `Bearer ${TOKEN}` };

  const listed = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/files?path=repo`,
    { headers },
  );
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({
    entries: [
      { name: "a.txt", type: "file", size: 5 },
      { name: "escape", type: "symlink" },
    ],
    nextCursor: null,
  });

  const content = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/files/content?path=repo/a.txt`,
    { headers },
  );
  expect(content.status).toBe(200);
  expect(await content.text()).toBe("hello");

  const escaped = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/files/content?path=repo/escape/a.txt`,
    { headers },
  );
  expect(escaped.status).toBe(403);
  expect(await escaped.json()).toMatchObject({
    code: "PATH_ESCAPES_WORKSPACE",
  });
});

test("POST /v1/projects creates workspace projects", async () => {
  const workspace = stateDir();
  const daemon = await boot(new FakeRuntimeAdapter(), {
    workspaceDir: workspace,
  });
  const res = await fetch(`http://127.0.0.1:${daemon.port}/v1/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "My App" }),
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({
    name: "my-app",
    projectId: "prj_my-app",
    projectRoot: "my-app",
    cwd: "my-app",
  });
  expect(existsSync(join(workspace, "my-app"))).toBe(true);

  writeFileSync(join(workspace, "my-app", "partial.txt"), "uploaded");
  const collision = await fetch(`http://127.0.0.1:${daemon.port}/v1/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "My App" }),
  });
  expect(collision.status).toBe(409);

  const resumed = await fetch(`http://127.0.0.1:${daemon.port}/v1/projects`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "My App", reuseExisting: true }),
  });
  expect(resumed.status).toBe(201);
  expect(await resumed.json()).toEqual({
    name: "my-app",
    projectId: "prj_my-app",
    projectRoot: "my-app",
    cwd: "my-app",
  });
});

test("POST /v1/files/upload extracts safe tar and rejects unsafe entries", async () => {
  const workspace = stateDir();
  const src = stateDir();
  mkdirSync(join(src, "nested"), { recursive: true });
  writeFileSync(join(src, "nested", "a.txt"), "hello");
  const archive = join(stateDir(), "safe.tar");
  execFileSync("tar", ["-cf", archive, "-C", src, "."]);
  const daemon = await boot(new FakeRuntimeAdapter(), {
    workspaceDir: workspace,
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/x-tar",
  };

  const uploaded = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/files/upload?path=my-app&format=tar`,
    { method: "POST", headers, body: new Blob([readFileSync(archive)]) },
  );
  expect(uploaded.status).toBe(201);
  expect(await uploaded.json()).toEqual({ path: "my-app", fileCount: 1 });
  expect(
    readFileSync(join(workspace, "my-app", "nested", "a.txt"), "utf8"),
  ).toBe("hello");

  const rejected = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/files/upload?path=bad&format=tar`,
    { method: "POST", headers, body: tarFile("../evil.txt", "nope") },
  );
  expect(rejected.status).toBe(403);
  expect(await rejected.json()).toMatchObject({
    code: "PATH_ESCAPES_WORKSPACE",
  });
});

test("GET /v1/diagnostics reports invalid .agena tools without executing them", async () => {
  const workspace = stateDir();
  mkdirSync(join(workspace, ".agena", "tools"), { recursive: true });
  writeFileSync(
    join(workspace, ".agena", "tools", "broken.ts"),
    'throw new Error("should not execute");\nexport default defineTool({\n',
  );
  const daemon = await boot(new FakeRuntimeAdapter(), {
    workspaceDir: workspace,
  });
  const res = await fetch(`http://127.0.0.1:${daemon.port}/v1/diagnostics`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    workspace: { path: workspace },
    discovery: {
      entries: [
        {
          kind: "tool",
          name: "broken",
          file: ".agena/tools/broken.ts",
          status: "invalid",
          reason: "unbalanced delimiters",
        },
      ],
    },
  });
});

test("PATCH /v1/sessions/:id archives sessions out of default lists", async () => {
  const daemon = await boot();
  const base = `http://127.0.0.1:${daemon.port}/v1/sessions`;
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
  const created = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: "archive me",
      scope: "project",
      projectId: "project-a",
      projectRoot: ".",
      cwd: ".",
    }),
  });
  const { sessionId } = (await created.json()) as { sessionId: string };

  const archived = await fetch(`${base}/${sessionId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "archived" }),
  });
  expect(archived.status).toBe(204);

  const listed = await fetch(`${base}?projectId=project-a`, { headers });
  expect(((await listed.json()) as { sessions: unknown[] }).sessions).toEqual(
    [],
  );
  const withArchived = await fetch(
    `${base}?projectId=project-a&includeArchived=1`,
    { headers },
  );
  expect(
    ((await withArchived.json()) as { sessions: Array<{ status: string }> })
      .sessions[0]?.status,
  ).toBe("archived");
});

test("snapshots restore workspace files without deleting session history", async () => {
  const workspace = stateDir();
  const state = stateDir();
  writeFileSync(join(workspace, "note.txt"), "before");
  const daemon = await boot(new FakeRuntimeAdapter(), {
    workspaceDir: workspace,
    stateDir: state,
    storage: "sqlite",
  });
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
  const session = await fetch(`http://127.0.0.1:${daemon.port}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      scope: "project",
      projectId: "project-a",
      projectRoot: ".",
      cwd: ".",
    }),
  });
  const { sessionId } = (await session.json()) as { sessionId: string };
  const created = await fetch(`http://127.0.0.1:${daemon.port}/v1/snapshots`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "before", sessionId }),
  });
  expect(created.status).toBe(201);
  const { snapshot } = (await created.json()) as {
    snapshot: { snapshotId: string };
  };

  writeFileSync(join(workspace, "note.txt"), "after");
  const restored = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/snapshots/${snapshot.snapshotId}/restore`,
    { method: "POST", headers, body: JSON.stringify({ sessionId }) },
  );
  expect(restored.status).toBe(200);
  expect(readFileSync(join(workspace, "note.txt"), "utf8")).toBe("before");

  const events = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/sessions/${sessionId}/events?fromSeq=0`,
    { headers },
  );
  expect(((await events.json()) as { events: unknown[] }).events).toHaveLength(
    1,
  );
});

test("compact transcript and tool detail routes use the SQLite projections", async () => {
  const daemon = await boot(new FakeRuntimeAdapter(), {
    stateDir: stateDir(),
    storage: "sqlite",
  });
  const session = await daemon.store.createSession({ workspaceId: "ws-1" });
  const userMessageId = "user-1";
  const assistantMessageId = "assistant-1";
  const toolCallId = "tool-1";
  await daemon.store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events: [
      {
        type: "message.user.created",
        v: 1,
        source: { kind: "user" },
        payload: {
          messageId: userMessageId,
          content: [{ type: "text", text: "research this" }],
        },
      },
      {
        type: "message.assistant.started",
        v: 1,
        source: { kind: "runtime", runtime: "pi" },
        payload: {
          messageId: assistantMessageId,
          runId: "run-1",
          turnId: "turn-1",
          model: { provider: "fake", id: "fake-1" },
          inResponseTo: userMessageId,
        },
      },
      {
        type: "tool.call.started",
        v: 1,
        source: { kind: "runtime", runtime: "pi" },
        payload: {
          toolCallId,
          messageId: assistantMessageId,
          runId: "run-1",
          turnId: "turn-1",
          name: "browser",
          args: { query: "agena" },
        },
      },
      {
        type: "tool.call.completed",
        v: 1,
        source: { kind: "runtime", runtime: "pi" },
        payload: {
          toolCallId,
          result: [{ type: "text", text: "large private output" }],
          durationMs: 4,
        },
      },
    ],
  });
  const headers = { authorization: `Bearer ${TOKEN}` };
  const transcriptResponse = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/sessions/${session.sessionId}/transcript?limitTurns=1`,
    { headers },
  );
  expect(transcriptResponse.status).toBe(200);
  const transcript = (await transcriptResponse.json()) as {
    upToSeq: number;
    turns: Array<{ entries: Array<{ kind: string }> }>;
  };
  expect(transcript.upToSeq).toBe(5);
  expect(transcript.turns[0]?.entries).toMatchObject([
    { kind: "tool", status: "completed" },
  ]);
  expect(JSON.stringify(transcript)).not.toContain("large private output");

  const detailResponse = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/sessions/${session.sessionId}/tool-calls/${toolCallId}`,
    { headers },
  );
  expect(detailResponse.status).toBe(200);
  expect(await detailResponse.json()).toMatchObject({
    toolCall: {
      toolCallId,
      result: [{ type: "text", text: "large private output" }],
    },
  });
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
    "session.title.changed",
    "run.started",
    "message.assistant.started",
    "message.assistant.completed",
    "run.completed",
  ]);
  expect(events.map((m) => m.event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(events.map((m) => m.replayed)).toEqual([
    true, // history
    false, // live tail
    false,
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

  // resumes exactly after the cursor: contiguous, no dupes, through run.completed (seq 7)
  const expected = [];
  for (let s = lastApplied + 1; s <= 7; s++) expected.push(s);
  expect(c2Seqs).toEqual(expected);
  // and the union of both connections covers 1..7 with no gaps
  expect([...new Set([...c1Seqs, ...c2Seqs])].sort((a, b) => a - b)).toEqual([
    1, 2, 3, 4, 5, 6, 7,
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

test("compact command surfaces runtime user-facing errors", async () => {
  const daemon = await boot(
    compactErrorAdapter("Nothing to compact (session too small)"),
  );
  const session = await daemon.store.createSession({ workspaceId: "ws-1" });
  const c = await TestClient.connect(daemon.port);

  c.send({
    kind: "cmd",
    requestId: "r-compact",
    name: "compact",
    payload: { sessionId: session.sessionId },
  });

  const failed = await c.waitFor(
    (m) => m.kind === "error" && m.requestId === "r-compact",
  );
  expect(failed).toMatchObject({
    error: {
      code: "RUNTIME_UNAVAILABLE",
      message: "Nothing to compact (session too small)",
    },
  });
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

test("PTY command shares workspace and emits terminal lifecycle events", async () => {
  const workspace = stateDir();
  mkdirSync(join(workspace, "repo", "pkg"), { recursive: true });
  const daemon = await boot(new FakeRuntimeAdapter(), {
    workspaceDir: workspace,
  });
  const session = await daemon.store.createSession({
    workspaceId: "ws-1",
    projectId: "project-a",
    projectRoot: "repo",
    cwd: "repo/pkg",
  });
  const c = await TestClient.connect(daemon.port);
  c.send({
    kind: "cmd",
    requestId: "r-sub",
    name: "subscribe",
    payload: { sessionId: session.sessionId, fromSeq: 0 },
  });
  await c.waitFor((m) => m.kind === "sync");

  const { wsPath } = await createPty(daemon.port, {
    cols: 80,
    rows: 24,
    sessionId: session.sessionId,
    command: "/bin/sh",
    args: ["-lc", "pwd; touch hello.txt; printf done"],
  });
  const ws = await attachPty(daemon.port, wsPath);
  const result = await collectPty(ws);

  expect(result.output).toContain("done");
  expect(result.output).toContain(join(workspace, "repo", "pkg"));
  expect(result.exitCode).toBe(0);
  expect(existsSync(join(workspace, "repo", "pkg", "hello.txt"))).toBe(true);
  await c.waitFor(
    (m) => isEvent(m) && m.event.type === "terminal.session.ended",
  );
  expect(c.events(session.sessionId).map((m) => m.event.type)).toContain(
    "terminal.session.started",
  );
  expect(c.msgs.filter((m) => m.kind === "frame")).toHaveLength(0);
});

test("PTY websocket resize works and a second live attachment closes 4409", async () => {
  const workspace = stateDir();
  const daemon = await boot(new FakeRuntimeAdapter(), {
    workspaceDir: workspace,
  });
  const { wsPath } = await createPty(daemon.port, {
    cols: 80,
    rows: 24,
    command: "/bin/sh",
    args: [],
  });
  const ws1 = await attachPty(daemon.port, wsPath);
  const ws2 = await attachPty(daemon.port, wsPath);
  await expect(closeCode(ws2)).resolves.toBe(WS_CLOSE_CODES.ptyAlreadyAttached);

  ws1.send(JSON.stringify({ type: "resize", cols: 101, rows: 33 }));
  await new Promise((r) => setTimeout(r, 30));
  ws1.send(Buffer.from("stty size\nexit\n"));
  const result = await collectPty(ws1);

  expect(result.output).toMatch(/33 101/);
  expect(result.exitCode).toBe(0);
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
