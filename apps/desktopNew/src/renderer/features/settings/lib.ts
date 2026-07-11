// Pure join/format helpers for the settings window (mcp-skills.md §7).
// Behavior is contract-bound to the old settings modal — the encoding-match
// rules in importedCounts are subtle and regression-prone (see lib.test.ts).
// Node-safe: type-only imports, no DOM, no React.
import type { Harness, ImportLedgerEntry } from "@agena/protocol";
import type {
  DiscoveredMcp,
  DiscoveredSkill,
  ImportedMcp,
  ImportedSkill,
  ProjectGroup,
} from "../../../shared/bridge.ts";

export type SettingsSearchItem<T extends string = string> = {
  id: T;
  title: string;
  keywords: readonly string[];
};

/** Small local index for the settings navigator; section content remains authoritative. */
export function filterSettingsItems<T extends SettingsSearchItem>(
  items: readonly T[],
  query: string,
): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items];
  return items.filter((item) => {
    const text = [item.title, ...item.keywords].join(" ").toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export const HARNESSES: readonly Harness[] = ["claude", "codex", "pi"];

export const HARNESS_LABEL: Record<Harness, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};

/** "/Users/me/Desktop/x" → "~/Desktop/x" (display only; main owns real paths). */
export function shortenHome(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** null → "—"; 512 → "512 B"; 72_704 → "71 KB" (v ≥ 10 rounded, else one decimal). */
export function humanBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Discovered × imported joins are ALWAYS by `identity` string equality — never
 * by name (rename-safe) and never by id (different id spaces).
 */
export function mcpImportState(
  mcp: DiscoveredMcp,
  imported: readonly ImportedMcp[],
): "not_imported" | "imported" | "ready" | "needs_authorization" | "error" {
  const found = imported.find((item) => item.identity === mcp.identity);
  if (!found) return "not_imported";
  return found.status;
}

export function skillImportState(
  skill: DiscoveredSkill,
  imported: readonly ImportedSkill[],
): "not_imported" | "imported" | "update" | "error" {
  const found = imported.find((item) => item.identity === skill.identity);
  if (!found) return "not_imported";
  if (found.status === "error") return "error";
  if (found.status === "update_available") return "update";
  // contentHash mismatch = the local folder changed since import — offer Update
  return found.contentHash === skill.contentHash ? "imported" : "update";
}

/**
 * Ledger rows for a project. Anchors: exact cwd (harness "files" rows are keyed
 * by it) or a whole path segment equal to an encoded cwd — Claude's project dir
 * (every non-alphanumeric char → "-") or the old pi store dir (--cwd-dashes--).
 * Segment EQUALITY, never substring: "-Users-dev-app" must not match app2.
 * ponytail: codex rollout paths carry no cwd — codex rows don't attribute; fix
 * needs a ledger cwd column daemon-side.
 */
export function importedCounts(
  cwd: string,
  imports: readonly ImportLedgerEntry[],
): Partial<Record<ImportLedgerEntry["harness"], number>> {
  const encodings = new Set([
    cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    `--${cwd.replace(/^\//, "").replace(/[/:]/g, "-")}--`,
  ]);
  const out: Partial<Record<ImportLedgerEntry["harness"], number>> = {};
  for (const row of imports) {
    if (
      row.sourcePath !== cwd &&
      !row.sourcePath.split("/").some((seg) => encodings.has(seg))
    ) {
      continue;
    }
    out[row.harness] = (out[row.harness] ?? 0) + 1;
  }
  return out;
}

/** Σ max(0, scannedCount[h] − importedCount[h]) — 0 means "imported ✓". */
export function freshSessionCount(
  project: ProjectGroup,
  imports: readonly ImportLedgerEntry[],
): number {
  const counts = importedCounts(project.cwd, imports);
  return HARNESSES.reduce(
    (n, h) =>
      n + Math.max(0, (project.byHarness[h]?.count ?? 0) - (counts[h] ?? 0)),
    0,
  );
}

/** Total ledger rows attributed to a project's cwd (0 = never imported). */
export function importedTotal(
  cwd: string,
  imports: readonly ImportLedgerEntry[],
): number {
  return Object.values(importedCounts(cwd, imports)).reduce((a, b) => a + b, 0);
}

export function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? "project";
}

export function sessionBytes(p: ProjectGroup): number {
  return HARNESSES.reduce((n, h) => n + (p.byHarness[h]?.bytes ?? 0), 0);
}

/** Harnesses that actually have sessions in a scanned project. */
export function availableHarnesses(p: ProjectGroup): Harness[] {
  return HARNESSES.filter((h) => (p.byHarness[h]?.count ?? 0) > 0);
}

/**
 * Display target for an IMPORTED MCP row. ImportedMcp deliberately carries no
 * command/url, but the identity encodes one: "remote:<clean url>" or
 * "stdio:<JSON [command, ...args]>" (mcp-skills.md §5.1).
 */
export function mcpTargetFromIdentity(identity: string): string | null {
  if (identity.startsWith("remote:")) return identity.slice("remote:".length);
  if (identity.startsWith("stdio:")) {
    try {
      const arr: unknown = JSON.parse(identity.slice("stdio:".length));
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) {
        return arr.join(" ");
      }
    } catch {
      // unparseable identity — fall through
    }
  }
  return null;
}
