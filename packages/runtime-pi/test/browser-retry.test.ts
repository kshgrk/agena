import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, test, vi } from "vitest";
import { withAgentBrowserRestoreRetry } from "../src/adapter.ts";

test("retries an auto browser restore-policy rejection once with a fresh session", async () => {
  const execute = vi
    .fn()
    .mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: "Managed session restore policy changed after planning; refusing to start agent-browser.",
        },
      ],
      details: {},
    })
    .mockResolvedValueOnce({
      content: [{ type: "text", text: "opened" }],
      details: {},
    });
  const tool = withAgentBrowserRestoreRetry(
    defineTool({
      name: "agent_browser",
      label: "Agent Browser",
      description: "test",
      parameters: Type.Object({
        sessionMode: Type.Optional(
          Type.Union([Type.Literal("auto"), Type.Literal("fresh")]),
        ),
      }),
      execute,
    }),
  );

  const result = await tool.execute(
    "call-1",
    { sessionMode: "auto" },
    undefined,
    undefined,
    {} as never,
  );

  expect(result.content).toEqual([{ type: "text", text: "opened" }]);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[1]?.[1]).toEqual({ sessionMode: "fresh" });
});

test("does not retry unrelated browser failures", async () => {
  const execute = vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "navigation failed" }],
    details: {},
  });
  const tool = withAgentBrowserRestoreRetry(
    defineTool({
      name: "agent_browser",
      label: "Agent Browser",
      description: "test",
      parameters: Type.Object({}),
      execute,
    }),
  );

  await tool.execute("call-2", {}, undefined, undefined, {} as never);

  expect(execute).toHaveBeenCalledTimes(1);
});
