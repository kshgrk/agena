// WS gateway (§9.4): implements §5 exactly — hello/welcome handshake, cmd
// dispatch with requestId ack/error, subscribe with the §6.3 buffer-then-splice
// replay, and post-commit fanout registered on the store's onCommitted seam (§6.2).
// ponytail later: unsubscribe and the remaining §5.4 commands.
import type { EventStore, SessionOrchestrator } from "@agena/core";
import { OrchestratorError } from "@agena/core";
import type {
  AgenaError,
  AgenaEvent,
  AgenaFrame,
  CommandName,
  ErrorCode,
  PromptCmd,
  SubscribeCmd,
  WireEnvelope,
} from "@agena/protocol";
import {
  commandSchemas,
  DEFAULT_WIRE_LIMITS,
  DURABLE_BACKLOG_LIMIT_BYTES,
  FRAME_COALESCE_BUFFERED_BYTES,
  FRAME_DROP_BUFFERED_BYTES,
  HELLO_TIMEOUT_MS,
  helloEnvelopeSchema,
  MAX_ENVELOPE_BYTES,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  PING_INTERVAL_MS,
  PROTOCOL_VERSION,
  REQUEST_DEDUPE_TTL_MS,
  WS_CLOSE_CODES,
  WS_SUBPROTOCOL,
  wireEnvelopeSchema,
} from "@agena/protocol";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { log } from "./log.ts";

// ponytail: matches apps/daemon package.json version by hand
export const DAEMON_VERSION = "0.0.0";
const REPLAY_PAGE = 500; // §5.8 replay chunk size
const MAX_STRIKES = 5; // §5.2: >5 malformed → 4400; repeated oversize → 4413
const SUBSCRIBE_BUFFER_LIMIT = 5_000; // §6.3 buffering cap while cold replay runs

export type BackpressureAction = "send" | "close" | "coalesce" | "drop";

export function backpressureAction(
  kind: WireEnvelope["kind"],
  bufferedAmount: number,
): BackpressureAction {
  if (kind !== "frame") {
    return bufferedAmount > DURABLE_BACKLOG_LIMIT_BYTES ? "close" : "send";
  }
  if (bufferedAmount > FRAME_DROP_BUFFERED_BYTES) return "drop";
  if (bufferedAmount > FRAME_COALESCE_BUFFERED_BYTES) return "coalesce";
  return "send";
}

interface Subscription {
  mode: "buffering" | "live";
  buffer: AgenaEvent[]; // committed events arriving during cold read (§6.3)
  lastSent: number; // highest seq delivered on this subscription
}

interface Conn {
  ws: WebSocket;
  clientId: string | null; // null until hello; becomes EventSource.clientId (P3)
  subs: Map<string, Subscription>; // sessionId → subscription
  malformed: number;
  oversized: number;
  notReadySent: boolean; // NOT_READY once, close 4400 on repeat (§5.1)
  helloTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  missedPongs: number;
  frameSlots: Map<string, Extract<WireEnvelope, { kind: "frame" }>>;
  frameFlushTimer: ReturnType<typeof setTimeout> | null;
}

type TerminalResponse = Extract<WireEnvelope, { kind: "ack" | "error" }>;
type DedupeEntry = { response: TerminalResponse; expiresAt: number };

