// Settings modal (settings_import_plan.md §1): ⌘, overlay. One section for now
// (Import — the local-session import checklist tree); add a nav when a second
// section actually lands.
import type { Harness, ImportLedgerEntry } from "@agena/protocol";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  DiscoveredMcp,
  DiscoveredSkill,
  ImportedMcp,
  ImportedSkill,
  ImportPlan,
  ImportRunResult,
  McpImportRunResult,
  ProjectGroup,
  SkillImportRunResult,
} from "../../../shared/bridge.ts";
import { getBridge } from "../../lib/bridge.ts";
import { errMsg } from "../../lib/errors.ts";
import { useUi } from "../../store/index.ts";
import {
  Badge,
  Button,
  cx,
  Modal,
  ModalTitle,
  Spinner,
  toast,
} from "../../ui/index.ts";

const HARNESSES: readonly Harness[] = ["claude", "codex", "pi"];
const HARNESS_LABEL: Record<Harness, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
};

// ---- helpers -----------------------------------------------------------------

/** "/Users/me/Desktop/x" → "~/Desktop/x" (display only; main owns real paths). */
export function shortenHome(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

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
  return found.contentHash === skill.contentHash ? "imported" : "update";
}

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
 * Ledger rows for a project. Anchors: exact cwd (harness "files" rows are keyed
 * by it) or a whole path segment equal to an encoded cwd — Claude's project dir
 * (every non-alphanumeric char → "-") or the old pi store dir (--cwd-dashes--).
 * Segment equality, never substring: "-Users-dev-app" must not match app2.
 * ponytail: codex rollout paths carry no cwd, and the newer pi store encodes
 * relative to $HOME (unknown here) — attribute those via a ledger cwd column.
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

function projectName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? "project";
}

function sessionBytes(p: ProjectGroup): number {
  return HARNESSES.reduce((n, h) => n + (p.byHarness[h]?.bytes ?? 0), 0);
}

// ---- import section ------------------------------------------------------------

function ImportBadge({
  project,
  imports,
}: {
  project: ProjectGroup;
  imports: readonly ImportLedgerEntry[];
}) {
  const counts = importedCounts(project.cwd, imports);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const fresh = HARNESSES.reduce(
    (n, h) =>
      n + Math.max(0, (project.byHarness[h]?.count ?? 0) - (counts[h] ?? 0)),
    0,
  );
  return fresh === 0 ? (
    <Badge tone="ok">imported ✓</Badge>
  ) : (
    <Badge tone="warn">{fresh} new since import</Badge>
  );
}

