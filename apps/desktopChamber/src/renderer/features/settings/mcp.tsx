// MCP servers section: imported registry with live status chips + the local
// discovery/import flow (Electron-only scan). Improvements over the old modal
// (mcp-skills.md §8): OAuth stays visible ("waiting for browser…" + polling
// until the row flips), per-row run results persist, imported rows show their
// transport target decoded from the identity.
import { KeyRound, ServerOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DiscoveredMcp,
  ImportedMcp,
  McpImportRunResult,
} from "../../../shared/bridge.ts";
import { getBridge } from "../../lib/bridge.ts";
import { formatBridgeError, isDesktopOnlyError } from "../../lib/errors.ts";
import { pushToast } from "../../store/index.ts";
import {
  Badge,
  type BadgeTone,
  Button,
  Checkbox,
  Spinner,
  StatusDot,
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
import { mcpImportState, mcpTargetFromIdentity } from "./lib.ts";

const AUTH_POLL_MS = 2500;
const AUTH_POLL_TIMEOUT_MS = 180_000;

const IMPORTED_CHIP: Record<
  ImportedMcp["status"],
  { dot: string; label: string; tone: "muted" | "warn" | "danger" }
> = {
  // design.md §13: ready/imported → success dot; needs_authorization → warn;
  // error → danger with the message underneath.
  imported: {
    dot: "bg-success",
    label: "imported · not verified",
    tone: "muted",
  },
  ready: { dot: "bg-success", label: "ready · connects on use", tone: "muted" },
  needs_authorization: {
    dot: "bg-warn",
    label: "needs authorization",
    tone: "warn",
  },
  error: { dot: "bg-danger", label: "error", tone: "danger" },
};

const RESULT_TONE: Record<
  McpImportRunResult["mcps"][number]["status"],
  BadgeTone
> = {
  imported: "success",
  needs_authorization: "warn",
  error: "danger",
};

function ImportedMcpRow({
  row,
  waiting,
  onAuthorize,
}: {
  row: ImportedMcp;
  waiting: boolean;
  onAuthorize: () => void;
}) {
  const chip = IMPORTED_CHIP[row.status];
  const target = mcpTargetFromIdentity(row.identity);
  return (
    <div className="p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-fg">
          {row.name}
        </span>
        <span className="flex-1" />
        {waiting ? (
          <span className="flex items-center gap-1.5 text-xs text-warn">
            <Spinner className="size-3.5" /> waiting for browser…
          </span>
        ) : (
          <span
            className={
              chip.tone === "warn"
                ? "flex items-center gap-1.5 text-2xs text-warn"
                : chip.tone === "danger"
                  ? "flex items-center gap-1.5 text-2xs text-danger"
                  : "flex items-center gap-1.5 text-2xs text-fg-muted"
            }
          >
            <StatusDot className={chip.dot} />
            {chip.label}
          </span>
        )}
        {row.status === "needs_authorization" && !waiting ? (
          <Button size="sm" variant="primary" onClick={onAuthorize}>
            Authorize
          </Button>
        ) : null}
      </div>
      {target ? (
        <div
          className="mt-0.5 truncate font-mono text-xs text-fg-muted"
          title={target}
        >
          {target}
        </div>
      ) : null}
      {row.status === "error" && row.error ? (
        <div className="mt-1 text-xs text-danger">{row.error}</div>
      ) : null}
    </div>
  );
}

function DiscoveredMcpRow({
  mcp,
  state,
  checked,
  disabled,
  result,
  onToggle,
}: {
  mcp: DiscoveredMcp;
  state: ReturnType<typeof mcpImportState>;
  checked: boolean;
  disabled: boolean;
  result: McpImportRunResult["mcps"][number] | undefined;
  onToggle: () => void;
}) {
  return (
    <div className="p-3">
      <div className="flex items-center gap-2.5">
        <Checkbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={onToggle}
          aria-label={`Import ${mcp.name}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-fg">
              {mcp.name}
            </span>
            <Badge tone="neutral">{mcp.transport}</Badge>
            {state === "error" ? (
              <Badge tone="danger">imported · error</Badge>
            ) : state !== "not_imported" ? (
              <Badge tone="success">already imported</Badge>
            ) : mcp.authStatus === "missing_secret" ? (
              <Badge tone="warn">
                <KeyRound className="size-3" /> missing API key
              </Badge>
            ) : mcp.authKind === "oauth" ? (
              <Badge tone="info">OAuth</Badge>
            ) : mcp.authKind === "api_key" ? (
              <Badge tone="neutral">API key</Badge>
            ) : null}
          </div>
          <div
            className="mt-0.5 truncate font-mono text-sm text-fg-muted"
            title={mcp.target}
          >
            {mcp.transport === "stdio" ? "$ " : ""}
            {mcp.target}
          </div>
          {mcp.authStatus === "missing_secret" ? (
            <div className="mt-1 text-xs text-fg-muted">
              The key couldn't be resolved from this machine's config or
              environment — set it in the source config, then rescan.
            </div>
          ) : null}
        </div>
        {result ? (
          <Badge tone={RESULT_TONE[result.status]}>
            {result.status === "needs_authorization"
              ? "imported · authorize below"
              : result.status}
          </Badge>
        ) : null}
      </div>
      {result?.error ? (
        <div className="mt-1 pl-[26px] text-xs text-danger">{result.error}</div>
      ) : null}
    </div>
  );
}

export function McpSection() {
  const [discovered, setDiscovered] = useState<DiscoveredMcp[] | null>(null);
  const [scanError, setScanError] = useState<unknown>(null);
  const [imported, setImported] = useState<ImportedMcp[] | null>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<
    ReadonlyMap<string, McpImportRunResult["mcps"][number]>
  >(new Map());
  /** Daemon MCP ids with an OAuth flow open in the system browser. */
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    const [scan, status] = await Promise.allSettled([
      getBridge().mcpImportScan({ refresh }),
      getBridge().mcpImportStatus(),
    ]);
    if (scan.status === "fulfilled") {
      setDiscovered(scan.value.mcps);
      setScanError(null);
    } else {
      setScanError(scan.reason);
    }
    if (status.status === "fulfilled") {
      setImported(status.value.mcps);
      setStatusError(null);
    } else {
      setStatusError(status.reason);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // Poll mcpImportStatus while any OAuth authorization is open in the browser,
  // so the row flips to "ready" without the user reopening settings (§8.2).
  const anyWaiting = waiting.size > 0;
  useEffect(() => {
    if (!anyWaiting) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      void (async () => {
        try {
          const { mcps } = await getBridge().mcpImportStatus();
          setImported(mcps);
          const still = new Set(waitingRef.current);
          for (const id of waitingRef.current) {
            const row = mcps.find((m) => m.id === id);
            if (row && row.status === "needs_authorization") continue;
            still.delete(id);
            if (row?.status === "ready" || row?.status === "imported") {
              pushToast({ kind: "ok", title: `${row.name} authorized` });
            } else if (row?.status === "error") {
              pushToast({
                kind: "err",
                title: `${row.name} authorization failed`,
                ...(row.error ? { detail: row.error } : {}),
              });
            }
          }
          if (Date.now() - startedAt > AUTH_POLL_TIMEOUT_MS) still.clear();
          if (still.size !== waitingRef.current.size) setWaiting(still);
        } catch {
          // transient poll failure — keep polling
        }
      })();
    }, AUTH_POLL_MS);
    return () => clearInterval(timer);
  }, [anyWaiting]);

  const authorize = async (row: ImportedMcp) => {
    setWaiting((prev) => new Set(prev).add(row.id));
    try {
      await getBridge().mcpAuthStart(row.id);
      pushToast({
        kind: "info",
        title: "Authorization opened in your browser",
        detail: `Finish signing in to ${row.name}; this list updates automatically.`,
      });
    } catch (err) {
      setWaiting((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
      pushToast({
        kind: "err",
        title: `Failed to start authorization for ${row.name}`,
        detail: formatBridgeError(err),
      });
    }
  };

  const run = async () => {
    if (selected.size === 0 || running) return;
    setRunning(true);
    try {
      const res = await getBridge().mcpImportRun({ ids: [...selected] });
      setResults(new Map(res.mcps.map((r) => [r.id, r])));
      setSelected(new Set());
      const failed = res.mcps.filter((r) => r.status === "error").length;
      const ok = res.mcps.length - failed;
      pushToast({
        kind: failed > 0 ? "warn" : "ok",
        title: `Imported ${ok} MCP server${ok === 1 ? "" : "s"}`,
        ...(failed > 0
          ? { detail: `${failed} failed — details are on each row` }
          : {}),
      });
      await load(false);
    } catch (err) {
      pushToast({
        kind: "err",
        title: "MCP import failed",
        detail: formatBridgeError(err),
      });
    } finally {
      setRunning(false);
    }
  };

  const importedRows = imported ?? [];
  const busy = loading || running;

  return (
    <div>
      <SectionHeader
        title="MCP servers"
        description="Model Context Protocol servers the daemon can hand to the agent. Servers connect lazily on first use."
        actions={
          <RefreshButton disabled={busy} onClick={() => void load(true)}>
            Rescan
          </RefreshButton>
        }
      />
      <div className="space-y-5">
        <div>
          <GroupLabel>Imported</GroupLabel>
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
                  No MCP servers imported yet — pick some from the list below.
                </EmptyRow>
              ) : (
                importedRows.map((row) => (
                  <ImportedMcpRow
                    key={row.id}
                    row={row}
                    waiting={waiting.has(row.id)}
                    onAuthorize={() => void authorize(row)}
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
              <DesktopOnlyState what="MCP configs (~/.claude.json, .mcp.json, codex config)" />
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
                      <ServerOff className="size-4 text-fg-faint" />
                      No local MCP servers found — looked in ~/.claude.json,
                      project .mcp.json files, Claude plugins, and
                      ~/.codex/config.toml.
                    </span>
                  </EmptyRow>
                ) : (
                  discovered.map((mcp) => {
                    const state = mcpImportState(mcp, importedRows);
                    return (
                      <DiscoveredMcpRow
                        key={mcp.id}
                        mcp={mcp}
                        state={state}
                        checked={selected.has(mcp.id)}
                        disabled={
                          state !== "not_imported" ||
                          mcp.authStatus === "missing_secret" ||
                          running
                        }
                        result={results.get(mcp.id)}
                        onToggle={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(mcp.id)) next.delete(mcp.id);
                            else next.add(mcp.id);
                            return next;
                          })
                        }
                      />
                    );
                  })
                )}
              </ListCard>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-xs text-fg-muted">
                  OAuth servers authorize Agena separately after import. API
                  keys are copied into the daemon's encrypted store.
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
