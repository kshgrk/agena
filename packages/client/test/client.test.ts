import type { AgenaEvent } from "@agena/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgenaClient,
  AgenaClientError,
  type PtyWsLike,
  type WsLike,
} from "../src/client.ts";

class FakeSocket implements WsLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code = 1000, reason = ""): void {
    this.closed = true;
    this.onclose?.({ code, reason });
  }
  // test helpers
  open(): void {
    this.onopen?.();
  }
  receive(env: unknown): void {
    this.onmessage?.({ data: JSON.stringify(env) });
  }
  lastCmd(): { requestId: string; name: string; payload: unknown } {
    const raw = this.sent.at(-1);
    if (!raw) throw new Error("nothing sent");
    return JSON.parse(raw) as {
      requestId: string;
      name: string;
      payload: unknown;
    };
  }
}

class FakePtySocket implements PtyWsLike {
  binaryType?: string;
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {}
}

const welcome = {
  kind: "welcome",
  protocolVersion: 1,
  daemonVersion: "0.0.0",
  serverTime: "2026-07-06T00:00:00.000Z",
  limits: { maxEnvelopeBytes: 1, maxPromptBytes: 1, maxSubscriptions: 1 },
};

function event(seq: number): AgenaEvent {
  return {
    sessionId: "s1",
    branchId: "b1",
    seq,
    type: "run.started",
    v: 1,
    createdAt: "2026-07-06T00:00:00.000Z",
    source: { kind: "daemon" },
    payload: {},
  };
}

async function connected(
  opts: {
    onVisibleBrowserRequest?: AgenaClient["onVisibleBrowserRequest"];
  } = {},
): Promise<{ client: AgenaClient; sock: FakeSocket }> {
  const sockets: FakeSocket[] = [];
  const client = new AgenaClient({
    url: "http://127.0.0.1:7777",
    token: "t",
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
  });
  client.onVisibleBrowserRequest = opts.onVisibleBrowserRequest;
  const p = client.connect();
  const sock = sockets[0] as FakeSocket;
  sock.open();
  expect(JSON.parse(sock.sent[0] ?? "").kind).toBe("hello");
  sock.receive(welcome);
  await p;
  return { client, sock };
}

