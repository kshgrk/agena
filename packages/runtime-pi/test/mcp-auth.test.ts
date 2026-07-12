import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeMcpAuth } from "../src/mcp.ts";

test("removes a server's persisted OAuth entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "agena-mcp-auth-"));
  const previous = process.env.MCP_OAUTH_DIR;
  process.env.MCP_OAUTH_DIR = root;
  const name = "github";
  const key = createHash("sha256").update(name).digest("hex");
  const serverDir = join(root, `sha256-${key}`);
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(join(serverDir, "tokens.json"), '{"accessToken":"secret"}');
  try {
    await removeMcpAuth(name);
    assert.equal(existsSync(serverDir), false);
  } finally {
    if (previous === undefined) delete process.env.MCP_OAUTH_DIR;
    else process.env.MCP_OAUTH_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
