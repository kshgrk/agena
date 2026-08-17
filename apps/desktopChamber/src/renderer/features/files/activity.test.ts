import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventSource, SessionSummary } from "@agena/protocol";
import { emptyTranscript } from "../../store/types.ts";
import {
  displayActivityPath,
  familySessionIds,
  projectFamilyFileActivities,
  projectSessionToolActivities,
} from "./activity.ts";

const source: EventSource = { kind: "runtime", runtime: "pi" };
const session = (
  sessionId: string,
  extra: Partial<SessionSummary> = {},
): SessionSummary => ({
  sessionId,
  workspaceId: "w1",
  rootBranchId: `b-${sessionId}`,
  lastSeq: 0,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  scope: "project",
  status: "active",
  projectId: "p1",
  projectRoot: "/workspace/app",
  cwd: "/workspace/app",
  ...extra,
});
test("projects known tool paths and terminal status without overclaiming bash", () => {
  const activities = projectSessionToolActivities(session("main"), [
    {
      kind: "tool",
      seq: 1,
      at: "2026-08-18T00:00:01.000Z",
      source,
      toolCallId: "t1",
      name: "read",
      args: { path: "src/main.ts" },
      status: "completed",
      liveOutput: "",
    },
    {
      kind: "tool",
      seq: 2,
      at: "2026-08-18T00:00:02.000Z",
      source,
      toolCallId: "t2",
      name: "bash",
      args: { command: "cat src/secret.ts" },
      status: "completed",
      liveOutput: "",
    },
  ]);

  assert.deepEqual(activities, [
    {
      sessionId: "main",
      seq: 1,
      at: "2026-08-18T00:00:01.000Z",
      toolCallId: "t1",
      toolName: "read",
      operation: "read",
      path: "app/src/main.ts",
      reportedPath: "src/main.ts",
      status: "completed",
      actor: "Main",
    },
  ]);
});

test("projects a main session family with side-chat identity", () => {
  const sessions = {
    main: session("main"),
    side: session("side", {
      purpose: "quick_chat",
      parentSessionId: "main",
      sideChatAccess: "read_only",
    }),
  };
  assert.deepEqual(familySessionIds(sessions, "side").sort(), ["main", "side"]);
  const sideTranscript = {
    ...emptyTranscript("side"),
    blocks: [
      {
        kind: "tool" as const,
        seq: 1,
        at: "2026-08-18T00:00:01.000Z",
        source,
        toolCallId: "t1",
        name: "grep",
        args: JSON.stringify({ path: "src" }),
        status: "running" as const,
        liveOutput: "",
      },
    ],
  };
  assert.deepEqual(
    projectFamilyFileActivities(sessions, { side: sideTranscript }, "main")[0],
    {
      sessionId: "side",
      seq: 1,
      at: "2026-08-18T00:00:01.000Z",
      toolCallId: "t1",
      toolName: "grep",
      operation: "search",
      path: "app/src",
      reportedPath: "src",
      status: "running",
      actor: "Side chat",
      access: "read_only",
    },
  );
});

test("display paths stay inside the workspace", () => {
  assert.equal(
    displayActivityPath("../shared.ts", "/workspace/app/src"),
    "app/shared.ts",
  );
  assert.equal(displayActivityPath("../../../secret", "/workspace/app"), null);
  assert.equal(displayActivityPath("/etc/passwd", "/workspace/app"), null);
  assert.equal(
    displayActivityPath("/workspace/app/a.ts", "/workspace"),
    "app/a.ts",
  );
});

test("recovers an early path from a safely truncated compact preview", () => {
  const activity = projectFamilyFileActivities(
    { main: session("main") },
    {
      main: {
        ...emptyTranscript("main"),
        blocks: [
          {
            kind: "tool",
            seq: 1,
            at: "2026-08-18T00:00:01.000Z",
            source,
            toolCallId: "t1",
            name: "edit",
            args: '{"path":"src/main.ts","patch":"unfinished',
            status: "completed",
            liveOutput: "",
          },
        ],
      },
    },
    "main",
  )[0];
  assert.equal(activity?.path, "app/src/main.ts");
});
