// node --experimental-strip-types --test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionSummary } from "@agena/protocol";

const summary: SessionSummary = {
  sessionId: "s1",
  workspaceId: "w1",
  rootBranchId: "b1",
  lastSeq: 500,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-06T00:00:00.000Z",
  scope: "project",
  status: "idle",
  projectId: "p1",
  projectRoot: "/w",
  cwd: "/w",
};

describe("ensureSubscribed", () => {
  it("loads compact recent turns before subscribing an uncached session", async () => {
    const reads: Array<{ limitTurns?: number }> = [];
    const subscriptions: number[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        agena: {
          loadPersisted: async () => ({
            cursors: { s1: { branchId: "b1", seq: 100 } },
          }),
          readCompactTranscript: async (
            _sessionId: string,
            opts: { limitTurns?: number },
          ) => {
            reads.push(opts);
            return {
              sessionId: "s1",
              branchId: "b1",
              upToSeq: 500,
              turns: [],
              hasOlder: true,
              hasNewer: false,
            };
          },
          subscribe: async (_sessionId: string, fromSeq: number) => {
            subscriptions.push(fromSeq);
            return { lastSeq: 500, branchId: "b1", replayCount: 0 };
          },
        },
      },
    });

    const {
      __resetAllStores,
      ensureSubscribed,
      resetSubscriptions,
      useConnection,
      useSessions,
      useTranscripts,
    } = await import("./index.ts");
    __resetAllStores();
    resetSubscriptions();
    useConnection.getState().setInfo({
      profile: "local",
      url: "http://localhost",
      daemonVersion: "0",
      protocolVersion: 1,
      clientId: "test",
    });
    useSessions.getState().setAll([summary]);

    await ensureSubscribed("s1");

    assert.deepEqual(reads, [{ limitTurns: 10 }]);
    assert.deepEqual(subscriptions, [500]);
    assert.equal(useTranscripts.getState().bySession.s1?.lastSeq, 500);
    assert.equal(
      useTranscripts.getState().bySession.s1?.historyInitialized,
      true,
    );
    Reflect.deleteProperty(globalThis, "window");
  });
});
