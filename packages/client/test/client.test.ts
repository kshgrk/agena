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

async function connected(): Promise<{ client: AgenaClient; sock: FakeSocket }> {
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

    const reattached = client.connectPty("/v1/ptys/pty_1/ws");
    expect(reattached.binaryType).toBe("arraybuffer");
    expect(ptySockets).toHaveLength(2);
    expect(ptySocketCalls.at(-1)).toEqual({
      url: "ws://127.0.0.1:7777/v1/ptys/pty_1/ws",
      init: { headers: { authorization: "Bearer secret" } },
    });
  });
});
