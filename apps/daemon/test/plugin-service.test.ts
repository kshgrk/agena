import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@agena/storage-sqlite";
import { afterEach, expect, test } from "vitest";
import { McpService } from "../src/mcp-service.ts";
import { PluginService } from "../src/plugin-service.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("derives durable MCP and Pi-package plugin state from their owners", async () => {
  const state = mkdtempSync(join(tmpdir(), "agena-plugin-"));
  dirs.push(state);
  const store = new SqliteEventStore(join(state, "db", "agena.db"));
  const mcps = new McpService(store, state);
  await mcps.initialize();
  const records: Array<{
    source: string;
    enabled: boolean;
    installed?: boolean;
  }> = [];
  const packages = {
    list: () => records.map((record) => ({ ...record })),
    async install(source: string) {
      records.push({ source, enabled: true });
    },
    async remove(source: string) {
      records.splice(
        records.findIndex((record) => record.source === source),
        1,
      );
    },
    async setEnabled(source: string, enabled: boolean) {
      const record = records.find((candidate) => candidate.source === source);
      if (record) record.enabled = enabled;
    },
    async update() {},
  };
  const plugins = new PluginService(mcps, packages);

  expect((await plugins.install("github")).status).toBe("needs_auth");
  expect((await plugins.setEnabled("github", false)).status).toBe("disabled");
  expect(readFileSync(join(state, "pi", "mcp.json"), "utf8")).not.toContain(
    "github",
  );
  expect((await plugins.setEnabled("github", true)).status).toBe("needs_auth");

  expect((await plugins.install("loop-guard")).status).toBe("installed");
  if (records[0]) records[0].installed = false;
  expect(
    plugins.list().find((plugin) => plugin.id === "loop-guard"),
  ).toMatchObject({
    status: "error",
    error: "Installed package files are missing",
  });
  if (records[0]) records[0].installed = true;
  expect((await plugins.setEnabled("loop-guard", false)).status).toBe(
    "disabled",
  );
  expect((await plugins.remove("loop-guard")).status).toBe("available");

  await plugins.remove("github");
  expect(plugins.list().find((plugin) => plugin.id === "github")?.status).toBe(
    "available",
  );
  store.close();
});

test("installing a catalog MCP preserves an existing matching configuration", async () => {
  const state = mkdtempSync(join(tmpdir(), "agena-plugin-existing-"));
  dirs.push(state);
  const store = new SqliteEventStore(join(state, "db", "agena.db"));
  const mcps = new McpService(store, state);
  await mcps.initialize();
  const existing = await mcps.import({
    identity: "remote:https://api.githubcopilot.com/mcp",
    name: "my-github",
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: { Authorization: "Bearer $" + "{TOKEN}" },
    auth: { kind: "api_key", secretValues: { TOKEN: "secret" } },
  });
  const plugins = new PluginService(mcps, null);

  expect(await plugins.install("github")).toMatchObject({
    authKind: "api_key",
    resourceId: existing.id,
  });
  expect(mcps.list()).toHaveLength(1);
  expect(mcps.findByIdentity(existing.identity)).toMatchObject({
    name: "my-github",
    headers: expect.any(Object),
  });
  store.close();
});
