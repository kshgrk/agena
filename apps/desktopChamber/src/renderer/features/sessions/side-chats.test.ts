// node --experimental-strip-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@agena/protocol";
import {
  sideChatRootSessionId,
  sideChatsForRoot,
  sideChatTitle,
} from "./side-chats.ts";

function session(over: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: "main",
    workspaceId: "ws",
    rootBranchId: "branch",
    lastSeq: 0,
    createdAt: "2026-08-14T00:00:00Z",
    updatedAt: "2026-08-14T00:00:00Z",
    scope: "project",
    status: "idle",
    cwd: ".",
    ...over,
  } as SessionSummary;
}

test("groups nested side chats under their main session", () => {
  const sessions = [
    session({ sessionId: "main" }),
    session({
      sessionId: "q1",
      title: "Quick Chat",
      purpose: "quick_chat",
      parentSessionId: "main",
      createdAt: "2026-08-14T00:00:01Z",
    }),
    session({
      sessionId: "q2",
      title: "Quick Chat 2",
      purpose: "quick_chat",
      parentSessionId: "q1",
      createdAt: "2026-08-14T00:00:02Z",
    }),
    session({
      sessionId: "archived",
      purpose: "quick_chat",
      parentSessionId: "main",
      status: "archived",
    }),
  ];
  const byId = Object.fromEntries(
    sessions.map((item) => [item.sessionId, item]),
  );

  assert.equal(sideChatRootSessionId(byId, "q2"), "main");
  assert.equal(sideChatTitle(byId, "q1"), "Quick Chat 1");
  assert.equal(sideChatTitle(byId, "q2"), "Quick Chat 2");
  assert.deepEqual(
    sideChatsForRoot(byId, "main").map((item) => item.sessionId),
    ["q1", "q2"],
  );
});