function ProjectRow({
  project,
  imports,
  selected,
  expanded,
  onToggleProject,
  onToggleHarness,
  onToggleExpanded,
}: {
  project: ProjectGroup;
  imports: readonly ImportLedgerEntry[];
  /** undefined = project unticked; a set (possibly empty) = ticked. */
  selected: ReadonlySet<Harness> | undefined;
  expanded: boolean;
  onToggleProject: () => void;
  onToggleHarness: (harness: Harness) => void;
  onToggleExpanded: () => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const counts = HARNESSES.filter((h) => (project.byHarness[h]?.count ?? 0) > 0)
    .map((h) => `${h} ${project.byHarness[h]?.count}`)
    .join(" · ");
  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <input
          type="checkbox"
          className="accent-accent"
          checked={selected !== undefined}
          onChange={onToggleProject}
          aria-label={`Import ${project.cwd}`}
        />
        <button
          type="button"
          onClick={onToggleExpanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-ink"
        >
          <Chevron className="size-3 shrink-0 text-ink-mute" />
          <span
            className={cx(
              "min-w-0 flex-1 truncate font-mono text-xs",
              project.exists ? "text-ink" : "text-ink-mute line-through",
            )}
            title={project.cwd}
          >
            {shortenHome(project.cwd)}
          </span>
        </button>
        <span className="shrink-0 text-[10px] text-ink-dim">
          {counts || "no sessions"}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-ink-mute">
          proj {humanBytes(project.codebaseBytes)} · sess{" "}
          {humanBytes(sessionBytes(project))}
        </span>
        <ImportBadge project={project} imports={imports} />
      </div>
      {expanded ? (
        <div className="space-y-0.5 pb-1.5 pl-9">
          {HARNESSES.map((h) => {
            const info = project.byHarness[h];
            if (!info || info.count === 0) return null;
            return (
              <label
                key={h}
                className="flex items-center gap-2 text-xs text-ink-dim"
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={selected?.has(h) ?? false}
                  onChange={() => onToggleHarness(h)}
                />
                {HARNESS_LABEL[h]} ({info.count} session
                {info.count === 1 ? "" : "s"}, {humanBytes(info.bytes)})
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ImportSection() {
  const [projects, setProjects] = useState<ProjectGroup[] | null>(null);
  const [imports, setImports] = useState<ImportLedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, Set<Harness>>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ImportRunResult["sessions"] | null>(
    null,
  );
  // Daemon predates /v1/imports (404) — scan still renders, importing is off.
  const [daemonSupport, setDaemonSupport] = useState(true);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const [scan, status] = await Promise.all([
        getBridge().importScan({ refresh }),
        getBridge()
          .importStatus()
          .catch(() => null),
      ]);
      setProjects(scan.projects);
      setImports(status?.imports ?? []);
      setDaemonSupport(status !== null);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const toggleProject = (p: ProjectGroup) =>
    setSelected((prev) => {
      const next = { ...prev };
      if (next[p.cwd]) delete next[p.cwd];
      else {
        next[p.cwd] = new Set(
          HARNESSES.filter((h) => (p.byHarness[h]?.count ?? 0) > 0),
        );
      }
      return next;
    });

  const toggleHarness = (cwd: string, h: Harness) =>
    setSelected((prev) => {
      const set = new Set(prev[cwd] ?? []);
      if (set.has(h)) set.delete(h);
      else set.add(h);
      return { ...prev, [cwd]: set };
    });

  const run = async (filesOnly: boolean) => {
    if (!projects || running) return;
    const plan: ImportPlan = {
      projects: Object.entries(selected).map(([cwd, harnesses]) => {
        const p = projects.find((x) => x.cwd === cwd);
        return {
          cwd,
          name: projectName(cwd),
          // file copy only works when the cwd still exists and is a git repo
          copyFiles: (p?.exists ?? false) && p?.codebaseBytes !== null,
          harnesses: filesOnly ? [] : [...harnesses],
        };
      }),
    };
    if (plan.projects.length === 0) return;
    setRunning(true);
    setResults(null);
    try {
      const res = await getBridge().importRun(plan);
      setResults(res.sessions);
      setSelected({});
      await load(false);
    } catch (err) {
      toast(errMsg(err), { tone: "err" });
    } finally {
      setRunning(false);
    }
  };

  const selectedCount = Object.keys(selected).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between pb-2">
        <span className="text-xs font-medium text-ink">
          Import from this machine
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw />}
          disabled={loading || running}
          onClick={() => void load(true)}
        >
          Refresh
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded border border-border">
        {loading && projects === null ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner />
          </div>
        ) : error ? (
          <div className="p-3 text-xs text-err">{error}</div>
        ) : projects && projects.length > 0 ? (
          projects.map((p) => (
            <ProjectRow
              key={p.cwd}
              project={p}
              imports={imports}
              selected={selected[p.cwd]}
              expanded={expanded.has(p.cwd)}
              onToggleProject={() => toggleProject(p)}
              onToggleHarness={(h) => toggleHarness(p.cwd, h)}
              onToggleExpanded={() =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(p.cwd)) next.delete(p.cwd);
                  else next.add(p.cwd);
                  return next;
                })
              }
            />
          ))
        ) : (
          <div className="p-3 text-xs text-ink-mute">
            No local Claude Code, Codex, or Pi sessions found.
          </div>
        )}
      </div>

      {running ? (
        <div className="flex shrink-0 items-center gap-2 py-2 text-xs text-ink-dim">
          <Spinner /> Importing…
        </div>
      ) : results ? (
        <div className="max-h-40 shrink-0 overflow-y-auto py-2">
          {results.length === 0 ? (
            <div className="text-xs text-ink-mute">
              Nothing to import (project files only).
            </div>
          ) : (
            results.map((r) => (
              <div
                key={r.sourcePath}
                className="flex items-center gap-2 py-0.5 text-[11px]"
              >
                <Badge
                  tone={
                    r.status === "ok"
                      ? "ok"
                      : r.status === "skipped"
                        ? "neutral"
                        : "err"
                  }
                >
                  {r.status}
                </Badge>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-ink-dim"
                  title={r.sourcePath}
                >
                  {shortenHome(r.sourcePath)}
                </span>
                {r.error ? (
                  <span className="shrink-0 text-err">{r.error}</span>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border pt-3">
        {daemonSupport ? null : (
          <span className="mr-auto text-xs text-muted">
            Connected daemon doesn't support imports yet — update the
            deployment.
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={!daemonSupport || running || selectedCount === 0}
          onClick={() => void run(true)}
        >
          Import project only
        </Button>
        <Button
          size="sm"
          disabled={!daemonSupport || running || selectedCount === 0}
          onClick={() => void run(false)}
        >
          Import selected
        </Button>
      </div>
    </div>
  );
}

function McpImportSection() {
  const setSettingsOpen = useUi((state) => state.setSettingsOpen);
  const [mcps, setMcps] = useState<DiscoveredMcp[] | null>(null);
  const [imported, setImported] = useState<ImportedMcp[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<McpImportRunResult["mcps"] | null>(
    null,
  );

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const [scan, status] = await Promise.all([
        getBridge().mcpImportScan({ refresh }),
        getBridge().mcpImportStatus(),
      ]);
      setMcps(scan.mcps);
      setImported(status.mcps);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(false), [load]);

  const run = async () => {
    if (selected.size === 0 || running) return;
    setRunning(true);
    setResults(null);
    try {
      const result = await getBridge().mcpImportRun({ ids: [...selected] });
      setResults(result.mcps);
      setSelected(new Set());
      await load(false);
    } catch (err) {
      toast(errMsg(err), { tone: "err" });
    } finally {
      setRunning(false);
    }
  };

  const authorize = async (mcpId: string) => {
    try {
      await getBridge().mcpAuthStart(mcpId);
      setSettingsOpen(false);
      toast("Authorization opened in Agena's browser.");
    } catch (err) {
      toast(errMsg(err), { tone: "err" });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between pb-2">
        <div>
          <div className="text-xs font-medium text-ink">
            MCPs found on this machine
          </div>
          <div className="text-[11px] text-ink-mute">
            OAuth connections authorize Agena separately. API keys are copied
            securely.
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw />}
          disabled={loading || running}
          onClick={() => void load(true)}
        >
          Refresh
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded border border-border">
        {loading && mcps === null ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner />
          </div>
        ) : error ? (
          <div className="p-3 text-xs text-err">{error}</div>
        ) : mcps && mcps.length > 0 ? (
          mcps.map((mcp) => {
            const state = mcpImportState(mcp, imported);
            const record = imported.find(
              (item) => item.identity === mcp.identity,
            );
            return (
              <div
                key={mcp.id}
                className="flex items-center gap-2 border-b border-border px-2 py-2 last:border-b-0"
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={selected.has(mcp.id)}
                  disabled={
                    state !== "not_imported" ||
                    mcp.authStatus === "missing_secret"
                  }
                  onChange={() =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (next.has(mcp.id)) next.delete(mcp.id);
                      else next.add(mcp.id);
                      return next;
                    })
                  }
                  aria-label={`Import ${mcp.name}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-ink">
                    {mcp.name}
                  </div>
                  <div
                    className="truncate font-mono text-[10px] text-ink-mute"
                    title={mcp.target}
                  >
                    {mcp.target}
                  </div>
                </div>
                <Badge tone="neutral">{mcp.transport}</Badge>
                {state === "imported" ? (
                  <Badge tone="neutral">imported · not verified</Badge>
                ) : null}
                {state === "ready" ? (
                  <Badge tone="ok">ready · connects on use</Badge>
                ) : null}
                {state === "not_imported" &&
                mcp.authStatus !== "missing_secret" ? (
                  <Badge tone="neutral">not imported</Badge>
                ) : null}
                {mcp.authStatus === "missing_secret" ? (
                  <Badge tone="warn">missing API key</Badge>
                ) : null}
                {state === "needs_authorization" ? (
                  <Button
                    size="sm"
                    onClick={() => record && void authorize(record.id)}
                  >
                    Authorize
                  </Button>
                ) : null}
                {state === "error" ? <Badge tone="err">error</Badge> : null}
              </div>
            );
          })
        ) : (
          <div className="p-3 text-xs text-ink-mute">
            No local MCP servers found.
          </div>
        )}
      </div>
      {results ? (
        <div className="max-h-24 shrink-0 overflow-y-auto py-2 text-[11px] text-ink-dim">
          {results.map((result) => (
            <div key={result.id}>
              {result.status === "error" ? result.error : result.status}
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex shrink-0 items-center justify-end border-t border-border pt-3">
        <Button
          size="sm"
          disabled={running || selected.size === 0}
          onClick={() => void run()}
        >
          {running
            ? "Importing…"
            : `Import selected${selected.size ? ` (${selected.size})` : ""}`}
        </Button>
      </div>
    </div>
  );
}

function SkillImportSection() {
  const [skills, setSkills] = useState<DiscoveredSkill[] | null>(null);
  const [imported, setImported] = useState<ImportedSkill[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SkillImportRunResult["skills"] | null>(
    null,
  );

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const [scan, status] = await Promise.all([
        getBridge().skillImportScan({ refresh }),
        getBridge().skillImportStatus({ refresh }),
      ]);
      setSkills(scan.skills);
      setImported(status.skills);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(false), [load]);

  const run = async () => {
    if (selected.size === 0 || running) return;
    setRunning(true);
    setResults(null);
    try {
      const result = await getBridge().skillImportRun({ ids: [...selected] });
      setResults(result.skills);
      setSelected(new Set());
      await load(false);
    } catch (err) {
      toast(errMsg(err), { tone: "err" });
    } finally {
      setRunning(false);
    }
  };

  const update = async (skillId: string) => {
    if (running) return;
    setRunning(true);
    try {
      await getBridge().skillUpdate(skillId);
      await load(false);
    } catch (err) {
      toast(errMsg(err), { tone: "err" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between pb-2">
        <div>
          <div className="text-xs font-medium text-ink">
            Skills found on this machine
          </div>
          <div className="text-[11px] text-ink-mute">
            Skill folders, scripts, references, and assets are copied together.
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw />}
          disabled={loading || running}
          onClick={() => void load(true)}
        >
          Refresh
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded border border-border">
        {loading && skills === null ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner />
          </div>
        ) : error ? (
          <div className="p-3 text-xs text-err">{error}</div>
        ) : skills && skills.length > 0 ? (
          skills.map((skill) => {
            const state = skillImportState(skill, imported);
            const record = imported.find(
              (item) => item.identity === skill.identity,
            );
            return (
              <div
                key={skill.id}
                className="flex items-center gap-2 border-b border-border px-2 py-2 last:border-b-0"
              >
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={selected.has(skill.id)}
                  disabled={state === "imported"}
                  onChange={() =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (next.has(skill.id)) next.delete(skill.id);
                      else next.add(skill.id);
                      return next;
                    })
                  }
                  aria-label={`Import ${skill.name}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-ink">
                    {skill.name}
                  </div>
                  <div className="truncate text-[10px] text-ink-mute">
                    {skill.description ??
                      `${skill.fileCount} file${skill.fileCount === 1 ? "" : "s"}`}
                  </div>
                </div>
                <span className="text-[10px] text-ink-mute">
                  {skill.fileCount} files
                </span>
                {state === "imported" ? (
                  <Badge tone="ok">imported ✓</Badge>
                ) : null}
                {state === "not_imported" ? (
                  <Badge tone="neutral">not imported</Badge>
                ) : null}
                {state === "update" ? (
                  record ? (
                    <Button
                      size="sm"
                      disabled={running}
                      onClick={() => void update(record.id)}
                    >
                      Update
                    </Button>
                  ) : (
                    <Badge tone="warn">update available</Badge>
                  )
                ) : null}
                {state === "error" ? <Badge tone="err">error</Badge> : null}
              </div>
            );
          })
        ) : (
          <div className="p-3 text-xs text-ink-mute">
            No local skills found.
          </div>
        )}
      </div>
      {results ? (
        <div className="max-h-24 shrink-0 overflow-y-auto py-2 text-[11px] text-ink-dim">
          {results.map((result) => (
            <div key={result.id}>
              {result.status === "error" ? result.error : result.status}
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex shrink-0 items-center justify-end border-t border-border pt-3">
        <Button
          size="sm"
          disabled={running || selected.size === 0}
          onClick={() => void run()}
        >
          {running
            ? "Importing…"
            : `Import selected${selected.size ? ` (${selected.size})` : ""}`}
        </Button>
      </div>
    </div>
  );
}

// ---- the modal --------------------------------------------------------------

export function SettingsModal() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const [section, setSection] = useState<"sessions" | "mcps" | "skills">(
    "sessions",
  );

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      size="lg"
      className="flex h-[540px] max-h-[85vh] flex-col"
    >
      <ModalTitle>Settings</ModalTitle>
      <div className="mt-3 flex min-h-0 flex-1 gap-4">
        <nav
          className="w-32 shrink-0 space-y-1 border-r border-border pr-3"
          aria-label="Settings sections"
        >
          <button
            type="button"
            onClick={() => setSection("sessions")}
            className={cx(
              "w-full rounded px-2 py-1.5 text-left text-xs",
              section === "sessions"
                ? "bg-surface-raised text-ink"
                : "text-ink-mute hover:text-ink",
            )}
          >
            Session import
          </button>
          <button
            type="button"
            onClick={() => setSection("mcps")}
            className={cx(
              "w-full rounded px-2 py-1.5 text-left text-xs",
              section === "mcps"
                ? "bg-surface-raised text-ink"
                : "text-ink-mute hover:text-ink",
            )}
          >
            MCP import
          </button>
          <button
            type="button"
            onClick={() => setSection("skills")}
            className={cx(
              "w-full rounded px-2 py-1.5 text-left text-xs",
              section === "skills"
                ? "bg-surface-raised text-ink"
                : "text-ink-mute hover:text-ink",
            )}
          >
            Skill import
          </button>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          {section === "sessions" ? (
            <ImportSection />
          ) : section === "mcps" ? (
            <McpImportSection />
          ) : (
            <SkillImportSection />
          )}
        </div>
      </div>
    </Modal>
  );
}