describe("AgenaClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("correlates acks and errors to commands by requestId", async () => {
    const { client, sock } = await connected();
    const p1 = client.command("prompt", {
      sessionId: "s1",
      content: [{ type: "text", text: "a" }],
    });
    const r1 = sock.lastCmd().requestId;
    const p2 = client.command("prompt", {
      sessionId: "s1",
      content: [{ type: "text", text: "b" }],
    });
    const r2 = sock.lastCmd().requestId;
    expect(r1).not.toBe(r2);

    sock.receive({
      kind: "ack",
      requestId: r2,
      result: { messageId: "m2", seq: 9 },
    });
    sock.receive({
      kind: "error",
      requestId: r1,
      error: { code: "SESSION_BUSY", message: "turn active", retryable: false },
    });

    await expect(p2).resolves.toEqual({ messageId: "m2", seq: 9 });
    await expect(p1).rejects.toMatchObject({ code: "SESSION_BUSY" });
    await client.close();
  });

  it("answers visible-browser requests from the daemon", async () => {
    const handler = vi.fn(async () => ({
      url: "https://example.com/",
      title: "Example",
      text: "ok",
    }));
    const { client, sock } = await connected({
      onVisibleBrowserRequest: handler,
    });
    expect(JSON.parse(sock.sent[0] ?? "")).toMatchObject({
      kind: "hello",
      client: { capabilities: ["visible_browser"] },
    });

    sock.receive({
      kind: "visibleBrowserRequest",
      requestId: "browser-1",
      action: { action: "read", sessionId: "s1" },
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(JSON.parse(sock.sent.at(-1) ?? "")).toEqual({
      kind: "visibleBrowserResponse",
      requestId: "browser-1",
      result: {
        url: "https://example.com/",
        title: "Example",
        text: "ok",
      },
    });
    await client.close();
  });

  it("sends typed M4.5 command wrappers", async () => {
    const { client, sock } = await connected();

    const steer = client.steer("s1", "guide");
    expect(sock.lastCmd()).toMatchObject({
      name: "steer",
      payload: { sessionId: "s1", content: [{ type: "text", text: "guide" }] },
    });
    sock.receive({
      kind: "ack",
      requestId: sock.lastCmd().requestId,
      result: { messageId: "m1", seq: 1 },
    });
    await expect(steer).resolves.toEqual({ messageId: "m1", seq: 1 });

    const followUp = client.followUp("s1", "next");
    expect(sock.lastCmd()).toMatchObject({
      name: "followUp",
      payload: { sessionId: "s1", content: [{ type: "text", text: "next" }] },
    });
    sock.receive({
      kind: "ack",
      requestId: sock.lastCmd().requestId,
      result: { messageId: "m2", seq: 2 },
    });
    await expect(followUp).resolves.toEqual({ messageId: "m2", seq: 2 });

    const abort = client.abort("s1", "user");
    expect(sock.lastCmd()).toMatchObject({
      name: "abort",
      payload: { sessionId: "s1", reason: "user" },
    });
    sock.receive({
      kind: "ack",
      requestId: sock.lastCmd().requestId,
      result: {},
    });
    await expect(abort).resolves.toEqual({});

    const runtimeInfo = client.runtimeInfo("s1");
    expect(sock.lastCmd()).toMatchObject({
      name: "runtimeInfo",
      payload: { sessionId: "s1" },
    });
    sock.receive({
      kind: "ack",
      requestId: sock.lastCmd().requestId,
      result: {
        model: { provider: "openai", id: "gpt-5.5-pro" },
        thinkingLevel: "high",
        availableModels: [{ provider: "openai", id: "gpt-5.5-pro" }],
        availableThinkingLevels: ["off", "high"],
        slashCommands: [{ name: "deploy" }],
      },
    });
    await expect(runtimeInfo).resolves.toEqual({
      model: { provider: "openai", id: "gpt-5.5-pro" },
      thinkingLevel: "high",
      availableModels: [{ provider: "openai", id: "gpt-5.5-pro" }],
      availableThinkingLevels: ["off", "high"],
      slashCommands: [{ name: "deploy" }],
    });

    const setModel = client.setModel("s1", {
      provider: "openai",
      id: "gpt-5.5-pro",
    });
    expect(sock.lastCmd()).toMatchObject({
      name: "setModel",
      payload: {
        sessionId: "s1",
        model: { provider: "openai", id: "gpt-5.5-pro" },
      },
    });
    sock.receive({
      kind: "ack",
      requestId: sock.lastCmd().requestId,
      result: { model: { provider: "openai", id: "gpt-5.5-pro" } },
    });
    await expect(setModel).resolves.toEqual({
      model: { provider: "openai", id: "gpt-5.5-pro" },
    });

    const thinking = client.setThinkingLevel("s1", "high");
    expect(sock.lastCmd()).toMatchObject({
      name: "setThinkingLevel",
      payload: { sessionId: "s1", thinkingLevel: "high" },
    });
    sock.receive({
      kind: "ack",
      requestId: sock.lastCmd().requestId,
      result: { thinkingLevel: "high" },
    });
    await expect(thinking).resolves.toEqual({ thinkingLevel: "high" });

    const fast = client.setFastMode("s1", true);
    expect(sock.lastCmd()).toMatchObject({
      name: "setFastMode",
      payload: { sessionId: "s1", enabled: true },
    });
    sock.receive({
      kind: "ack",
      requestId: sock.lastCmd().requestId,
      result: { enabled: true, available: true, active: true },
    });
    await expect(fast).resolves.toEqual({
      enabled: true,
      available: true,
      active: true,
    });

    const approval = client.respondToApproval("s1", "a1", {
      kind: "confirm",
      accepted: true,
    });
    expect(sock.lastCmd()).toMatchObject({
      name: "respondToApproval",
      payload: {
        sessionId: "s1",
        approvalId: "a1",
        response: { kind: "confirm", accepted: true },
      },
    });
    sock.receive({
      kind: "ack",
      requestId: sock.lastCmd().requestId,
      result: { approvalId: "a1" },
    });
    await expect(approval).resolves.toEqual({ approvalId: "a1" });

    const compact = client.compact("s1", "shorter");
    expect(sock.lastCmd()).toMatchObject({
      name: "compact",
      payload: { sessionId: "s1", instructions: "shorter" },
    });
    sock.receive({
      kind: "ack",
      requestId: sock.lastCmd().requestId,
      result: { compactionSeq: 8 },
    });
    await expect(compact).resolves.toEqual({ compactionSeq: 8 });
    await client.close();
  });

  it("bumps the cursor, drops duplicates, and reconnects on a seq gap", async () => {
    const { client, sock } = await connected();
    const seen: number[] = [];
    client.onEvent = (e) => seen.push(e.seq);

    const subP = client.subscribe("s1", 0);
    sock.receive({
      kind: "ack",
      requestId: sock.lastCmd().requestId,
      result: { lastSeq: 0, branchId: "b1", replayCount: 0 },
    });
    await subP;

    sock.receive({ kind: "event", replayed: false, event: event(1) });
    sock.receive({ kind: "event", replayed: false, event: event(1) }); // duplicate
    sock.receive({ kind: "event", replayed: false, event: event(2) });
    expect(seen).toEqual([1, 2]);
    expect(sock.closed).toBe(false);

    sock.receive({ kind: "event", replayed: false, event: event(5) }); // gap
    expect(seen).toEqual([1, 2]); // gapped event never applied
    expect(sock.closed).toBe(true); // reconnect (which resubscribes from cursor) heals it
    await client.close();
  });

  it("prunes the session and reports it lost on SESSION_NOT_FOUND", async () => {
    const { client, sock } = await connected();
    let lost = "";
    client.onSessionLost = (id) => {
      lost = id;
    };
    const subP = client.subscribe("gone", 42);
    sock.receive({
      kind: "error",
      requestId: sock.lastCmd().requestId,
      error: {
        code: "SESSION_NOT_FOUND",
        message: "unknown session",
        retryable: false,
      },
    });
    await expect(subP).rejects.toBeInstanceOf(AgenaClientError);
    expect(lost).toBe("gone");
    await client.close();
  });

  it("keeps retrying when a reconnect socket errors without close", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const sockets: FakeSocket[] = [];
    const client = new AgenaClient({
      url: "http://127.0.0.1:7777",
      token: "t",
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });

    const p = client.connect();
    sockets[0]?.open();
    sockets[0]?.receive(welcome);
    await p;

    sockets[0]?.close(1001, "daemon restarting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);

    sockets[1]?.onerror?.(new Error("ECONNREFUSED"));
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(3);
    await client.close();
  });

  it("ignores close from an old socket after a newer socket connects", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const sockets: FakeSocket[] = [];
    const statuses: string[] = [];
    const client = new AgenaClient({
      url: "http://127.0.0.1:7777",
      token: "t",
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    client.onStatus = (state) => statuses.push(state);

    const p1 = client.connect();
    sockets[0]?.open();
    sockets[0]?.receive(welcome);
    await p1;
    sockets[0]?.close(1001, "daemon restarting");
    await vi.advanceTimersByTimeAsync(1000);
    sockets[1]?.open();
    sockets[1]?.receive(welcome);
    expect(statuses.at(-1)).toBe("connected");

    sockets[0]?.onclose?.({ code: 1001, reason: "late close" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statuses.at(-1)).toBe("connected");
    expect(sockets).toHaveLength(2);
    await client.close();
  });

  it("creates a PTY and opens the dedicated WS with bearer auth", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ ptyId: "pty_1", wsPath: "/v1/ptys/pty_1/ws" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const ptySockets: FakePtySocket[] = [];
    const ptySocketCalls: unknown[] = [];
    const client = new AgenaClient({
      url: "http://127.0.0.1:7777/",
      token: "secret",
      createPtySocket: (url, init) => {
        ptySocketCalls.push({ url, init });
        const s = new FakePtySocket();
        ptySockets.push(s);
        return s;
      },
    });

    const attachment = await client.openPty({
      cols: 120,
      rows: 40,
      cwd: "/workspace",
      sessionId: "s1",
      command: "bash",
      args: ["-lc", "echo hi"],
    });

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:7777/v1/ptys", {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        cols: 120,
        rows: 40,
        cwd: "/workspace",
        sessionId: "s1",
        command: "bash",
        args: ["-lc", "echo hi"],
      }),
    });
    expect(attachment.ptyId).toBe("pty_1");
    expect(attachment.wsPath).toBe("/v1/ptys/pty_1/ws");
    expect(attachment.socket.binaryType).toBe("arraybuffer");
    expect(ptySockets).toHaveLength(1);
    expect(ptySocketCalls).toEqual([
      {
        url: "ws://127.0.0.1:7777/v1/ptys/pty_1/ws",
        init: { headers: { authorization: "Bearer secret" } },
      },
    ]);

    const reattached = await client.connectPty("/v1/ptys/pty_1/ws");
    expect(reattached.binaryType).toBe("arraybuffer");
    expect(ptySockets).toHaveLength(2);
    expect(ptySocketCalls.at(-1)).toEqual({
      url: "ws://127.0.0.1:7777/v1/ptys/pty_1/ws",
      init: { headers: { authorization: "Bearer secret" } },
    });
  });

  it("sends scoped create-session requests", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ sessionId: "s1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgenaClient({
      url: "http://127.0.0.1:7777/",
      token: "secret",
    });

    await expect(
      client.createSession({
        title: "task",
        scope: "project",
        projectId: "p1",
        projectRoot: ".",
        cwd: "apps/api",
        hostCwdHint: "/repo/apps/api",
      }),
    ).resolves.toBe("s1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7777/v1/sessions",
      {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "task",
          scope: "project",
          projectId: "p1",
          projectRoot: ".",
          cwd: "apps/api",
          hostCwdHint: "/repo/apps/api",
        }),
      },
    );
  });

  it("sends scoped list-session query params", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          sessions: [{ sessionId: "01" }, { sessionId: "02" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgenaClient({
      url: "http://127.0.0.1:7777/",
      token: "secret",
    });

    await expect(
      client.listSessions({
        projectId: "p1",
        scope: "project",
        allProjects: true,
      }),
    ).resolves.toEqual(["02", "01"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7777/v1/sessions?projectId=p1&scope=project&allProjects=1",
      {
        method: "GET",
        headers: { authorization: "Bearer secret" },
      },
    );
  });

  it("sends scoped search query params", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          hits: [
            {
              sessionId: "s1",
              messageId: "m1",
              snippet: "[needle]",
              rank: -1,
              seq: 2,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgenaClient({
      url: "http://127.0.0.1:7777/",
      token: "secret",
    });

    await expect(
      client.search("needle words", {
        projectId: "p1",
        allProjects: true,
        limit: 5,
      }),
    ).resolves.toEqual([
      {
        sessionId: "s1",
        messageId: "m1",
        snippet: "[needle]",
        rank: -1,
        seq: 2,
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7777/v1/search?q=needle+words&projectId=p1&allProjects=1&limit=5",
      {
        method: "GET",
        headers: { authorization: "Bearer secret" },
      },
    );
  });

  it("wraps file list/read/archive HTTP routes", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("/v1/files?")) {
        return new Response(
          JSON.stringify({
            entries: [
              {
                name: "a.txt",
                type: "file",
                size: 2,
                mtime: "2026-07-06T00:00:00.000Z",
                mode: 33188,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v1/projects")) {
        return new Response(
          JSON.stringify({
            name: "my-app",
            projectId: "prj_my-app",
            projectRoot: "my-app",
            cwd: "my-app",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/v1/files/upload?")) {
        return new Response(JSON.stringify({ path: "my-app", fileCount: 1 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgenaClient({
      url: "http://127.0.0.1:7777/",
      token: "secret",
    });

    await expect(client.listFiles({ path: "src dir" })).resolves.toEqual([
      {
        name: "a.txt",
        type: "file",
        size: 2,
        mtime: "2026-07-06T00:00:00.000Z",
        mode: 33188,
      },
    ]);
    await expect(client.readFile("src dir/a.txt")).resolves.toEqual(
      new TextEncoder().encode("ok"),
    );
    await expect(client.archiveFiles("src dir")).resolves.toEqual(
      new TextEncoder().encode("ok"),
    );
    await expect(client.createProject("My App")).resolves.toEqual({
      name: "my-app",
      projectId: "prj_my-app",
      projectRoot: "my-app",
      cwd: "my-app",
    });
    await expect(
      client.uploadFiles(
        { path: "my-app", format: "tar" },
        new TextEncoder().encode("tar"),
      ),
    ).resolves.toEqual({ path: "my-app", fileCount: 1 });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://127.0.0.1:7777/v1/files?path=src+dir",
      "http://127.0.0.1:7777/v1/files/content?path=src+dir%2Fa.txt",
      "http://127.0.0.1:7777/v1/files/archive?path=src+dir",
      "http://127.0.0.1:7777/v1/projects",
      "http://127.0.0.1:7777/v1/files/upload?path=my-app&format=tar",
    ]);
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "My App" }),
    });
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/x-tar",
      },
    });
  });

  it("falls back to ordered single-session imports when batch import is unavailable", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/imports/sessions"))
        return new Response("Not Found", { status: 404 });
      return new Response(
        JSON.stringify({
          sessionId: `session-${fetchMock.mock.calls.length}`,
          seededEvents: 1,
          alreadyImported: false,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgenaClient({
      url: "http://127.0.0.1:7777",
      token: "secret",
    });
    const request = (sourcePath: string, sourceSessionId: string) => ({
      projectId: "prj_harp",
      projectRoot: "harp",
      sourceFingerprint: {
        harness: "codex" as const,
        machineId: "mac",
        sourcePath,
        sourceSessionId,
        mtimeMs: 1,
        size: 1,
      },
      piSession: '{"type":"session"}',
    });

    await expect(
      client.importSessions({
        sessions: [request("one.jsonl", "one"), request("two.jsonl", "two")],
      }),
    ).resolves.toMatchObject({
      sessions: [
        { sourcePath: "one.jsonl", result: { alreadyImported: false } },
        { sourcePath: "two.jsonl", result: { alreadyImported: false } },
      ],
    });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://127.0.0.1:7777/v1/imports/sessions",
      "http://127.0.0.1:7777/v1/imports/session",
      "http://127.0.0.1:7777/v1/imports/session",
    ]);
  });

  it("wraps event paging and PTY management HTTP routes", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/events")) {
        return new Response(
          JSON.stringify({ events: [event(3)], nextFromSeq: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v1/ptys")) {
        return new Response(
          JSON.stringify({
            ptys: [
              {
                ptyId: "pty_1",
                cols: 80,
                rows: 24,
                cwd: "/workspace",
                attached: true,
                createdAt: "2026-07-06T00:00:00.000Z",
                lastAttachedAt: "2026-07-06T00:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new AgenaClient({
      url: "http://127.0.0.1:7777/",
      token: "secret",
    });

    await expect(
      client.readEvents("session/1", { fromSeq: 2, limit: 10 }),
    ).resolves.toEqual({ events: [event(3)], nextFromSeq: null });
    await expect(client.listPtys()).resolves.toEqual([
      {
        ptyId: "pty_1",
        cols: 80,
        rows: 24,
        cwd: "/workspace",
        attached: true,
        createdAt: "2026-07-06T00:00:00.000Z",
        lastAttachedAt: "2026-07-06T00:00:00.000Z",
      },
    ]);
    await expect(client.killPty("pty/1")).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://127.0.0.1:7777/v1/sessions/session%2F1/events?fromSeq=2&limit=10",
      "http://127.0.0.1:7777/v1/ptys",
      "http://127.0.0.1:7777/v1/ptys/pty%2F1",
    ]);
  });
});
