import { expect, test } from "vitest";
import {
  listPluginsResponseSchema,
  PTY_HTTP_ROUTES,
  runtimeInfoAckSchema,
} from "../src/index.ts";

test("catalogs plugin lifecycle routes and Pi's max thinking level", () => {
  expect(
    runtimeInfoAckSchema.parse({
      sessionId: "ses_1",
      model: { provider: "openai-codex", id: "gpt-5.6" },
      thinkingLevel: "max",
      availableModels: [],
      availableThinkingLevels: ["off", "max"],
      slashCommands: [],
    }).thinkingLevel,
  ).toBe("max");

  expect(Object.keys(PTY_HTTP_ROUTES)).toEqual(
    expect.arrayContaining([
      "listPlugins",
      "installPlugin",
      "updatePlugin",
      "setPluginEnabled",
      "removePlugin",
    ]),
  );
  expect(
    listPluginsResponseSchema.parse({
      plugins: [
        {
          id: "github",
          name: "GitHub",
          description: "Repository tools",
          publisher: "GitHub",
          kind: "integration",
          category: "developer_tools",
          status: "needs_auth",
          authKind: "oauth",
          featured: true,
          capabilities: ["repositories"],
          enabled: true,
        },
      ],
    }).plugins[0]?.status,
  ).toBe("needs_auth");
});
