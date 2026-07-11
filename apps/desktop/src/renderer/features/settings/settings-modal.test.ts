import type { ImportLedgerEntry } from "@agena/protocol";
import { describe, expect, it } from "vitest";
import {
  humanBytes,
  importedCounts,
  mcpImportState,
  shortenHome,
  skillImportState,
} from "./settings-modal.tsx";

const CWD = "/Users/dev/Desktop/Rough/openwork";

function row(
  harness: ImportLedgerEntry["harness"],
  sourcePath: string,
): ImportLedgerEntry {
  return {
    id: sourcePath,
    projectId: "prj_openwork",
    machineId: "m1",
    harness,
    sourcePath,
    importedAt: "2026-07-09T08:00:00.000Z",
  };
}

describe("importedCounts", () => {
  it("joins ledger rows by exact cwd and dash-encoded cwd, ignores others", () => {
    const imports = [
      row("files", CWD),
      row(
        "claude",
        `/Users/dev/.claude/projects/${CWD.replaceAll("/", "-")}/a.jsonl`,
      ),
      row("claude", "/Users/dev/.claude/projects/-Users-dev-other/b.jsonl"),
      row("codex", "/Users/dev/.codex/sessions/2026/07/08/rollout-x.jsonl"),
    ];
    expect(importedCounts(CWD, imports)).toEqual({ files: 1, claude: 1 });
  });

  it("never matches a sibling project whose encoding is a superstring", () => {
    const sibling = row(
      "claude",
      "/Users/dev/.claude/projects/-Users-dev-Desktop-Rough-openwork2/a.jsonl",
    );
    expect(importedCounts(CWD, [sibling])).toEqual({});
    expect(importedCounts(`${CWD}2`, [sibling])).toEqual({ claude: 1 });
  });

  it("matches Claude's encoding of non-slash chars (dots → dashes)", () => {
    const imports = [
      row("claude", "/Users/dev/.claude/projects/-Users-dev-app-js/a.jsonl"),
    ];
    expect(importedCounts("/Users/dev/app.js", imports)).toEqual({
      claude: 1,
    });
  });
});

describe("display helpers", () => {
  it("shortens home and formats bytes", () => {
    expect(shortenHome(CWD)).toBe("~/Desktop/Rough/openwork");
    expect(shortenHome("/workspace/x")).toBe("/workspace/x");
    expect(humanBytes(null)).toBe("—");
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(72_704)).toBe("71 KB");
    expect(humanBytes(48_234_496)).toBe("46 MB");
  });
});

describe("mcpImportState", () => {
  const discovered = {
    id: "local",
    identity: "remote:https://mcp.example.com/mcp",
    name: "example",
    transport: "http" as const,
    target: "https://mcp.example.com/mcp",
    authKind: "oauth" as const,
    authStatus: "needs_authorization" as const,
  };

  it("joins by normalized identity without source-harness data", () => {
    expect(mcpImportState(discovered, [])).toBe("not_imported");
    expect(
      mcpImportState(discovered, [
        {
          id: "remote",
          identity: discovered.identity,
          name: "renamed",
          status: "needs_authorization",
        },
      ]),
    ).toBe("needs_authorization");
  });
});

describe("skillImportState", () => {
  const discovered = {
    id: "local",
    identity: "git:https://example.com/skills#review",
    contentHash: "new",
    name: "review",
    fileCount: 2,
  };

  it("distinguishes imported content from an available update", () => {
    expect(skillImportState(discovered, [])).toBe("not_imported");
    expect(
      skillImportState(discovered, [
        {
          id: "remote",
          identity: discovered.identity,
          contentHash: "old",
          name: "review",
          status: "ready",
        },
      ]),
    ).toBe("update");
  });
});
