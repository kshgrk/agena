import { describe, expect, it } from "vitest";
import {
  type AgenaEvent,
  commandSchemas,
  createPtyRequestSchema,
  createPtyResponseSchema,
  DEFAULT_WIRE_LIMITS,
  durableEventSchemas,
  knownAgenaEventSchema,
  knownAgenaFrameSchema,
  PROTOCOL_VERSION,
  PTY_HTTP_ROUTES,
  PTY_IDLE_TIMEOUT_MS,
  PTY_PAUSE_BUFFERED_BYTES,
  PTY_RESUME_BUFFERED_BYTES,
  PTY_SCROLLBACK_BYTES,
  ptyClientControlFrameSchema,
  ptyDaemonControlFrameSchema,
  type WireEnvelope,
  WS_CLOSE_CODES,
  wireEnvelopeSchema,
} from "../src/index.ts";

const source = { kind: "user", clientId: "01CLIENT" } as const;

const validEvent: AgenaEvent = {
  sessionId: "01SESSION",
  branchId: "01BRANCH",
  seq: 1,
  type: "session.created",
  v: 1,
  createdAt: "2026-07-06T00:00:00.000Z",
  source,
  payload: {
    workspaceId: "01WS",
    runtime: "pi",
    origin: "native",
    rootBranchId: "01BRANCH",
  },
};

// One sample per envelope kind — the loop below asserts full coverage of the union.
const samples: WireEnvelope[] = [
  {
    kind: "hello",
    protocolVersion: PROTOCOL_VERSION,
    client: { name: "agena", version: "0.0.0", platform: "darwin" },
    clientId: "01CLIENT",
  },
  {
    kind: "welcome",
    protocolVersion: PROTOCOL_VERSION,
    daemonVersion: "0.0.0",
    serverTime: "2026-07-06T00:00:00.000Z",
    limits: DEFAULT_WIRE_LIMITS,
  },
  {
    kind: "cmd",
    requestId: "01REQ",
    name: "subscribe",
    payload: { sessionId: "01SESSION", fromSeq: 0 },
  },
  { kind: "ack", requestId: "01REQ", result: { messageId: "01MSG", seq: 2 } },
  {
    kind: "error",
    requestId: "01REQ",
    error: { code: "SESSION_BUSY", message: "turn active", retryable: true },
  },
  { kind: "event", event: validEvent, replayed: true },
  {
    kind: "frame",
    frame: {
      type: "message.assistant.text.delta",
      sessionId: "01SESSION",
      branchId: "01BRANCH",
      afterSeq: 3,
      emittedAt: "2026-07-06T00:00:00.000Z",
      payload: { messageId: "01MSG", blockIndex: 0, delta: "hel" },
    },
  },
  { kind: "sync", sessionId: "01SESSION", branchId: "01BRANCH", upToSeq: 3 },
  {
    kind: "snapshot",
    snapshot: {
      sessionId: "01SESSION",
      branchId: "01BRANCH",
      afterSeq: 3,
      assistant: null,
      toolCalls: [],
      pendingApprovals: [],
      retry: null,
      queue: { steerCount: 0, followUpCount: 0 },
      status: { state: "idle" },
    },
  },
  { kind: "ping", ts: "2026-07-06T00:00:00.000Z" },
  { kind: "pong", ts: "2026-07-06T00:00:00.000Z" },
];

describe("suite 1: registries", () => {
  it("latest v == 1 for every event type (no upcast chains yet)", () => {
    // ponytail: when upcasts.ts exists (M2+), assert latest v == 1 + chain length instead
    expect(knownAgenaEventSchema.safeParse(validEvent).success).toBe(true);
    expect(
      knownAgenaEventSchema.safeParse({ ...validEvent, v: 2 }).success,
    ).toBe(false);
  });
});

describe("envelope round-trip and discrimination", () => {
  it("covers every WireEnvelope kind", () => {
    expect(new Set(samples.map((s) => s.kind)).size).toBe(
      wireEnvelopeSchema.options.length,
    );
  });

  it.each(
    samples.map((s) => [s.kind, s] as const),
  )("%s survives encode -> parse", (_kind, envelope) => {
    const parsed = wireEnvelopeSchema.parse(
      JSON.parse(JSON.stringify(envelope)),
    );
    expect(parsed).toEqual(envelope);
  });

  it("rejects unknown kinds and malformed envelopes", () => {
    expect(wireEnvelopeSchema.safeParse({ kind: "caughtUp" }).success).toBe(
      false,
    );
    expect(wireEnvelopeSchema.safeParse({ kind: "ack" }).success).toBe(false); // no requestId
    expect(
      wireEnvelopeSchema.safeParse({
        kind: "cmd",
        requestId: "r",
        name: "abort",
        payload: {},
      }).success,
    ).toBe(false); // abort is not an M1 command
    expect(
      wireEnvelopeSchema.safeParse({
        kind: "error",
        error: { code: "E_NOPE", message: "x", retryable: false },
      }).success,
    ).toBe(false); // dead draft code spelling
  });
});

