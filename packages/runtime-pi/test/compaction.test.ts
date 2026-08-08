import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import { compactWithOverflowFallback } from "../src/adapter.ts";

describe("overflow compaction recovery", () => {
  test("appends a loss-tolerant checkpoint only for context overflow", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({
      role: "user",
      content: "older context ".repeat(100),
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "user",
      content: "recent request",
      timestamp: Date.now(),
    });
    const reload = vi.fn(async () => {});
    const session = {
      compact: vi.fn(async () => {
        throw new Error("Your input exceeds the context window of this model");
      }),
      reload,
      sessionManager,
      settingsManager: {
        getCompactionSettings: () => ({
          enabled: true,
          reserveTokens: 16_384,
          keepRecentTokens: 1,
        }),
      },
    } as unknown as AgentSession;

    await expect(compactWithOverflowFallback(session)).resolves.toMatchObject({
      summary: expect.stringContaining("Emergency context recovery"),
    });
    expect(sessionManager.getLeafEntry()).toMatchObject({
      type: "compaction",
      fromHook: true,
    });
    expect(reload).toHaveBeenCalledOnce();
  });

  test("does not hide unrelated compaction failures", async () => {
    const error = new Error("authentication failed");
    const session = {
      compact: vi.fn(async () => {
        throw error;
      }),
    } as unknown as AgentSession;

    await expect(compactWithOverflowFallback(session)).rejects.toBe(error);
  });
});
