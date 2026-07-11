import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@agena/storage-sqlite";
import { afterEach, expect, test } from "vitest";
import { McpService } from "../src/mcp-service.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("persists a secret-free MCP registry and encrypted API-key material", async () => {
  const state = mkdtempSync(join(tmpdir(), "agena-mcp-"));
  dirs.push(state);
  const store = new SqliteEventStore(join(state, "db", "agena.db"));
  const service = new McpService(store, state);
  await service.initialize();
  const imported = await service.import({
    identity: "remote:https://example.test/mcp",
    name: "example",
    transport: "http",
    url: "https://example.test/mcp",
    headers: { Authorization: "Bearer $" + "{API_KEY}" },
    auth: { kind: "api_key", secretValues: { API_KEY: "top-secret-value" } },
  });

  expect(imported).toMatchObject({
    identity: "remote:https://example.test/mcp",
    name: "example",
    authKind: "api_key",
    status: "imported",
  });
  expect(JSON.stringify(service.list())).not.toContain("top-secret-value");
  expect(readFileSync(join(state, "pi", "mcp.json"), "utf8")).not.toContain(
    "top-secret-value",
  );
  expect(
    readFileSync(join(state, "config", "mcp-secrets.enc"), "utf8"),
  ).not.toContain("top-secret-value");
  expect(statSync(join(state, "config", "mcp-secrets.enc")).mode & 0o777).toBe(
    0o600,
  );
  expect(statSync(join(state, "config", "mcp-secrets.key")).mode & 0o777).toBe(
    0o600,
  );
  store.close();
});