describe("command payloads", () => {
  it("validates subscribe and prompt, rejects invalid payloads", () => {
    expect(
      commandSchemas.subscribe.payload.safeParse({ sessionId: "s", fromSeq: 0 })
        .success,
    ).toBe(true);
    expect(
      commandSchemas.subscribe.payload.safeParse({
        sessionId: "s",
        fromSeq: -1,
      }).success,
    ).toBe(false);
    expect(
      commandSchemas.prompt.payload.safeParse({
        sessionId: "s",
        content: [{ type: "text", text: "hi" }],
      }).success,
    ).toBe(true);
    // v1: prompt content is text blocks only (§5.4)
    expect(
      commandSchemas.prompt.payload.safeParse({
        sessionId: "s",
        content: [{ type: "image", ref: {} }],
      }).success,
    ).toBe(false);
    expect(
      commandSchemas.subscribe.ack.parse({
        lastSeq: 3,
        branchId: "b",
        replayCount: 3,
      }),
    ).toBeTruthy();
  });
});

describe("M3 PTY protocol surface", () => {
  it("validates dedicated PTY WS text controls only", () => {
    expect(
      ptyClientControlFrameSchema.parse({
        type: "resize",
        cols: 211,
        rows: 52,
      }),
    ).toEqual({ type: "resize", cols: 211, rows: 52 });
    expect(
      ptyClientControlFrameSchema.safeParse({
        type: "resize",
        cols: 0,
        rows: 52,
      }).success,
    ).toBe(false);
    expect(
      ptyDaemonControlFrameSchema.parse({
        type: "exit",
        exitCode: 0,
        signal: null,
      }),
    ).toEqual({ type: "exit", exitCode: 0, signal: null });
    expect(
      ptyDaemonControlFrameSchema.safeParse({
        type: "exit",
        exitCode: 0,
      }).success,
    ).toBe(false);
  });

  it("exports PTY routes and close codes", () => {
    expect(createPtyRequestSchema.parse({ cols: 80, rows: 24 })).toEqual({
      cols: 80,
      rows: 24,
    });
    expect(
      createPtyResponseSchema.parse({
        ptyId: "01PTY",
        wsPath: "/v1/ptys/01PTY/ws",
      }),
    ).toEqual({ ptyId: "01PTY", wsPath: "/v1/ptys/01PTY/ws" });
    expect(PTY_HTTP_ROUTES.createPty.path).toBe("/v1/ptys");
    expect(PTY_HTTP_ROUTES.attachPty.path).toBe("/v1/ptys/:id/ws");
    expect(WS_CLOSE_CODES.ptyAlreadyAttached).toBe(4409);
    expect(WS_CLOSE_CODES.authInvalidated).toBe(4401);
    expect(PTY_IDLE_TIMEOUT_MS).toBe(900_000);
    expect(PTY_SCROLLBACK_BYTES).toBe(262_144);
    expect(PTY_PAUSE_BUFFERED_BYTES).toBe(1_048_576);
    expect(PTY_RESUME_BUFFERED_BYTES).toBe(262_144);
  });
});

describe("event payloads and unknown types (§5.10)", () => {
  it("rejects a known type with a bad payload", () => {
    const bad = { ...validEvent, payload: { workspaceId: "01WS" } };
    expect(knownAgenaEventSchema.safeParse(bad).success).toBe(false);
    expect(
      durableEventSchemas["session.created"].safeParse(bad.payload).success,
    ).toBe(false);
  });

  it("unknown event types still parse on the wire (client renders a generic row)", () => {
    const unknown = {
      ...validEvent,
      type: "session.title.changed",
      payload: { title: "x" },
    };
    const parsed = wireEnvelopeSchema.parse({
      kind: "event",
      event: unknown,
      replayed: false,
    });
    expect(parsed.kind).toBe("event");
    // ...but it is not in the known catalog: narrowing fails, registry has no entry
    expect(knownAgenaEventSchema.safeParse(unknown).success).toBe(false);
    expect(unknown.type in durableEventSchemas).toBe(false);
  });

  it("frames: known payload validates, unknown frame types stay wire-parseable", () => {
    const frame = {
      type: "message.assistant.thinking.delta", // not an M1 frame
      sessionId: "s",
      branchId: "b",
      afterSeq: 0,
      emittedAt: "2026-07-06T00:00:00.000Z",
      payload: { messageId: "m", blockIndex: 0, delta: "…" },
    };
    expect(wireEnvelopeSchema.safeParse({ kind: "frame", frame }).success).toBe(
      true,
    );
    expect(knownAgenaFrameSchema.safeParse(frame).success).toBe(false);
    expect(
      knownAgenaFrameSchema.safeParse({
        ...frame,
        type: "message.assistant.text.delta",
      }).success,
    ).toBe(true);
  });
});
