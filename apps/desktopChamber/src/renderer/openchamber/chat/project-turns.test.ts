import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block } from "../../store/types.ts";
import {
  completeTurnBlocks,
  needsMoreTurnHistory,
  projectTurns,
} from "./project-turns.ts";

const base = {
  at: "2026-08-09T00:00:00.000Z",
  source: { kind: "runtime" } as const,
};

test("groups consecutive tools and keeps assistant messages as boundaries", () => {
  const blocks: Block[] = [
    {
      ...base,
      seq: 1,
      kind: "marker",
      markerKind: "session",
      text: "started",
    },
    {
      ...base,
      seq: 2,
      kind: "user",
      messageId: "u1",
      content: [{ type: "text", text: "hello" }],
    },
    {
      ...base,
      seq: 3,
      kind: "tool",
      toolCallId: "t1",
      name: "read",
      args: { path: "a.ts" },
      status: "completed",
      liveOutput: "",
      result: [{ type: "text", text: "ok" }],
    },
    {
      ...base,
      seq: 4,
      kind: "assistant",
      messageId: "tool-only",
      content: [
        {
          type: "toolCall",
          toolCallId: "provider-t2",
          name: "grep",
          args: { pattern: "hello" },
        },
      ],
      status: "completed",
    },
    {
      ...base,
      seq: 5,
      kind: "tool",
      toolCallId: "t2",
      name: "grep",
      args: { pattern: "hello" },
      status: "failed",
      liveOutput: "",
      error: { code: "not_found", message: "missing" },
    },
    {
      ...base,
      seq: 6,
      kind: "assistant",
      messageId: "a1",
      content: [{ type: "text", text: "still working" }],
      status: "completed",
    },
    {
      ...base,
      seq: 7,
      kind: "tool",
      toolCallId: "t3",
      name: "bash",
      args: { command: "pnpm test" },
      status: "completed",
      liveOutput: "",
      result: [{ type: "text", text: "passed" }],
    },
    {
      ...base,
      seq: 8,
      kind: "assistant",
      messageId: "a2",
      content: [{ type: "text", text: "done" }],
      status: "completed",
    },
    {
      ...base,
      seq: 9,
      kind: "user",
      messageId: "u2",
      content: [{ type: "text", text: "next" }],
    },
  ];

  const timeline = projectTurns(blocks, {
    messageId: "a2",
    blocks: [{ type: "text", text: "working" }],
  });

  assert.deepEqual(
    timeline.history.map((entry) => entry.key),
    ["orphan:1", "turn:u1", "turn:u2"],
  );
  const firstTurn = timeline.history[1];
  assert.equal(firstTurn?.kind, "turn");
  if (firstTurn?.kind !== "turn") return;
  assert.deepEqual(
    firstTurn.turn.entries.map((entry) => [entry.kind, entry.key]),
    [
      ["tool-group", "tool-group:t1"],
      ["assistant", "message:a1"],
      ["tool-group", "tool-group:t3"],
      ["assistant", "message:a2"],
    ],
  );
  const firstGroup = firstTurn.turn.entries[0];
  assert.equal(firstGroup?.kind, "tool-group");
  if (firstGroup?.kind === "tool-group") {
    assert.deepEqual(
      firstGroup.activities.map((activity) => activity.id),
      ["t1", "t2"],
    );
  }
  assert.equal(timeline.tail?.messageId, "a2");
});

test("approval activity interrupts adjacent tool groups", () => {
  const blocks: Block[] = [
    {
      ...base,
      seq: 1,
      kind: "user",
      messageId: "u1",
      content: [{ type: "text", text: "ship it" }],
    },
    {
      ...base,
      seq: 2,
      kind: "tool",
      toolCallId: "t1",
      name: "edit",
      args: {},
      status: "completed",
      liveOutput: "",
      result: [],
    },
    {
      ...base,
      seq: 3,
      kind: "approval",
      approvalId: "p1",
      request: {
        approvalId: "p1",
        kind: "confirm",
        title: "Deploy?",
        message: "Deploy this build?",
      },
      state: "pending",
    },
    {
      ...base,
      seq: 4,
      kind: "tool",
      toolCallId: "t2",
      name: "bash",
      args: {},
      status: "running",
      liveOutput: "",
    },
  ];

  const turn = projectTurns(blocks, null).history[0];
  assert.equal(turn?.kind, "turn");
  if (turn?.kind !== "turn") return;
  assert.deepEqual(
    turn.turn.entries.map((entry) => entry.kind),
    ["tool-group", "activity", "tool-group"],
  );
});

test("subagents render separately from adjacent tool groups", () => {
  const tool = (seq: number, name: string): Block => ({
    ...base,
    seq,
    kind: "tool",
    toolCallId: `t${seq}`,
    name,
    args: {},
    status: "completed",
    liveOutput: "",
    result: [],
  });
  const turn = projectTurns(
    [
      {
        ...base,
        seq: 1,
        kind: "user",
        messageId: "u1",
        content: [{ type: "text", text: "delegate it" }],
      },
      tool(2, "read"),
      tool(3, "subagent"),
      tool(4, "bash"),
    ],
    null,
  ).history[0];
  assert.equal(turn?.kind, "turn");
  if (turn?.kind !== "turn") return;
  assert.deepEqual(
    turn.turn.entries.map((entry) => entry.kind),
    ["tool-group", "activity", "tool-group"],
  );
});

test("waits for and aligns a cold page to its first complete user turn", () => {
  const partial: Block[] = [
    {
      ...base,
      seq: 200,
      kind: "tool",
      toolCallId: "partial-tool",
      name: "bash",
      args: {},
      status: "completed",
      liveOutput: "",
      result: [],
    },
  ];
  assert.deepEqual(completeTurnBlocks(partial, true), []);

  const prepended: Block[] = [
    {
      ...base,
      seq: 1,
      kind: "user",
      messageId: "earlier-user",
      content: [{ type: "text", text: "earlier prompt" }],
    },
    ...partial,
    {
      ...base,
      seq: 201,
      kind: "user",
      messageId: "latest-user",
      content: [{ type: "text", text: "latest prompt" }],
    },
    {
      ...base,
      seq: 202,
      kind: "assistant",
      messageId: "latest-assistant",
      content: [{ type: "text", text: "latest answer" }],
      status: "completed",
    },
  ];
  assert.deepEqual(
    completeTurnBlocks(prepended, true).map((block) => block.seq),
    [1, 200, 201, 202],
  );
  assert.equal(completeTurnBlocks(partial, false), partial);
});

test("keeps paging only until the requested complete-turn buffer is loaded", () => {
  const turns = [
    { kind: "user" as const },
    { kind: "assistant" as const },
    { kind: "user" as const },
  ];
  assert.equal(needsMoreTurnHistory(turns, 5, 4000), true);
  assert.equal(needsMoreTurnHistory(turns, 2, 4000), false);
  assert.equal(needsMoreTurnHistory(turns, 5, 1), false);
});
