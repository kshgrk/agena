import { describe, expect, it } from "vitest";
import {
  type AgenaEvent,
  commandSchemas,
  createDerivedSessionRequestSchema,
  createProjectRequestSchema,
  createPtyRequestSchema,
  createPtyResponseSchema,
  createSessionRequestSchema,
  DEFAULT_WIRE_LIMITS,
  diagnosticsResponseSchema,
  durableEventSchemas,
  fileUploadQuerySchema,
  fileUploadResponseSchema,
  knownAgenaEventSchema,
  knownAgenaFrameSchema,
  listSessionsQuerySchema,
  PROTOCOL_VERSION,
  PTY_HTTP_ROUTES,
  PTY_IDLE_TIMEOUT_MS,
  PTY_PAUSE_BUFFERED_BYTES,
  PTY_RESUME_BUFFERED_BYTES,
  PTY_SCROLLBACK_BYTES,
  projectResponseSchema,
  ptyClientControlFrameSchema,
  ptyDaemonControlFrameSchema,
  sessionSummarySchema,
  visibleBrowserActionSchema,
  visibleBrowserResultSchema,
  type WireEnvelope,
  WS_CLOSE_CODES,
  wireEnvelopeSchema,
} from "../src/index.ts";

it("keeps quick-chat cutoff selection server-owned", () => {
  expect(
    createDerivedSessionRequestSchema.parse({
      mode: "fork",
      purpose: "quick_chat",
    }),
  ).toEqual({ mode: "fork", purpose: "quick_chat" });
  expect(() =>
    createDerivedSessionRequestSchema.parse({
      mode: "clone",
      purpose: "quick_chat",
    }),
  ).toThrow();
  expect(() =>
    createDerivedSessionRequestSchema.parse({
      mode: "fork",
      purpose: "quick_chat",
      sourceMessageId: "caller-cutoff",
    }),
  ).toThrow();
});

it("visible browser actions and results carry deterministic tab identity", () => {
  expect(
    visibleBrowserActionSchema.parse({
      action: "navigate",
      tabId: "tab-1",
      kind: "reload",
    }),
  ).toMatchObject({ tabId: "tab-1" });
  expect(() => visibleBrowserActionSchema.parse({ action: "close" })).toThrow();
  expect(
    visibleBrowserResultSchema.parse({
      tabId: "tab-1",
      url: "https://example.com",
      title: "Example",
      tabs: [
        {
          tabId: "tab-1",
          url: "https://example.com",
          title: "Example",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
    }),
  ).toMatchObject({ tabId: "tab-1" });
});

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
    scope: "project",
    projectId: "project-a",
    projectRoot: ".",
    cwd: ".",
    rootBranchId: "01BRANCH",
  },
};

// One sample per envelope kind — the loop below asserts full coverage of the union.
const samples: WireEnvelope[] = [
  {
    kind: "hello",
    protocolVersion: PROTOCOL_VERSION,
    client: {
      name: "agena",
      version: "0.0.0",
      platform: "darwin",
      capabilities: ["visible_browser"],
    },
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
  {
    kind: "visibleBrowserRequest",
    requestId: "01BROWSER",
    action: { action: "read", sessionId: "01SESSION" },
  },
  {
    kind: "visibleBrowserResponse",
    requestId: "01BROWSER",
    result: {
      url: "https://example.com/",
      title: "Example",
      text: "Example Domain",
    },
  },
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
        payload: { sessionId: "s" },
      }).success,
    ).toBe(true);
    expect(
      wireEnvelopeSchema.safeParse({
        kind: "error",
        error: { code: "E_NOPE", message: "x", retryable: false },
      }).success,
    ).toBe(false); // dead draft code spelling
  });
});

