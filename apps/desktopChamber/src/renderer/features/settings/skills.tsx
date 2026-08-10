// Skills section: imported skills with update-check / per-skill Update /
// Update all, plus the local discovery/import flow (Electron-only scan).
// "Rescan" (this machine) and "Check updates" (daemon git ls-remote pass) are
// deliberately separate actions — mcp-skills.md §8.7.
import { BookOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  DiscoveredSkill,
  ImportedSkill,
  SkillImportRunResult,
} from "../../../shared/bridge.ts";
import { getBridge } from "../../lib/bridge.ts";
import { formatBridgeError, isDesktopOnlyError } from "../../lib/errors.ts";
import { pushToast } from "../../store/index.ts";
import { Badge, Button, Checkbox, Spinner, StatusDot } from "../../ui/index.ts";
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
import { skillImportState } from "./lib.ts";

function ImportedSkillRow({
  row,
  description,
  updating,
  onUpdate,
}: {
  row: ImportedSkill;
  /** Joined from the local scan when available (ImportedSkill carries none). */
  description: string | undefined;
  updating: boolean;
  onUpdate: () => void;
}) {
  return (
    <div className="p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-mono text-sm font-medium text-fg">
          {row.name}
        </span>
        <span
          className="font-mono text-2xs text-fg-faint"
          title={`content hash ${row.contentHash}`}
        >
          {row.contentHash.slice(0, 7)}
        </span>
        <span className="flex-1" />
        {row.status === "ready" ? (
          <span className="flex items-center gap-1.5 text-2xs text-fg-muted">
            <StatusDot className="bg-success" /> ready
          </span>
        ) : row.status === "update_available" ? (
          <span className="flex items-center gap-1.5 text-2xs text-info">
            <StatusDot className="bg-info" /> update available
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-2xs text-danger">
            <StatusDot className="bg-danger" /> error
          </span>
        )}
        {row.status === "update_available" ? (
          <Button size="sm" disabled={updating} onClick={onUpdate}>
            {updating ? <Spinner className="size-3" /> : "Update"}
          </Button>
        ) : null}
      </div>
      {description ? (
        <div
          className="mt-0.5 truncate text-xs text-fg-muted"
          title={description}
        >
          {description}
        </div>
      ) : null}
      {row.status === "error" && row.error ? (
        <div className="mt-1 text-xs text-danger">{row.error}</div>
      ) : null}
    </div>
  );
}

