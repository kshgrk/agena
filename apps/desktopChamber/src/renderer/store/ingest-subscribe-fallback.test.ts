// node --experimental-strip-types --test
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "@agena/protocol";

test("compact history failure replays instead of subscribing at a blank saved cursor", async () => {
  const subscriptions: number[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      agena: {
        loadPersisted: async () => ({
          cursors: { s1: { branchId: "b1", seq: 4373 } },
        }),
        readCompactTranscript: async () => {
          throw new Error('unknown bridge method "readCompactTranscript"');
        },
        subscribe: async (_sessionId: string, fromSeq: number) => {
          subscriptions.push(fromSeq);
          return { lastSeq: 4373, branchId: "b1", replayCount: 4373 };
        },
      },
    },
  });

  const { ensureSubscribed, resetSubscriptions, useConnection, useSessions } =
    await import("./index.ts");
  resetSubscriptions();
  await assert.rejects(ensureSubscribed("s1"), /not connected/);
  useConnection.getState().setInfo({
    profile: "local",
    url: "http://localhost",
    daemonVersion: "0",
    protocolVersion: 1,
    clientId: "test",
  });
  useSessions.getState().setAll([
    {
      sessionId: "s1",
      workspaceId: "w1",
      rootBranchId: "b1",
      lastSeq: 4373,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
      scope: "project",
      status: "idle",
      projectId: "p1",
      projectRoot: "/w",
      cwd: "/w",
    } satisfies SessionSummary,
  ]);

  await ensureSubscribed("s1");

  assert.deepEqual(subscriptions, [0]);
  Reflect.deleteProperty(globalThis, "window");
});