describe("command payloads", () => {
  it("validates subscribe, prompt, and M4.5 controls", () => {
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
    // v1 prompt input accepts images but not general file blocks (§5.4).
    expect(
      commandSchemas.prompt.payload.safeParse({
        sessionId: "s",
        content: [
          {
            type: "image",
            ref: {
              blob: `sha256:${"0".repeat(64)}`,
              sizeBytes: 3,
              mimeType: "image/png",
            },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      commandSchemas.prompt.payload.safeParse({
        sessionId: "s",
        content: [{ type: "file", ref: {} }],
      }).success,
    ).toBe(false);
    expect(
      commandSchemas.subscribe.ack.parse({
        lastSeq: 3,
        branchId: "b",
        replayCount: 3,
      }),
    ).toBeTruthy();
    for (const name of ["steer", "followUp"] as const) {
      expect(
        commandSchemas[name].payload.safeParse({
          sessionId: "s",
          content: [{ type: "text", text: "hi" }],
        }).success,
      ).toBe(true);
      expect(
        commandSchemas[name].payload.safeParse({
          sessionId: "s",
          content: [{ type: "thinking", text: "nope" }],
        }).success,
      ).toBe(false);
    }
    expect(
      commandSchemas.abort.payload.parse({
        sessionId: "s",
        reason: "changed my mind",
      }),
    ).toEqual({ sessionId: "s", reason: "changed my mind" });
    expect(
      commandSchemas.runtimeInfo.ack.parse({
        model: { provider: "openai", id: "gpt-5.5-pro" },
        thinkingLevel: "medium",
        availableModels: [{ provider: "openai", id: "gpt-5.5-pro" }],
        availableThinkingLevels: ["off", "medium", "high"],
        slashCommands: [{ name: "deploy", description: "Deploy" }],
      }),
    ).toEqual({
      model: { provider: "openai", id: "gpt-5.5-pro" },
      thinkingLevel: "medium",
      availableModels: [{ provider: "openai", id: "gpt-5.5-pro" }],
      availableThinkingLevels: ["off", "medium", "high"],
      slashCommands: [{ name: "deploy", description: "Deploy" }],
    });
    expect(
      commandSchemas.setModel.ack.parse({
        model: { provider: "openai", id: "gpt-5.5-pro" },
      }),
    ).toEqual({ model: { provider: "openai", id: "gpt-5.5-pro" } });
    expect(
      commandSchemas.setThinkingLevel.payload.parse({
        sessionId: "s",
        thinkingLevel: "high",
      }),
    ).toEqual({ sessionId: "s", thinkingLevel: "high" });
    expect(
      commandSchemas.setFastMode.ack.parse({
        enabled: true,
        available: true,
        active: true,
      }),
    ).toEqual({ enabled: true, available: true, active: true });
    expect(
      commandSchemas.respondToApproval.payload.parse({
        sessionId: "s",
        approvalId: "a",
        response: { kind: "editor", text: "multi\nline" },
      }),
    ).toEqual({
      sessionId: "s",
      approvalId: "a",
      response: { kind: "editor", text: "multi\nline" },
    });
    expect(commandSchemas.compact.ack.parse({ compactionSeq: 12 })).toEqual({
      compactionSeq: 12,
    });
  });
});

describe("M4.5 durable event payloads", () => {
  it("validates model, thinking, compaction, and approval events", () => {
    expect(
      durableEventSchemas["model.changed"].parse({
        to: { provider: "openai", id: "gpt-5.5-pro" },
        reason: "user_selected",
      }),
    ).toEqual({
      to: { provider: "openai", id: "gpt-5.5-pro" },
      reason: "user_selected",
    });
    expect(
      durableEventSchemas["thinking.level.changed"].parse({
        from: "medium",
        to: "high",
      }),
    ).toEqual({ from: "medium", to: "high" });
    expect(
      durableEventSchemas["fast.mode.changed"].parse({ enabled: true }),
    ).toEqual({ enabled: true });
    expect(
      durableEventSchemas["compaction.created"].parse({
        compactionId: "c",
        summary: [{ type: "text", text: "summary" }],
        replacesUpToSeq: 10,
        trigger: "user",
      }),
    ).toEqual({
      compactionId: "c",
      summary: [{ type: "text", text: "summary" }],
      replacesUpToSeq: 10,
      trigger: "user",
    });
    const approvalEvent = {
      ...validEvent,
      type: "approval.responded",
      payload: {
        approvalId: "a",
        response: { kind: "confirm", accepted: true },
        respondedBy: "01CLIENT",
      },
    };
    expect(knownAgenaEventSchema.safeParse(approvalEvent).success).toBe(true);
    expect(
      durableEventSchemas["approval.requested"].safeParse({
        approvalId: "a",
        kind: "select",
        message: "Pick one",
        options: [{ id: "yes", label: "Yes" }],
      }).success,
    ).toBe(true);
    expect(
      durableEventSchemas["approval.requested"].parse({
        approvalId: "a",
        kind: "confirm",
        message: "Run shell command?",
        subject: {
          toolName: "shell",
          args: { command: "pnpm test" },
          cwd: "/workspace",
          command: "pnpm test",
          action: "execute",
        },
      }),
    ).toEqual({
      approvalId: "a",
      kind: "confirm",
      message: "Run shell command?",
      subject: {
        toolName: "shell",
        args: { command: "pnpm test" },
        cwd: "/workspace",
        command: "pnpm test",
        action: "execute",
      },
    });
  });
});

describe("M4 session HTTP scope schemas", () => {
  it("validates project create and list filters", () => {
    expect(
      createSessionRequestSchema.parse({
        title: "work",
        scope: "project",
        projectId: "project-a",
        projectRoot: ".",
        cwd: "packages/core",
        hostCwdHint: "/host/repo/packages/core",
      }),
    ).toEqual({
      title: "work",
      scope: "project",
      projectId: "project-a",
      projectRoot: ".",
      cwd: "packages/core",
      hostCwdHint: "/host/repo/packages/core",
    });
    expect(
      createSessionRequestSchema.safeParse({
        scope: "project",
        projectRoot: ".",
      }).success,
    ).toBe(false);
    expect(createSessionRequestSchema.parse({ scope: "global" })).toEqual({
      scope: "global",
    });
    expect(listSessionsQuerySchema.parse({ projectId: "project-a" })).toEqual({
      projectId: "project-a",
    });
    expect(listSessionsQuerySchema.parse({ allProjects: "true" })).toEqual({
      allProjects: true,
    });
  });
});

it("accepts compact durable subagent metadata in a session summary", () => {
  expect(
    sessionSummarySchema.parse({
      sessionId: "child-1",
      workspaceId: "workspace-1",
      rootBranchId: "branch-1",
      lastSeq: 1,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:01.000Z",
      scope: "project",
      status: "active",
      cwd: ".",
      sessionKind: "subagent",
      parentSessionId: "parent-1",
      parentTaskId: "task-1",
      subagent: {
        taskId: "task-1",
        role: "security",
        status: "completed",
        createdAt: "2026-07-12T00:00:00.000Z",
        startedAt: "2026-07-12T00:00:00.000Z",
        finishedAt: "2026-07-12T00:00:01.000Z",
      },
    }),
  ).toMatchObject({
    parentSessionId: "parent-1",
    parentTaskId: "task-1",
    subagent: { taskId: "task-1", status: "completed" },
  });
});

describe("M5 diagnostics HTTP schema", () => {
  it("validates project init and tar upload routes", () => {
    expect(createProjectRequestSchema.parse({ name: "My App" })).toEqual({
      name: "My App",
    });
    expect(
      projectResponseSchema.parse({
        name: "my-app",
        projectId: "prj_my-app",
        projectRoot: "my-app",
        cwd: "my-app",
      }),
    ).toEqual({
      name: "my-app",
      projectId: "prj_my-app",
      projectRoot: "my-app",
      cwd: "my-app",
    });
    expect(
      fileUploadQuerySchema.parse({ path: "my-app", format: "tar" }),
    ).toEqual({ path: "my-app", format: "tar" });
    expect(
      fileUploadResponseSchema.parse({ path: "my-app", fileCount: 2 }),
    ).toEqual({ path: "my-app", fileCount: 2 });
    expect(PTY_HTTP_ROUTES.createProject.path).toBe("/v1/projects");
    expect(PTY_HTTP_ROUTES.uploadFiles.path).toBe("/v1/files/upload");
  });

  it("validates .agena discovery entries", () => {
    expect(
      diagnosticsResponseSchema.parse({
        daemon: { version: "0.0.0", uptimeMs: 1 },
        protocol: { version: 1 },
        workspace: { path: "/workspace" },
        discovery: {
          entries: [
            {
              kind: "tool",
              name: "bad",
              file: ".agena/tools/bad.ts",
              status: "invalid",
              reason: "missing default export defineTool(...)",
            },
          ],
        },
      }).discovery.entries[0]?.status,
    ).toBe("invalid");
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

  it("session title changes are durable known events", () => {
    const renamed = {
      ...validEvent,
      type: "session.title.changed",
      payload: { title: "x" },
    };
    expect(knownAgenaEventSchema.safeParse(renamed).success).toBe(true);
    expect(
      durableEventSchemas["session.title.changed"].parse(renamed.payload),
    ).toEqual({ title: "x" });
  });

  it("unknown event types still parse on the wire (client renders a generic row)", () => {
    const unknown = {
      ...validEvent,
      type: "session.renamed",
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
