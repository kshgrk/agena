import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImportLedgerEntry } from "@agena/protocol";
import type {
  DiscoveredMcp,
  DiscoveredSkill,
  ImportedMcp,
  ImportedSkill,
  ProjectGroup,
} from "../../../shared/bridge.ts";
import {
  filterSettingsItems,
  freshSessionCount,
  humanBytes,
  importedCounts,
  importedTotal,
  mcpImportState,
  mcpTargetFromIdentity,
  shortenHome,
  skillImportState,
} from "./lib.ts";

test("filterSettingsItems matches every query term across title and keywords", () => {
  const items = [
    { id: "providers", title: "Providers", keywords: ["models", "api key"] },
    { id: "mcp", title: "MCP servers", keywords: ["oauth", "tools"] },
  ] as const;
  assert.deepEqual(
    filterSettingsItems(items, "api models").map((x) => x.id),
    ["providers"],
  );
  assert.deepEqual(
    filterSettingsItems(items, " oauth ").map((x) => x.id),
    ["mcp"],
  );
  assert.equal(filterSettingsItems(items, "missing").length, 0);
});

// ---- shortenHome ---------------------------------------------------------------

test("shortenHome collapses macOS and Linux homes", () => {
  assert.equal(shortenHome("/Users/dev/Desktop/x"), "~/Desktop/x");
  assert.equal(shortenHome("/home/dev/app"), "~/app");
  assert.equal(shortenHome("/Users/dev"), "~");
  assert.equal(shortenHome("/opt/thing"), "/opt/thing");
  // must not eat a prefix that only LOOKS like a home
  assert.equal(shortenHome("/Usersfoo/dev/x"), "/Usersfoo/dev/x");
});

// ---- humanBytes (spec examples from mcp-skills.md §7) ----------------------------

test("humanBytes spec examples", () => {
  assert.equal(humanBytes(null), "—");
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(72_704), "71 KB");
  assert.equal(humanBytes(48_234_496), "46 MB");
  assert.equal(humanBytes(1536), "1.5 KB"); // < 10 keeps one decimal
});

// ---- mcpImportState -------------------------------------------------------------

const mcp = (identity: string): DiscoveredMcp => ({
  id: "d1",
  identity,
  name: "renamed-locally",
  transport: "http",
  target: "https://mcp.example.com",
  authKind: "oauth",
  authStatus: "needs_authorization",
});

const importedMcp = (
  identity: string,
  status: ImportedMcp["status"],
): ImportedMcp => ({ id: "mcp_1", identity, name: "original-name", status });

test("mcpImportState joins by identity, never by name", () => {
  const rows = [importedMcp("remote:https://mcp.example.com", "ready")];
  assert.equal(
    mcpImportState(mcp("remote:https://mcp.example.com"), rows),
    "ready",
  );
  assert.equal(
    mcpImportState(mcp("remote:https://other.example"), rows),
    "not_imported",
  );
});

test("mcpImportState passes the imported row's status through", () => {
  for (const status of ["imported", "needs_authorization", "error"] as const) {
    const rows = [importedMcp("remote:https://mcp.example.com", status)];
    assert.equal(
      mcpImportState(mcp("remote:https://mcp.example.com"), rows),
      status,
    );
  }
});

// ---- skillImportState -------------------------------------------------------------

const skill = (identity: string, contentHash: string): DiscoveredSkill => ({
  id: "s1",
  identity,
  contentHash,
  name: "my-skill",
  fileCount: 3,
});

const importedSkill = (
  identity: string,
  contentHash: string,
  status: ImportedSkill["status"],
): ImportedSkill => ({
  id: "skill_1",
  identity,
  contentHash,
  name: "my-skill",
  status,
});

test("skillImportState state ladder", () => {
  const id = "skill:abc";
  assert.equal(skillImportState(skill(id, "h1"), []), "not_imported");
  assert.equal(
    skillImportState(skill(id, "h1"), [importedSkill(id, "h1", "error")]),
    "error",
  );
  assert.equal(
    skillImportState(skill(id, "h1"), [
      importedSkill(id, "h1", "update_available"),
    ]),
    "update",
  );
  assert.equal(
    skillImportState(skill(id, "h1"), [importedSkill(id, "h1", "ready")]),
    "imported",
  );
  // local folder changed since import → offer Update even when daemon says ready
  assert.equal(
    skillImportState(skill(id, "h2"), [importedSkill(id, "h1", "ready")]),
    "update",
  );
});

