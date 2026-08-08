// Session import section: bring Claude Code / Codex / Pi sessions from this
// machine into the daemon. Improvements over the old modal (mcp-skills.md §8):
// real tri-state project checkboxes, copyFiles is a visible pre-checked option
// (not silently derived), results stay attached until the next run, and the
// import is idempotent — re-runs show "skipped" for already-imported sessions.
import type { Harness, ImportLedgerEntry } from "@agena/protocol";
import { ChevronRight, FolderInput } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  ImportPlan,
  ImportRunResult,
  ProjectGroup,
} from "../../../shared/bridge.ts";
import { getBridge } from "../../lib/bridge.ts";
import { formatBridgeError, isDesktopOnlyError } from "../../lib/errors.ts";
import { pushToast } from "../../store/index.ts";
import {
  Badge,
  Button,
  Checkbox,
  cx,
  Progress,
  Spinner,
} from "../../ui/index.ts";
import {
  DesktopOnlyState,
  EmptyRow,
  GroupLabel,
  InlineError,
  ListCard,
  LoadingRow,
  RefreshButton,
  SectionHeader,
} from "./common.tsx";
import {
  availableHarnesses,
  freshSessionCount,
  HARNESS_LABEL,
  HARNESSES,
  humanBytes,
  importedTotal,
  projectName,
  sessionBytes,
  shortenHome,
} from "./lib.ts";

/** copyFiles default: cwd still exists AND is a git repo (old-app behavior). */
function defaultCopyFiles(p: ProjectGroup): boolean {
  return p.exists && p.codebaseBytes !== null;
}