function DiscoveredSkillRow({
  skill,
  state,
  checked,
  disabled,
  updating,
  result,
  onToggle,
  onUpdate,
}: {
  skill: DiscoveredSkill;
  state: ReturnType<typeof skillImportState>;
  checked: boolean;
  disabled: boolean;
  updating: boolean;
  result: SkillImportRunResult["skills"][number] | undefined;
  onToggle: () => void;
  /** null when there is no daemon row to update (badge only). */
  onUpdate: (() => void) | null;
}) {
  return (
    <div className="p-3">
      <div className="flex items-center gap-2.5">
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={onToggle}
          aria-label={`Import ${skill.name}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate font-mono text-sm font-medium text-fg">
              {skill.name}
            </span>
            <span className="shrink-0 text-2xs text-fg-muted">
              {skill.fileCount} file{skill.fileCount === 1 ? "" : "s"}
            </span>
            {state === "imported" ? (
              <Badge tone="success">imported ✓</Badge>
            ) : state === "error" ? (
              <Badge tone="danger">error</Badge>
            ) : state === "update" && onUpdate === null ? (
              <Badge tone="info">update available</Badge>
            ) : null}
          </div>
          <div className="mt-0.5 truncate text-xs text-fg-muted">
            {skill.description ??
              `${skill.fileCount} file${skill.fileCount === 1 ? "" : "s"}`}
          </div>
        </div>
        {state === "update" && onUpdate ? (
          <Button size="sm" disabled={updating} onClick={onUpdate}>
            {updating ? <Spinner className="size-3" /> : "Update"}
          </Button>
        ) : null}
        {result ? (
          <Badge tone={result.status === "imported" ? "success" : "danger"}>
            {result.status}
          </Badge>
        ) : null}
      </div>
      {result?.error ? (
        <div className="mt-1 pl-[26px] text-xs text-danger">{result.error}</div>
      ) : null}
    </div>
  );
}

export function SkillsSection() {
  const [discovered, setDiscovered] = useState<DiscoveredSkill[] | null>(null);
  const [scanError, setScanError] = useState<unknown>(null);
  const [imported, setImported] = useState<ImportedSkill[] | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [updatingIds, setUpdatingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [results, setResults] = useState<
    ReadonlyMap<string, SkillImportRunResult["skills"][number]>
  >(new Map());

  const load = useCallback(async (rescan: boolean) => {
    setLoading(true);
    const [scan, status] = await Promise.allSettled([
      getBridge().skillImportScan({ refresh: rescan }),
      // plain list — the update-check pass is its own (slow) action
      getBridge().skillImportStatus(),
    ]);
    if (scan.status === "fulfilled") {
      setDiscovered(scan.value.skills);
      setScanError(null);
    } else {
      setScanError(scan.reason);
    }
    if (status.status === "fulfilled") {
      setImported(status.value.skills);
      setStatusError(null);
    } else {
      setStatusError(status.reason);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const checkUpdates = async () => {
    setCheckingUpdates(true);
    try {
      // refresh:true = POST /v1/skills/check-updates (git ls-remote per source)
      const { skills } = await getBridge().skillImportStatus({ refresh: true });
      setImported(skills);
      const updates = skills.filter(
        (s) => s.status === "update_available",
      ).length;
      pushToast({
        kind: updates > 0 ? "info" : "ok",
        title:
          updates > 0
            ? `${updates} skill update${updates === 1 ? "" : "s"} available`
            : "All skills are up to date",
      });
    } catch (err) {
      pushToast({
        kind: "err",
        title: "Update check failed",
        detail: formatBridgeError(err),
      });
    } finally {
      setCheckingUpdates(false);
    }
  };

  const update = async (skillId: string, name: string) => {
    setUpdatingIds((prev) => new Set(prev).add(skillId));
    try {
      await getBridge().skillUpdate(skillId);
      pushToast({ kind: "ok", title: `Updated ${name}` });
      await load(false);
    } catch (err) {
      pushToast({
        kind: "err",
        title: `Failed to update ${name}`,
        detail: formatBridgeError(err),
      });
    } finally {
      setUpdatingIds((prev) => {
        const next = new Set(prev);
        next.delete(skillId);
        return next;
      });
    }
  };

  const updateAll = async () => {
    const targets = (imported ?? []).filter(
      (s) => s.status === "update_available",
    );
    if (targets.length === 0) return;
    setUpdatingIds(new Set(targets.map((t) => t.id)));
    let failed = 0;
    for (const t of targets) {
      try {
        await getBridge().skillUpdate(t.id);
      } catch (err) {
        failed++;
        pushToast({
          kind: "err",
          title: `Failed to update ${t.name}`,
          detail: formatBridgeError(err),
        });
      }
    }
    setUpdatingIds(new Set());
    pushToast({
      kind: failed > 0 ? "warn" : "ok",
      title: `Updated ${targets.length - failed} of ${targets.length} skills`,
    });
    await load(false);
  };

  const run = async () => {
    if (selected.size === 0 || running) return;
    setRunning(true);
    try {
      const res = await getBridge().skillImportRun({ ids: [...selected] });
      setResults(new Map(res.skills.map((r) => [r.id, r])));
      setSelected(new Set());
      const failed = res.skills.filter((r) => r.status === "error").length;
      const ok = res.skills.length - failed;
      pushToast({
        kind: failed > 0 ? "warn" : "ok",
        title: `Imported ${ok} skill${ok === 1 ? "" : "s"}`,
        ...(failed > 0
          ? { detail: `${failed} failed — details are on each row` }
          : {}),
      });
      await load(false);
    } catch (err) {
      pushToast({
        kind: "err",
        title: "Skill import failed",
        detail: formatBridgeError(err),
      });
    } finally {
      setRunning(false);
    }
  };

  const importedRows = imported ?? [];
  const updatesAvailable = importedRows.filter(
    (s) => s.status === "update_available",
  ).length;
  // ImportedSkill carries no description — join it from the scan by identity.
  const descriptionByIdentity = new Map(
    (discovered ?? [])
      .filter((s) => s.description)
      .map((s) => [s.identity, s.description as string]),
  );
  const busy = loading || running || checkingUpdates;

  return (
    <div>
      <SectionHeader
        title="Skills"
        description="Reusable agent skills installed in the daemon. Skills with a Git source can be updated in place."
        actions={
          <>
            <Button
              variant="ghost"
              disabled={busy || importedRows.length === 0}
              onClick={() => void checkUpdates()}
            >
              {checkingUpdates ? (
                <>
                  <Spinner className="size-3.5" /> Checking…
                </>
              ) : (
                "Check updates"
              )}
            </Button>
            <RefreshButton disabled={busy} onClick={() => void load(true)}>
              Rescan
            </RefreshButton>
          </>
        }
      />
      <div className="space-y-5">
        <div>
          <div className="flex items-center justify-between">
            <GroupLabel>Imported</GroupLabel>
            {updatesAvailable > 1 ? (
              <Button
                size="sm"
                disabled={updatingIds.size > 0}
                onClick={() => void updateAll()}
              >
                Update all ({updatesAvailable})
              </Button>
            ) : null}
          </div>
          {statusError ? (
            <InlineError error={statusError} onRetry={() => void load(false)} />
          ) : imported === null ? (
            <ListCard>
              <LoadingRow />
            </ListCard>
          ) : (
            <ListCard>
              {importedRows.length === 0 ? (
                <EmptyRow>
                  No skills imported yet — pick some from the list below.
                </EmptyRow>
              ) : (
                importedRows.map((row) => (
                  <ImportedSkillRow
                    key={row.id}
                    row={row}
                    description={descriptionByIdentity.get(row.identity)}
                    updating={updatingIds.has(row.id)}
                    onUpdate={() => void update(row.id, row.name)}
                  />
                ))
              )}
            </ListCard>
          )}
        </div>

        <div>
          <GroupLabel>Found on this machine</GroupLabel>
          {scanError ? (
            isDesktopOnlyError(scanError) ? (
              <DesktopOnlyState what="skill folders (~/.claude/skills, ~/.codex/skills, ~/.agents/skills, plugins)" />
            ) : (
              <InlineError error={scanError} onRetry={() => void load(false)} />
            )
          ) : discovered === null ? (
            <ListCard>
              <LoadingRow />
            </ListCard>
          ) : (
            <>
              <ListCard>
                {discovered.length === 0 ? (
                  <EmptyRow>
                    <span className="flex items-center gap-2">
                      <BookOpen className="size-4 text-fg-faint" />
                      No local skills found — looked in ~/.claude/skills,
                      ~/.codex/skills, ~/.agents/skills, project skill folders,
                      and installed plugins.
                    </span>
                  </EmptyRow>
                ) : (
                  discovered.map((skill) => {
                    const state = skillImportState(skill, importedRows);
                    const record = importedRows.find(
                      (item) => item.identity === skill.identity,
                    );
                    return (
                      <DiscoveredSkillRow
                        key={skill.id}
                        skill={skill}
                        state={state}
                        checked={selected.has(skill.id)}
                        disabled={state === "imported" || running}
                        updating={record ? updatingIds.has(record.id) : false}
                        result={results.get(skill.id)}
                        onToggle={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(skill.id)) next.delete(skill.id);
                            else next.add(skill.id);
                            return next;
                          })
                        }
                        onUpdate={
                          record
                            ? () => void update(record.id, record.name)
                            : null
                        }
                      />
                    );
                  })
                )}
              </ListCard>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-xs text-fg-muted">
                  Skill folders, scripts, references, and assets are copied
                  together (≤10 MiB per skill).
                </span>
                <Button
                  variant="primary"
                  disabled={running || selected.size === 0}
                  onClick={() => void run()}
                >
                  {running ? (
                    <>
                      <Spinner className="size-3.5" /> Importing…
                    </>
                  ) : (
                    `Import selected${selected.size > 0 ? ` (${selected.size})` : ""}`
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
