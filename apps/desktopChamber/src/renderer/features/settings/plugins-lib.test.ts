import assert from "node:assert/strict";
import test from "node:test";
import {
  filterPlugins,
  type PluginListItem,
  pluginInstallWarning,
  pluginSettingsSection,
} from "./plugins-lib.ts";

const plugins: PluginListItem[] = [
  {
    name: "GitHub",
    description: "OAuth repositories",
    kind: "integration",
    publisher: "Agena",
  },
  {
    name: "Playwright",
    description: "Browser automation",
    kind: "mcp",
    publisher: "Microsoft",
  },
];

test("plugin catalog filters by category and every search term", () => {
  assert.deepEqual(
    filterPlugins(plugins, "integration", "oauth repo").map(
      (item) => item.name,
    ),
    ["GitHub"],
  );
  assert.deepEqual(
    filterPlugins(plugins, "mcp", "browser").map((item) => item.name),
    ["Playwright"],
  );
  assert.equal(filterPlugins(plugins, "all", "missing").length, 0);
});

test("installed MCP-backed integrations configure through MCP settings", () => {
  assert.equal(
    pluginSettingsSection({ kind: "integration", resourceId: "mcp_github" }),
    "mcp",
  );
  assert.equal(pluginSettingsSection({ kind: "skill" }), "skills");
  assert.equal(pluginSettingsSection({ kind: "extension" }), null);
});

test("only executable extensions require an install trust warning", () => {
  assert.match(
    pluginInstallWarning({ kind: "extension", name: "Retry" }) ?? "",
    /runs code inside the Agena daemon/,
  );
  assert.equal(pluginInstallWarning({ kind: "mcp", name: "GitHub" }), null);
});
