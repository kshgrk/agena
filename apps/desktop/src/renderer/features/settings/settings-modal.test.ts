import type { ImportLedgerEntry } from "@agena/protocol";
import { describe, expect, it } from "vitest";
import { humanBytes, importedCounts, shortenHome } from "./settings-modal.tsx";

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
