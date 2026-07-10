import { durableEventSchemas } from "@agena/protocol";
import { describe, expect, it } from "vitest";
import {
  convertToPi,
  groupCodexThreads,
  parseClaudeSession,
  parseCodexRollout,
  parsePiSession,
  synthesizeEvents,
  titleFromEntries,
} from "../src/index.ts";

// Hand-written minimal fixtures modeled on the real formats — no copied session content.

const jsonl = (lines: unknown[]) =>
  `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

const claudeFixture = jsonl([
  { type: "file-history-snapshot", messageId: "m0" },
  {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    sessionId: "claude-sess-1",
    cwd: "/Users/dev/proj",
    timestamp: "2026-01-02T03:04:05.000Z",
    message: { role: "user", content: "fix the login bug\nplease" },
  },
  {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    sessionId: "claude-sess-1",
    cwd: "/Users/dev/proj",
    timestamp: "2026-01-02T03:04:06.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4",
      content: [
        { type: "text", text: "On it." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "read",
          input: { path: "a.ts" },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  },
  {
    type: "user",
    uuid: "u2",
    parentUuid: "a1",
    sessionId: "claude-sess-1",
    timestamp: "2026-01-02T03:04:07.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: "file contents",
        },
      ],
    },
  },
]);

const codexMeta = (id: string, ts: string) => ({
  timestamp: ts,
  type: "session_meta",
  payload: { id, timestamp: ts, cwd: "/Users/dev/proj" },
});

const codexUser = (text: string, ts: string, extra: unknown[] = []) => ({
  timestamp: ts,
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [...extra, { type: "input_text", text }],
  },
});

describe("parseClaudeSession", () => {
  const parsed = parseClaudeSession(claudeFixture, "/src/claude.jsonl");

  it("extracts cwd, session id, and messages (tool results split out)", () => {
    expect(parsed).not.toBeNull();
    expect(parsed?.cwd).toBe("/Users/dev/proj");
    expect(parsed?.sourceSessionId).toBe("claude-sess-1");
    expect(
      parsed?.entries.map((e) => (e.kind === "message" ? e.role : e.kind)),
    ).toEqual(["user", "assistant", "toolResult"]);
  });

  it("converts to pi v3 with the target cwd", () => {
    const converted = convertToPi(parsed as NonNullable<typeof parsed>, {
      targetCwd: "/workspace/proj",
    });
    expect(converted).not.toBeNull();
    const lines = (converted?.jsonl ?? "")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      type: "session",
      version: 3,
      cwd: "/workspace/proj",
    });
    expect(converted?.title).toBe("fix the login bug");
    expect(converted?.messageCount).toBe(2);
    // linear parentId chain
    expect(lines[1].parentId).toBeNull();
    expect(lines[2].parentId).toBe(lines[1].id);
    expect(lines[3].message.role).toBe("toolResult");
    // pi reads usage.totalTokens unguarded on resume — assistant messages must
    // carry the full pi usage + stopReason shape.
    expect(lines[2].message.stopReason).toBe("toolUse");
    expect(lines[2].message.usage).toEqual({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(lines[1].message.usage).toBeUndefined(); // user messages: no usage
  });

  it("carries cache tokens into totalTokens so pi auto-compaction sees real context", () => {
    const parsed = parseClaudeSession(
      jsonl([
        {
          type: "user",
          uuid: "u1",
          sessionId: "s",
          cwd: "/p",
          timestamp: "2026-01-02T03:04:05.000Z",
          message: { role: "user", content: "hi" },
        },
        {
          type: "assistant",
          uuid: "a1",
          sessionId: "s",
          timestamp: "2026-01-02T03:04:06.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [{ type: "text", text: "hello" }],
            usage: {
              input_tokens: 2,
              output_tokens: 861,
              cache_read_input_tokens: 272781,
              cache_creation_input_tokens: 717,
            },
          },
        },
      ]),
      "/src/cache.jsonl",
    );
    const converted = convertToPi(parsed as NonNullable<typeof parsed>, {
      targetCwd: "/w/p",
    });
    const assistant = (converted?.jsonl ?? "")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((l) => l.message?.role === "assistant");
    expect(assistant.message.usage).toMatchObject({
      input: 2,
      output: 861,
      cacheRead: 272781,
      cacheWrite: 717,
      totalTokens: 2 + 861 + 272781 + 717,
    });
  });

  it("estimates usage on the last assistant message when the source has none", () => {
    // codex records no usage; without an estimate pi's compaction never triggers
    const parsed = parseCodexRollout(
      jsonl([
        codexMeta("thread-est", "2026-02-01T00:00:00.000Z"),
        codexUser("x".repeat(4000), "2026-02-01T00:00:01.000Z"),
        {
          timestamp: "2026-02-01T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "y".repeat(4000) }],
          },
        },
      ]),
      "/src/rollout-est.jsonl",
    );
    const converted = convertToPi(parsed as NonNullable<typeof parsed>, {
      targetCwd: "/w/p",
    });
    const assistant = (converted?.jsonl ?? "")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((l) => l.message?.role === "assistant");
    // ~8000 chars / 4 ≈ 2000 estimated tokens, carried as input
    expect(assistant.message.usage.totalTokens).toBeGreaterThanOrEqual(1900);
    expect(assistant.message.usage.totalTokens).toBeLessThanOrEqual(2100);
  });

  it("merges assistant lines sharing an API message.id into one message", () => {
    // Claude Code writes one JSONL line per content block of a single API turn;
    // unmerged, tool_result pairing breaks on resume (Anthropic 400).
    const split = jsonl([
      {
        type: "user",
        uuid: "u1",
        sessionId: "s",
        cwd: "/p",
        timestamp: "2026-01-02T03:04:05.000Z",
        message: { role: "user", content: "go" },
      },
      {
        type: "assistant",
        uuid: "a1",
        sessionId: "s",
        timestamp: "2026-01-02T03:04:06.000Z",
        message: {
          role: "assistant",
          id: "msg_api_1",
          model: "claude-opus-4",
          content: [{ type: "text", text: "Working." }],
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        sessionId: "s",
        timestamp: "2026-01-02T03:04:06.500Z",
        message: {
          role: "assistant",
          id: "msg_api_1",
          model: "claude-opus-4",
          content: [
            { type: "tool_use", id: "toolu_a", name: "read", input: {} },
          ],
          usage: { input_tokens: 10, output_tokens: 7 },
        },
      },
      {
        type: "user",
        uuid: "u2",
        sessionId: "s",
        timestamp: "2026-01-02T03:04:07.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", content: "ok" },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "a3",
        sessionId: "s",
        timestamp: "2026-01-02T03:04:08.000Z",
        message: {
          role: "assistant",
          id: "msg_api_2",
          model: "claude-opus-4",
          content: [{ type: "text", text: "Done." }],
        },
      },
    ]);
    const merged = parseClaudeSession(split, "/src/split.jsonl");
    const shapes = merged?.entries.map((e) =>
      e.kind === "message"
        ? `${e.role}:${e.content.map((c) => c.type).join("+")}`
        : e.kind,
    );
    expect(shapes).toEqual([
      "user:text",
      "assistant:text+toolCall",
      "toolResult:text",
      "assistant:text",
    ]);
    const turn = merged?.entries[1];
    expect(turn?.kind === "message" && turn.usage?.outputTokens).toBe(7);
  });

  it("returns null for a source with zero convertible messages", () => {
    expect(
      parseClaudeSession(
        jsonl([{ type: "file-history-snapshot" }]),
        "/src/empty.jsonl",
      ),
    ).toBeNull();
    expect(parseClaudeSession("", "/src/blank.jsonl")).toBeNull();
  });
});

describe("scaffolding classifier", () => {
  const userLine = (uuid: string, content: unknown) => ({
    type: "user",
    uuid,
    sessionId: "s",
    cwd: "/p",
    timestamp: "2026-01-02T03:04:05.000Z",
    message: { role: "user", content },
  });

  it("drops whole-block harness envelopes, even novel tag names", () => {
    const parsed = parseClaudeSession(
      jsonl([
        userLine(
          "u1",
          "<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args></command-args>",
        ),
        userLine("u2", "<totally_new_injection>stuff</totally_new_injection>"),
        userLine("u3", "real question"),
      ]),
      "/src/env.jsonl",
    );
    expect(parsed?.entries).toHaveLength(1);
    expect(titleFromEntries(parsed?.entries ?? [])).toBe("real question");
  });

  it("keeps user-pasted HTML (plain tags carry no _ or -)", () => {
    const parsed = parseClaudeSession(
      jsonl([userLine("u1", "<div>why does this not center?</div>")]),
      "/src/html.jsonl",
    );
    expect(parsed?.entries).toHaveLength(1);
  });

  it("strips system-reminder spans but keeps surrounding real text", () => {
    const parsed = parseClaudeSession(
      jsonl([
        userLine(
          "u1",
          "fix the bug<system-reminder>injected context here</system-reminder> in auth.ts",
        ),
      ]),
      "/src/reminder.jsonl",
    );
    const first = parsed?.entries[0];
    expect(first?.kind === "message" && first.content).toEqual([
      { type: "text", text: "fix the bug in auth.ts" },
    ]);
  });

  it("drops injected skill bodies", () => {
    const parsed = parseClaudeSession(
      jsonl([
        userLine(
          "u1",
          "Base directory for this skill: /Users/x/.claude/skills/foo\n\n# Skill\ninstructions…",
        ),
        userLine("u2", "run the skill"),
      ]),
      "/src/skill.jsonl",
    );
    expect(parsed?.entries).toHaveLength(1);
  });
});

describe("titleFromEntries", () => {
  it("skips harness-artifact user messages when deriving a title", () => {
    const parsed = parseClaudeSession(
      jsonl([
        {
          type: "user",
          uuid: "u0",
          sessionId: "s",
          cwd: "/p",
          timestamp: "2026-01-02T03:04:04.000Z",
          message: {
            role: "user",
            content:
              "<local-command-caveat>Caveat: the messages below…</local-command-caveat>",
          },
        },
        {
          type: "user",
          uuid: "u1",
          sessionId: "s",
          timestamp: "2026-01-02T03:04:05.000Z",
          message: { role: "user", content: "[Image #1]" },
        },
        {
          type: "user",
          uuid: "u2",
          sessionId: "s",
          timestamp: "2026-01-02T03:04:06.000Z",
          message: { role: "user", content: "fix the importer titles" },
        },
      ]),
      "/src/titles.jsonl",
    );
    expect(titleFromEntries(parsed?.entries ?? [])).toBe(
      "fix the importer titles",
    );
  });
});

describe("parseCodexRollout", () => {
  it("strips bootstrap text blocks mixed with real user text", () => {
    const fixture = jsonl([
      codexMeta("thread-1", "2026-02-01T00:00:00.000Z"),
      codexUser("do the thing", "2026-02-01T00:00:01.000Z", [
        {
          type: "input_text",
          text: "<environment_context>\nstuff\n</environment_context>",
        },
      ]),
    ]);
    const parsed = parseCodexRollout(fixture, "/src/rollout-1.jsonl");
    const first = parsed?.entries[0];
    expect(first?.kind).toBe("message");
    if (first?.kind === "message") {
      expect(first.content).toEqual([{ type: "text", text: "do the thing" }]);
    }
  });

  it("strips the memory-folder preamble but keeps a user '# Memory' heading", () => {
    const fixture = jsonl([
      codexMeta("thread-mem", "2026-02-01T00:00:00.000Z"),
      codexUser("real question", "2026-02-01T00:00:01.000Z", [
        {
          type: "input_text",
          text: "# Memory\n\nYou have access to a memory folder with guidance from prior runs. It can save\ntime and help you stay consistent.",
        },
      ]),
      codexUser("# Memory notes I wrote myself", "2026-02-01T00:00:02.000Z"),
    ]);
    const parsed = parseCodexRollout(fixture, "/src/rollout-mem.jsonl");
    const texts = parsed?.entries
      .filter((e) => e.kind === "message" && e.role === "user")
      .flatMap((e) => (e.kind === "message" ? e.content : []))
      .map((c) => (c.type === "text" ? c.text : c.type));
    expect(texts).toEqual(["real question", "# Memory notes I wrote myself"]);
  });

  it("skips developer-role messages (skills catalog, permissions, …)", () => {
    const fixture = jsonl([
      codexMeta("thread-dev", "2026-02-01T00:00:00.000Z"),
      {
        timestamp: "2026-02-01T00:00:00.500Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [
            {
              type: "input_text",
              text: "<skills_instructions>\n## Skills\n### Available skills\n- adapt: …</skills_instructions>",
            },
          ],
        },
      },
      codexUser("real ask", "2026-02-01T00:00:01.000Z"),
    ]);
    const parsed = parseCodexRollout(fixture, "/src/rollout-dev.jsonl");
    expect(parsed?.entries).toHaveLength(1);
    expect(titleFromEntries(parsed?.entries ?? [])).toBe("real ask");
  });

  it("coalesces split assistant items so tool_use/tool_result pairing survives", () => {
    // codex emits assistant text + each function_call as separate items;
    // parallel calls must merge into ONE assistant message (Anthropic 400 otherwise)
    const item = (payload: unknown, ts: string) => ({
      timestamp: ts,
      type: "response_item",
      payload,
    });
    const fixture = jsonl([
      codexMeta("thread-par", "2026-02-01T00:00:00.000Z"),
      codexUser("check both files", "2026-02-01T00:00:01.000Z"),
      item(
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Checking." }],
        },
        "2026-02-01T00:00:02.000Z",
      ),
      item(
        { type: "function_call", name: "read", call_id: "c1", arguments: "{}" },
        "2026-02-01T00:00:03.000Z",
      ),
      item(
        { type: "function_call", name: "read", call_id: "c2", arguments: "{}" },
        "2026-02-01T00:00:03.500Z",
      ),
      item(
        { type: "function_call_output", call_id: "c1", output: "a" },
        "2026-02-01T00:00:04.000Z",
      ),
      item(
        { type: "function_call_output", call_id: "c2", output: "b" },
        "2026-02-01T00:00:05.000Z",
      ),
    ]);
    const parsed = parseCodexRollout(fixture, "/src/rollout-par.jsonl");
    const shapes = parsed?.entries.map((e) =>
      e.kind === "message"
        ? `${e.role}:${e.content.map((c) => c.type).join("+")}`
        : e.kind,
    );
    expect(shapes).toEqual([
      "user:text",
      "assistant:text+toolCall+toolCall",
      "toolResult:text",
      "toolResult:text",
    ]);
  });

  it("drops all-bootstrap messages and returns null when nothing remains", () => {
    const fixture = jsonl([
      codexMeta("thread-2", "2026-02-01T00:00:00.000Z"),
      codexUser(
        "<permissions instructions>\nsandbox on",
        "2026-02-01T00:00:01.000Z",
      ),
    ]);
    expect(parseCodexRollout(fixture, "/src/rollout-2.jsonl")).toBeNull();
  });
});

describe("groupCodexThreads", () => {
  it("merges rollout files sharing a thread id, timestamp-ordered", () => {
    const a = parseCodexRollout(
      jsonl([
        codexMeta("thread-3", "2026-02-01T00:00:00.000Z"),
        codexUser("first", "2026-02-01T00:00:01.000Z"),
      ]),
      "/src/rollout-a.jsonl",
    );
    const b = parseCodexRollout(
      jsonl([
        codexMeta("thread-3", "2026-02-02T00:00:00.000Z"),
        codexUser("second", "2026-02-02T00:00:01.000Z"),
      ]),
      "/src/rollout-b.jsonl",
    );
    // pass in reverse order to prove timestamp sorting
    const grouped = groupCodexThreads(
      [b, a].map((s) => s as NonNullable<typeof a>),
    );
    expect(grouped).toHaveLength(1);
    const merged = grouped[0];
    expect(merged?.sourcePath).toBe("/src/rollout-a.jsonl");
    expect(
      merged?.entries.map((e) =>
        e.kind === "message" ? JSON.stringify(e.content) : "",
      ),
    ).toEqual([
      JSON.stringify([{ type: "text", text: "first" }]),
      JSON.stringify([{ type: "text", text: "second" }]),
    ]);
  });
});

describe("pi → pi", () => {
  const piFixture = jsonl([
    {
      type: "session",
      version: 3,
      id: "11111111-2222-3333-4444-555555555555",
      timestamp: "2026-03-01T00:00:00.000Z",
      cwd: "/Users/dev/old",
    },
    { type: "session_info", id: "s1", parentId: null, name: "My Session" },
    {
      type: "message",
      id: "m1",
      parentId: "s1",
      timestamp: "2026-03-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: "2026-03-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: { input: 3, output: 2 },
      },
    },
  ]);

  it("rewrites only the header cwd and keeps entries verbatim", () => {
    const parsed = parsePiSession(piFixture, "/src/pi.jsonl");
    expect(parsed?.sourceSessionId).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
    const converted = convertToPi(parsed as NonNullable<typeof parsed>, {
      targetCwd: "/workspace/old",
    });
    expect(converted?.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(converted?.title).toBe("My Session");
    const lines = (converted?.jsonl ?? "").trim().split("\n");
    expect(JSON.parse(lines[0] as string).cwd).toBe("/workspace/old");
    expect(lines.slice(1)).toEqual(piFixture.trim().split("\n").slice(1));
  });
});

describe("synthesizeEvents", () => {
  it("emits schema-valid events for every entry, excluding session.created", () => {
    const source = parseClaudeSession(claudeFixture, "/src/claude.jsonl");
    const converted = convertToPi(source as NonNullable<typeof source>, {
      targetCwd: "/workspace/proj",
    });
    const events = synthesizeEvents(converted?.jsonl ?? "", {
      title: converted?.title ?? "",
    });

    expect(events.map((e) => e.type)).toEqual([
      "session.title.changed",
      "message.user.created",
      "message.assistant.completed",
      "tool.call.started",
      "tool.call.completed",
    ]);
    for (const e of events) {
      const result = durableEventSchemas[e.type].safeParse(e.payload);
      expect(
        result.error,
        `${e.type}: ${result.error?.message ?? ""}`,
      ).toBeUndefined();
      expect(e.v).toBe(1);
      expect(e.source).toEqual({ kind: "importer" });
    }

    const assistant = events[2]?.payload as {
      stopReason: string;
      usage: { inputTokens: number; outputTokens: number };
    };
    expect(assistant.stopReason).toBe("tool_use");
    expect(assistant.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

    // deterministic: same input → same events
    expect(
      synthesizeEvents(converted?.jsonl ?? "", {
        title: converted?.title ?? "",
      }),
    ).toEqual(events);
  });

  it("never emits empty ids/levels that fail the schemas' min(1)", () => {
    const source = parseClaudeSession(
      jsonl([
        {
          type: "user",
          sessionId: "",
          cwd: "/Users/dev/proj",
          message: { role: "user", content: "go" },
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            model: "",
            content: [{ type: "tool_use", id: "", name: "bash", input: {} }],
          },
        },
      ]),
      "/src/empty-ids.jsonl",
    );
    expect(source?.sourceSessionId).not.toBe("");
    const converted = convertToPi(source as NonNullable<typeof source>, {
      targetCwd: "/w",
    });
    const piJsonl = converted?.jsonl ?? "";
    // splice in a pi entry with an empty thinking level at the leaf
    const lines = piJsonl.trim().split("\n");
    const leafId = (JSON.parse(lines.at(-1) as string) as { id: string }).id;
    const withEmpty = `${piJsonl}${JSON.stringify({
      type: "thinking_level_change",
      id: "tl1",
      parentId: leafId,
      thinkingLevel: "",
    })}\n`;
    for (const e of synthesizeEvents(withEmpty, {})) {
      const result = durableEventSchemas[e.type].safeParse(e.payload);
      expect(
        result.error,
        `${e.type}: ${result.error?.message ?? ""}`,
      ).toBeUndefined();
    }
  });

  it("maps model/thinking changes and zero-usage assistants", () => {
    const piJsonl = jsonl([
      {
        type: "session",
        version: 3,
        id: "abc",
        timestamp: "2026-03-01T00:00:00.000Z",
        cwd: "/w",
      },
      {
        type: "model_change",
        id: "e1",
        parentId: null,
        provider: "openai",
        modelId: "gpt-5",
      },
      {
        type: "thinking_level_change",
        id: "e2",
        parentId: "e1",
        thinkingLevel: "high",
      },
      {
        type: "message",
        id: "e3",
        parentId: "e2",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
      {
        type: "custom",
        customType: "whatever",
        id: "e4",
        parentId: "e3",
        data: {},
      },
    ]);
    const events = synthesizeEvents(piJsonl, {});
    expect(events.map((e) => e.type)).toEqual([
      "model.changed",
      "thinking.level.changed",
      "message.assistant.completed",
    ]);
    for (const e of events) {
      expect(durableEventSchemas[e.type].safeParse(e.payload).success).toBe(
        true,
      );
    }
    expect(events[1]?.payload).toEqual({ from: "off", to: "high" });
    expect((events[2]?.payload as { usage: unknown }).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});