// ---- importedCounts ---------------------------------------------------------------

const ledger = (
  harness: ImportLedgerEntry["harness"],
  sourcePath: string,
): ImportLedgerEntry => ({
  id: `row-${sourcePath}-${harness}`,
  projectId: "p1",
  machineId: "m1",
  harness,
  sourcePath,
  importedAt: "2026-07-11T00:00:00Z",
});

test("importedCounts matches exact cwd (files rows)", () => {
  const rows = [ledger("files", "/Users/dev/app")];
  assert.deepEqual(importedCounts("/Users/dev/app", rows), { files: 1 });
});

test("importedCounts matches Claude's encoded project dir by whole segment", () => {
  const rows = [
    ledger("claude", "/Users/dev/.claude/projects/-Users-dev-app/abc.jsonl"),
  ];
  assert.deepEqual(importedCounts("/Users/dev/app", rows), { claude: 1 });
  // segment EQUALITY, never substring: app must not match app2
  assert.deepEqual(importedCounts("/Users/dev/ap", rows), {});
  const rows2 = [
    ledger("claude", "/Users/dev/.claude/projects/-Users-dev-app2/abc.jsonl"),
  ];
  assert.deepEqual(importedCounts("/Users/dev/app", rows2), {});
});

test("importedCounts matches the old pi store dir encoding", () => {
  const rows = [
    ledger("pi", "/Users/dev/.pi/sessions/--Users-dev-app--/x_uuid.jsonl"),
  ];
  assert.deepEqual(importedCounts("/Users/dev/app", rows), { pi: 1 });
});

test("importedCounts counts multiple rows per harness", () => {
  const rows = [
    ledger("claude", "/x/-Users-dev-app/a.jsonl"),
    ledger("claude", "/x/-Users-dev-app/b.jsonl"),
    ledger("files", "/Users/dev/app"),
  ];
  assert.deepEqual(importedCounts("/Users/dev/app", rows), {
    claude: 2,
    files: 1,
  });
  assert.equal(importedTotal("/Users/dev/app", rows), 3);
});

// ---- freshSessionCount --------------------------------------------------------------

const project = (cwd: string, claudeCount: number): ProjectGroup =>
  ({
    cwd,
    exists: true,
    codebaseBytes: 1024,
    byHarness: {
      claude: { count: claudeCount, bytes: 100 },
      codex: { count: 0, bytes: 0 },
      pi: { count: 0, bytes: 0 },
    },
  }) as ProjectGroup;

test("freshSessionCount is Σ max(0, scanned − imported)", () => {
  const rows = [
    ledger("claude", "/x/-Users-dev-app/a.jsonl"),
    ledger("claude", "/x/-Users-dev-app/b.jsonl"),
  ];
  assert.equal(freshSessionCount(project("/Users/dev/app", 5), rows), 3);
  assert.equal(freshSessionCount(project("/Users/dev/app", 2), rows), 0);
  // more imported than scanned clamps at 0
  assert.equal(freshSessionCount(project("/Users/dev/app", 1), rows), 0);
});

// ---- mcpTargetFromIdentity -------------------------------------------------------

test("mcpTargetFromIdentity decodes remote and stdio identities", () => {
  assert.equal(
    mcpTargetFromIdentity("remote:https://mcp.example.com"),
    "https://mcp.example.com",
  );
  assert.equal(
    mcpTargetFromIdentity('stdio:["npx","-y","server-github"]'),
    "npx -y server-github",
  );
  assert.equal(mcpTargetFromIdentity("stdio:not-json"), null);
  assert.equal(mcpTargetFromIdentity("stdio:[1,2]"), null);
  assert.equal(mcpTargetFromIdentity("skill:abcdef"), null);
});
