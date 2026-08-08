// node --experimental-strip-types --test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgenaEvent, SessionSummary } from "@agena/protocol";

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
  it("loads the newest page before subscribing an uncached session", async () => {
    const reads: Array<{ fromSeq?: number; limit?: number }> = [];
    const subscriptions: number[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        agena: {
          loadPersisted: async () => ({
            cursors: { s1: { branchId: "b1", seq: 100 } },
          }),
          readEvents: async (
            _sessionId: string,
            opts: { fromSeq?: number; limit?: number },
          ) => {
            reads.push(opts);
            return {
              events: Array.from(
                { length: 200 },
                (_, index): AgenaEvent => ({
                  sessionId: "s1",
                  branchId: "b1",
                  seq: 301 + index,
                  type: "test.marker",
                  v: 1,
                  createdAt: "2026-07-06T00:00:00.000Z",
                  source: { kind: "runtime", runtime: "pi" },
                  payload: {},
                }),
              ),
              nextFromSeq: null,
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
      useSessions,
      useTranscripts,
    } = await import("./index.ts");
    __resetAllStores();
    resetSubscriptions();
    useSessions.getState().setAll([summary]);

    await ensureSubscribed("s1");

    assert.deepEqual(reads, [{ fromSeq: 300, limit: 200 }]);
    assert.deepEqual(subscriptions, [500]);
    assert.equal(useTranscripts.getState().bySession.s1?.lastSeq, 500);
    assert.equal(
      useTranscripts.getState().bySession.s1?.rawEvents[0]?.seq,
      301,
    );
    Reflect.deleteProperty(globalThis, "window");
  });
});