export class Gateway {
  readonly wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false,
  });
  #store: EventStore;
  #orchestrator: SessionOrchestrator;
  #conns = new Set<Conn>();
  #bySession = new Map<string, Set<Conn>>();
  #dedupe = new Map<string, DedupeEntry>();

  constructor(store: EventStore, orchestrator: SessionOrchestrator) {
    this.#store = store;
    this.#orchestrator = orchestrator;
    // THE fanout seam (§6.2): clients only ever see committed events.
    store.onCommitted(({ sessionId, events }) =>
      this.#publishCommitted(sessionId, events),
    );
  }

  /** Frame sink for the orchestrator (P12) — never persisted, droppable. */
  publishFrame = (frame: AgenaFrame): void => {
    const conns = this.#bySession.get(frame.sessionId);
    if (!conns) return;
    for (const conn of conns) {
      // buffering subs drop frames by contract (§6.3 step 2)
      if (conn.subs.get(frame.sessionId)?.mode === "live") {
        this.#send(conn, { kind: "frame", frame });
      }
    }
  };

  connect(ws: WebSocket): void {
    const conn: Conn = {
      ws,
      clientId: null,
      subs: new Map(),
      malformed: 0,
      oversized: 0,
      notReadySent: false,
      helloTimer: null,
      pingTimer: null,
      missedPongs: 0,
      frameSlots: new Map(),
      frameFlushTimer: null,
    };
    this.#conns.add(conn);
    conn.helloTimer = setTimeout(
      () => ws.close(WS_CLOSE_CODES.handshakeTimeout, "no hello within 10s"),
      HELLO_TIMEOUT_MS,
    );
    ws.on("message", (data, isBinary) => this.#onMessage(conn, data, isBinary));
    ws.on("error", (err) => log("warn", "ws error", { err: String(err) }));
    ws.on("close", () => this.#drop(conn));
  }

  /** Shutdown teardown: close as going away so clients replay on reconnect. */
  close(): void {
    for (const conn of this.#conns)
      conn.ws.close(WS_CLOSE_CODES.goingAway, "daemon shutdown");
    this.wss.close();
  }

  #onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    const buf = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    if (buf.length > MAX_ENVELOPE_BYTES) {
      conn.oversized += 1;
      if (conn.oversized > MAX_STRIKES) {
        conn.ws.close(WS_CLOSE_CODES.messageTooLarge, "oversized envelopes");
        return;
      }
      this.#sendError(conn, undefined, "PAYLOAD_TOO_LARGE", {
        message: `envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`,
      });
      return;
    }
    let json: unknown;
    try {
      if (isBinary) throw new Error("binary frame on the main WS");
      json = JSON.parse(buf.toString("utf8"));
    } catch {
      conn.malformed += 1;
      if (conn.malformed > MAX_STRIKES) {
        conn.ws.close(WS_CLOSE_CODES.protocolViolation, "malformed messages");
        return;
      }
      this.#sendError(conn, undefined, "INVALID_PAYLOAD", {
        message: "unparseable message",
      });
      return;
    }
    if (conn.clientId === null) {
      this.#handleHello(conn, json);
      return;
    }
    const env = wireEnvelopeSchema.safeParse(json);
    if (!env.success) {
      this.#sendError(conn, undefined, "INVALID_PAYLOAD", {
        message: "not a valid wire envelope",
        details: env.error.issues,
      });
      return;
    }
    switch (env.data.kind) {
      case "pong":
        conn.missedPongs = 0;
        return;
      case "cmd":
        this.#dispatch(
          conn,
          env.data.requestId,
          env.data.name,
          env.data.payload,
        );
        return;
      default:
        this.#sendError(conn, undefined, "INVALID_PAYLOAD", {
          message: `unexpected envelope kind "${env.data.kind}"`,
        });
        return;
    }
  }

  // §5.1 connect sequence: hello first, version gate, then welcome.
  #handleHello(conn: Conn, json: unknown): void {
    const hello = helloEnvelopeSchema.safeParse(json);
    if (!hello.success) {
      if (conn.notReadySent) {
        conn.ws.close(WS_CLOSE_CODES.protocolViolation, "hello required");
        return;
      }
      conn.notReadySent = true;
      this.#sendError(conn, undefined, "NOT_READY", {
        message: "send hello before any other envelope",
      });
      return;
    }
    const v = hello.data.protocolVersion;
    if (v < MIN_SUPPORTED_PROTOCOL_VERSION || v > PROTOCOL_VERSION) {
      this.#sendError(conn, undefined, "PROTOCOL_MISMATCH", {
        message: `daemon supports protocol ${MIN_SUPPORTED_PROTOCOL_VERSION}..${PROTOCOL_VERSION}; client sent ${v}`,
        details: { daemon: PROTOCOL_VERSION, client: v },
      });
      conn.ws.close(WS_CLOSE_CODES.protocolViolation, "protocol mismatch");
      return;
    }
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    conn.clientId = hello.data.clientId;
    this.#send(conn, {
      kind: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: DAEMON_VERSION,
      serverTime: new Date().toISOString(),
      limits: DEFAULT_WIRE_LIMITS,
    });
    conn.pingTimer = setInterval(() => {
      conn.missedPongs += 1;
      if (conn.missedPongs > 2) {
        conn.ws.close(WS_CLOSE_CODES.goingAway, "missed pongs");
        return;
      }
      this.#send(conn, { kind: "ping", ts: new Date().toISOString() });
    }, PING_INTERVAL_MS);
  }

  #dispatch(
    conn: Conn,
    requestId: string,
    name: CommandName,
    payload: unknown,
  ): void {
    this.#purgeDedupe();
    const seen = this.#dedupe.get(requestId);
    if (seen) {
      this.#send(conn, seen.response);
      return;
    }
    const p = commandSchemas[name].payload.safeParse(payload);
    if (!p.success) {
      this.#sendError(conn, requestId, "INVALID_PAYLOAD", {
        message: `invalid ${name} payload`,
        details: p.error.issues,
      });
      return;
    }
    if (name === "subscribe") {
      void this.#subscribe(conn, requestId, p.data as SubscribeCmd);
    } else {
      void this.#prompt(conn, requestId, p.data as PromptCmd);
    }
  }

  // §6.3 buffer-then-splice: ack → cold read (replayed:true) → drain buffer → sync → live.
  async #subscribe(
    conn: Conn,
    requestId: string,
    cmd: SubscribeCmd,
  ): Promise<void> {
    if (conn.subs.has(cmd.sessionId)) {
      this.#sendError(conn, requestId, "ALREADY_SUBSCRIBED", {
        message: `already subscribed to ${cmd.sessionId} on this connection`,
      });
      return;
    }
    if (conn.subs.size >= DEFAULT_WIRE_LIMITS.maxSubscriptions) {
      this.#sendError(conn, requestId, "SUBSCRIPTION_LIMIT", {
        message: `max ${DEFAULT_WIRE_LIMITS.maxSubscriptions} subscriptions per connection`,
      });
      return;
    }
    // ponytail: cmd.branchId ignored — single root branch until M5 forking
    const sub: Subscription = {
      mode: "buffering",
      buffer: [], // filled during replay; capped in #publishCommitted
      lastSent: cmd.fromSeq,
    };
    // reserve before the await so a concurrent same-session subscribe fails fast
    conn.subs.set(cmd.sessionId, sub);
    let set = this.#bySession.get(cmd.sessionId);
    if (!set) {
      set = new Set();
      this.#bySession.set(cmd.sessionId, set);
    }
    set.add(conn);
    const record = await this.#store.getSession(cmd.sessionId);
    if (!record) {
      conn.subs.delete(cmd.sessionId);
      set.delete(conn);
      if (set.size === 0) this.#bySession.delete(cmd.sessionId);
      this.#sendError(conn, requestId, "SESSION_NOT_FOUND", {
        message: `unknown session ${cmd.sessionId}`,
      });
      return;
    }
    this.#sendAck(conn, requestId, {
      kind: "ack",
      result: {
        lastSeq: record.lastSeq,
        branchId: record.rootBranchId,
        replayCount: Math.max(0, record.lastSeq - cmd.fromSeq),
      },
    });
    try {
      let from = cmd.fromSeq;
      for (;;) {
        const page = await this.#store.readEvents(
          cmd.sessionId,
          from,
          REPLAY_PAGE,
        );
        for (const event of page.events) {
          this.#send(conn, { kind: "event", event, replayed: true });
          sub.lastSent = event.seq;
        }
        if (page.nextFromSeq === null) break;
        from = page.nextFromSeq;
      }
    } catch (err) {
      log("error", "replay failed", {
        sessionId: cmd.sessionId,
        err: String(err),
      });
      this.#sendError(conn, undefined, "INTERNAL", {
        message: "replay failed",
      });
      return;
    }
    for (const event of sub.buffer) {
      if (event.seq <= sub.lastSent) continue; // dedupe the cold/live overlap
      this.#send(conn, { kind: "event", event, replayed: true });
      sub.lastSent = event.seq;
    }
    sub.buffer = [];
    sub.mode = "live";
    this.#send(conn, {
      kind: "sync",
      sessionId: cmd.sessionId,
      branchId: record.rootBranchId,
      upToSeq: sub.lastSent,
    });
    this.#send(conn, {
      kind: "snapshot",
      snapshot: await this.#orchestrator.inFlightSnapshot(
        cmd.sessionId,
        record.rootBranchId,
        sub.lastSent,
      ),
    });
  }

  // §5.4 prompt: ack {messageId, seq} strictly after message.user.created commits.
  async #prompt(conn: Conn, requestId: string, cmd: PromptCmd): Promise<void> {
    try {
      const result = await this.#orchestrator.handlePrompt(
        cmd.sessionId,
        cmd.content,
        conn.clientId ?? undefined,
      );
      this.#sendAck(conn, requestId, { kind: "ack", result });
    } catch (err) {
      if (err instanceof OrchestratorError) {
        this.#sendError(conn, requestId, err.code, { message: err.message });
        return;
      }
      log("error", "prompt failed", {
        sessionId: cmd.sessionId,
        err: String(err),
      });
      this.#sendError(conn, requestId, "INTERNAL", {
        message: "internal error",
      });
    }
  }

  #publishCommitted(sessionId: string, events: AgenaEvent[]): void {
    const conns = this.#bySession.get(sessionId);
    if (!conns) return;
    for (const conn of conns) {
      const sub = conn.subs.get(sessionId);
      if (!sub) continue;
      if (sub.mode === "buffering") {
        sub.buffer.push(...events);
        if (sub.buffer.length > SUBSCRIBE_BUFFER_LIMIT) {
          // ponytail: bounded buffer; reconnect replay is the recovery path.
          conn.ws.close(
            WS_CLOSE_CODES.slowConsumer,
            "subscribe buffer overflow",
          );
        }
        continue;
      }
      for (const event of events) {
        if (event.seq <= sub.lastSent) continue;
        this.#send(conn, { kind: "event", event, replayed: false });
        sub.lastSent = event.seq;
      }
    }
  }

  #send(conn: Conn, env: WireEnvelope): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    switch (backpressureAction(env.kind, conn.ws.bufferedAmount)) {
      case "close":
        conn.ws.close(WS_CLOSE_CODES.slowConsumer, "slow consumer");
        return;
      case "coalesce":
        this.#coalesceFrame(
          conn,
          env as Extract<WireEnvelope, { kind: "frame" }>,
          false,
        );
        return;
      case "drop":
        this.#coalesceFrame(
          conn,
          env as Extract<WireEnvelope, { kind: "frame" }>,
          true,
        );
        return;
      case "send":
        break;
    }
    conn.ws.send(JSON.stringify(env));
    this.#flushFrames(conn);
  }

  #sendAck(
    conn: Conn,
    requestId: string,
    env: Omit<Extract<WireEnvelope, { kind: "ack" }>, "requestId">,
  ): void {
    const response: TerminalResponse = { ...env, requestId };
    this.#remember(requestId, response);
    this.#send(conn, response);
  }

  #sendError(
    conn: Conn,
    requestId: string | undefined,
    code: ErrorCode,
    opts: { message: string; details?: unknown },
  ): void {
    const error: AgenaError = {
      code,
      message: opts.message,
      retryable: code === "SESSION_BUSY",
      ...(opts.details !== undefined ? { details: opts.details } : {}),
    };
    const env: TerminalResponse = {
      kind: "error",
      ...(requestId !== undefined ? { requestId } : {}),
      error,
    };
    if (requestId !== undefined) this.#remember(requestId, env);
    this.#send(conn, env);
  }

  #remember(requestId: string, response: TerminalResponse): void {
    this.#dedupe.set(requestId, {
      response,
      expiresAt: Date.now() + REQUEST_DEDUPE_TTL_MS,
    });
  }

  #purgeDedupe(): void {
    const now = Date.now();
    for (const [requestId, entry] of this.#dedupe) {
      if (entry.expiresAt <= now) this.#dedupe.delete(requestId);
    }
  }

  #coalesceFrame(
    conn: Conn,
    env: Extract<WireEnvelope, { kind: "frame" }>,
    dropPressure: boolean,
  ): void {
    const key = frameKey(env.frame);
    const prev = conn.frameSlots.get(key);
    if (!prev || dropPressure) {
      conn.frameSlots.set(key, env);
    } else {
      conn.frameSlots.set(key, mergeFrame(prev, env));
    }
    if (!conn.frameFlushTimer) {
      conn.frameFlushTimer = setTimeout(() => {
        conn.frameFlushTimer = null;
        this.#flushFrames(conn);
      }, 10);
    }
  }

  #flushFrames(conn: Conn): void {
    if (
      conn.ws.readyState !== WebSocket.OPEN ||
      conn.ws.bufferedAmount > FRAME_COALESCE_BUFFERED_BYTES
    ) {
      return;
    }
    const frames = [...conn.frameSlots.values()];
    conn.frameSlots.clear();
    for (const frame of frames) this.#send(conn, frame);
  }

  #drop(conn: Conn): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    if (conn.frameFlushTimer) clearTimeout(conn.frameFlushTimer);
    for (const sessionId of conn.subs.keys()) {
      const set = this.#bySession.get(sessionId);
      set?.delete(conn);
      if (set?.size === 0) this.#bySession.delete(sessionId);
    }
    this.#conns.delete(conn);
  }
}

function frameKey(frame: AgenaFrame): string {
  const payload =
    frame.payload && typeof frame.payload === "object"
      ? (frame.payload as Record<string, unknown>)
      : {};
  const target =
    typeof payload.messageId === "string"
      ? payload.messageId
      : typeof payload.toolCallId === "string"
        ? payload.toolCallId
        : "";
  const block =
    typeof payload.blockIndex === "number" ? String(payload.blockIndex) : "";
  return `${frame.sessionId}:${frame.type}:${target}:${block}`;
}

function mergeFrame(
  prev: Extract<WireEnvelope, { kind: "frame" }>,
  next: Extract<WireEnvelope, { kind: "frame" }>,
): Extract<WireEnvelope, { kind: "frame" }> {
  if (prev.frame.type !== "message.assistant.text.delta") return next;
  if (next.frame.type !== "message.assistant.text.delta") return next;
  const a = record(prev.frame.payload);
  const b = record(next.frame.payload);
  if (typeof a.delta !== "string" || typeof b.delta !== "string") return next;
  return {
    kind: "frame",
    frame: {
      ...next.frame,
      payload: { ...b, delta: a.delta + b.delta },
    },
  };
}

function record(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}