function SourceCards({
  projects,
  imports,
}: {
  projects: readonly ProjectGroup[];
  imports: readonly ImportLedgerEntry[];
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {HARNESSES.map((h) => {
        const count = projects.reduce(
          (n, p) => n + (p.byHarness[h]?.count ?? 0),
          0,
        );
        const bytes = projects.reduce(
          (n, p) => n + (p.byHarness[h]?.bytes ?? 0),
          0,
        );
        const imported = imports.filter((row) => row.harness === h).length;
        return (
          <div
            key={h}
            className="rounded-lg border border-border-subtle bg-surface p-3"
          >
            <div className="text-sm font-medium text-fg">
              {HARNESS_LABEL[h]}
            </div>
            <div className="mt-0.5 text-xs tabular-nums text-fg-muted">
              {count} session{count === 1 ? "" : "s"} · {humanBytes(bytes)}
            </div>
            <div className="text-xs tabular-nums text-fg-muted">
              {imported} imported
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ImportBadge({
  project,
  imports,
}: {
  project: ProjectGroup;
  imports: readonly ImportLedgerEntry[];
}) {
  if (importedTotal(project.cwd, imports) === 0) return null;
  const fresh = freshSessionCount(project, imports);
  return fresh === 0 ? (
    <Badge tone="success">imported ✓</Badge>
  ) : (
    <Badge tone="warn">{fresh} new since import</Badge>
  );
}

function ProjectRow({
  project,
  imports,
  selected,
  copyFiles,
  expanded,
  disabled,
  onToggleProject,
  onToggleHarness,
  onToggleCopyFiles,
  onToggleExpanded,
}: {
  project: ProjectGroup;
  imports: readonly ImportLedgerEntry[];
  /** undefined = project unticked; a set (possibly empty) = ticked. */
  selected: ReadonlySet<Harness> | undefined;
  copyFiles: boolean;
  expanded: boolean;
  disabled: boolean;
  onToggleProject: () => void;
  onToggleHarness: (harness: Harness) => void;
  onToggleCopyFiles: () => void;
  onToggleExpanded: () => void;
}) {
  const available = availableHarnesses(project);
  const checked: boolean | "indeterminate" =
    selected === undefined
      ? false
      : available.length > 0 && available.every((h) => selected.has(h))
        ? true
        : "indeterminate";
  const counts = available
    .map((h) => `${HARNESS_LABEL[h]} ${project.byHarness[h]?.count ?? 0}`)
    .join(" · ");
  return (
    <div>
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={onToggleProject}
          aria-label={`Import ${project.cwd}`}
        />
        <button
          type="button"
          onClick={onToggleExpanded}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronRight
            className={cx(
              "size-3.5 shrink-0 text-fg-faint transition-transform duration-[140ms]",
              expanded && "rotate-90",
            )}
          />
          <span
            className={cx(
              "min-w-0 flex-1 truncate font-mono text-sm",
              project.exists ? "text-fg" : "text-fg-muted line-through",
            )}
            title={project.cwd}
          >
            {shortenHome(project.cwd)}
          </span>
        </button>
        <span className="shrink-0 text-2xs tabular-nums text-fg-muted">
          proj {humanBytes(project.codebaseBytes)} · sess{" "}
          {humanBytes(sessionBytes(project))}
        </span>
        <ImportBadge project={project} imports={imports} />
      </div>
      {expanded ? (
        <div className="space-y-1.5 pb-2.5 pl-[46px] pr-3">
          <div className="text-2xs text-fg-muted">
            {counts || "no sessions"}
          </div>
          {available.map((h) => {
            const info = project.byHarness[h];
            if (!info) return null;
            return (
              <div
                key={h}
                className="flex w-fit items-center gap-2 text-xs text-fg-secondary"
              >
                <Checkbox
                  checked={selected?.has(h) ?? false}
                  disabled={disabled}
                  onCheckedChange={() => onToggleHarness(h)}
                  aria-label={`Import ${HARNESS_LABEL[h]} sessions`}
                />
                {HARNESS_LABEL[h]} ({info.count} session
                {info.count === 1 ? "" : "s"}, {humanBytes(info.bytes)})
              </div>
            );
          })}
          <div
            className={cx(
              "flex w-fit items-center gap-2 text-xs",
              defaultCopyFiles(project)
                ? "cursor-pointer text-fg-secondary"
                : "text-fg-faint",
            )}
          >
            <Checkbox
              checked={copyFiles && defaultCopyFiles(project)}
              disabled={disabled || !defaultCopyFiles(project)}
              onCheckedChange={onToggleCopyFiles}
              aria-label="Copy project files into the workspace"
            />
            Copy project files into the workspace
            {defaultCopyFiles(project)
              ? ""
              : project.exists
                ? " (not a git repo)"
                : " (folder no longer exists)"}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ResultRow({ r }: { r: ImportRunResult["sessions"][number] }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <Badge
        tone={
          r.status === "ok"
            ? "success"
            : r.status === "skipped"
              ? "neutral"
              : "danger"
        }
      >
        {r.status === "skipped" ? "skipped · already imported" : r.status}
      </Badge>
      <span
        className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted"
        title={r.sourcePath}
      >
        {shortenHome(r.sourcePath)}
      </span>
      {r.error ? (
        <span className="shrink-0 text-xs text-danger">{r.error}</span>
      ) : null}
    </div>
  );
}

export function SessionImportSection() {
  const [projects, setProjects] = useState<ProjectGroup[] | null>(null);
  const [scanError, setScanError] = useState<unknown>(null);
  const [imports, setImports] = useState<ImportLedgerEntry[]>([]);
  // Daemon predates /v1/imports (404) — scan still renders, importing is off.
  const [daemonSupport, setDaemonSupport] = useState(true);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<
    Record<string, ReadonlySet<Harness>>
  >({});
  const [copyFiles, setCopyFiles] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ImportRunResult["sessions"] | null>(
    null,
  );

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    const [scan, status] = await Promise.allSettled([
      getBridge().importScan({ refresh }),
      getBridge().importStatus(),
    ]);
    if (scan.status === "fulfilled") {
      setProjects(scan.value.projects);
      setScanError(null);
    } else {
      setScanError(scan.reason);
    }
    if (status.status === "fulfilled") {
      setImports(status.value.imports);
      setDaemonSupport(status.value.capabilities?.session ?? true);
    } else {
      setImports([]);
      setDaemonSupport(false);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const toggleProject = (p: ProjectGroup) =>
    setSelected((prev) => {
      const next = { ...prev };
      if (next[p.cwd]) delete next[p.cwd];
      else next[p.cwd] = new Set(availableHarnesses(p));
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
        const wantCopy = p ? (copyFiles[cwd] ?? defaultCopyFiles(p)) : false;
        return {
          cwd,
          name: projectName(cwd),
          copyFiles: wantCopy && (p?.exists ?? false),
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
      const ok = res.sessions.filter((r) => r.status === "ok").length;
      const skipped = res.sessions.filter((r) => r.status === "skipped").length;
      const failed = res.sessions.length - ok - skipped;
      pushToast({
        kind: failed > 0 ? "warn" : "ok",
        title: filesOnly
          ? "Project files imported"
          : `Imported ${ok} session${ok === 1 ? "" : "s"}`,
        ...(skipped > 0 || failed > 0
          ? {
              detail: [
                skipped > 0 ? `${skipped} already imported` : null,
                failed > 0 ? `${failed} failed` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            }
          : {}),
      });
      await load(false);
    } catch (err) {
      pushToast({
        kind: "err",
        title: "Import failed",
        detail: formatBridgeError(err),
      });
    } finally {
      setRunning(false);
    }
  };

  const selectedCount = Object.keys(selected).length;

  if (scanError && isDesktopOnlyError(scanError)) {
    return (
      <div>
        <SectionHeader
          title="Session import"
          description="Bring past Claude Code, Codex, and Pi sessions from this machine into Agena."
        />
        <DesktopOnlyState what="local session files (~/.claude/projects, ~/.codex/sessions, ~/.pi)" />
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        title="Session import"
        description="Bring past Claude Code, Codex, and Pi sessions from this machine into Agena. Re-running is safe — already-imported sessions are skipped."
        actions={
          <RefreshButton
            disabled={loading || running}
            onClick={() => void load(true)}
          >
            Rescan
          </RefreshButton>
        }
      />
      <div className="space-y-5">
        {projects !== null ? (
          <SourceCards projects={projects} imports={imports} />
        ) : null}

        {!daemonSupport ? (
          <div className="rounded-lg border border-warn/35 bg-warn/10 p-3 text-sm text-warn">
            The connected daemon doesn't support imports yet — update the
            deployment to enable importing. Scanning still works.
          </div>
        ) : null}

        <div>
          <GroupLabel>Projects with sessions</GroupLabel>
          {scanError ? (
            <InlineError error={scanError} onRetry={() => void load(false)} />
          ) : projects === null ? (
            <ListCard>
              <LoadingRow />
            </ListCard>
          ) : (
            <ListCard>
              {projects.length === 0 ? (
                <EmptyRow>
                  <span className="flex items-center gap-2">
                    <FolderInput className="size-4 text-fg-faint" />
                    No local Claude Code, Codex, or Pi sessions found.
                  </span>
                </EmptyRow>
              ) : (
                projects.map((p) => (
                  <ProjectRow
                    key={p.cwd}
                    project={p}
                    imports={imports}
                    selected={selected[p.cwd]}
                    copyFiles={copyFiles[p.cwd] ?? defaultCopyFiles(p)}
                    expanded={expanded.has(p.cwd)}
                    disabled={running}
                    onToggleProject={() => toggleProject(p)}
                    onToggleHarness={(h) => toggleHarness(p.cwd, h)}
                    onToggleCopyFiles={() =>
                      setCopyFiles((prev) => ({
                        ...prev,
                        [p.cwd]: !(prev[p.cwd] ?? defaultCopyFiles(p)),
                      }))
                    }
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
              )}
            </ListCard>
          )}
        </div>

        {running ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-fg-muted">
              <Spinner className="size-3.5" /> Importing sessions — converting
              and uploading…
            </div>
            <Progress />
          </div>
        ) : results ? (
          <div>
            <GroupLabel>Last run</GroupLabel>
            <ListCard className="max-h-56 overflow-y-auto">
              {results.length === 0 ? (
                <EmptyRow>Nothing to import (project files only).</EmptyRow>
              ) : (
                results.map((r) => <ResultRow key={r.sourcePath} r={r} />)
              )}
            </ListCard>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            disabled={!daemonSupport || running || selectedCount === 0}
            onClick={() => void run(true)}
          >
            Import project files only
          </Button>
          <Button
            variant="primary"
            disabled={!daemonSupport || running || selectedCount === 0}
            onClick={() => void run(false)}
          >
            {`Import selected${selectedCount > 0 ? ` (${selectedCount})` : ""}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
