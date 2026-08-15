import type { PluginSummary } from "@agena/protocol";
import { Package, Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import { formatBridgeError } from "../../lib/errors.ts";
import { pushToast } from "../../store/index.ts";
import { Badge, Button, Input, Spinner, Switch } from "../../ui/index.ts";
import {
  EmptyRow,
  InlineError,
  ListCard,
  LoadingRow,
  RefreshButton,
  SectionHeader,
  useLoad,
} from "./common.tsx";
import {
  filterPlugins,
  pluginInstallWarning,
  pluginSettingsSection,
} from "./plugins-lib.ts";
import { openSettings } from "./store.ts";

type View = "discover" | "installed";
type Kind = PluginSummary["kind"] | "all";

const KINDS: ReadonlyArray<{ id: Kind; label: string }> = [
  { id: "all", label: "All" },
  { id: "integration", label: "Integrations" },
  { id: "extension", label: "Extensions" },
  { id: "skill", label: "Skills" },
  { id: "mcp", label: "MCP" },
];

const INSTALLED = new Set<PluginSummary["status"]>([
  "installed",
  "needs_auth",
  "ready",
  "error",
  "update_available",
  "disabled",
]);

const STATUS_TONE: Record<
  PluginSummary["status"],
  "neutral" | "success" | "warn" | "danger" | "info"
> = {
  available: "neutral",
  installed: "success",
  needs_auth: "warn",
  ready: "success",
  error: "danger",
  update_available: "info",
  disabled: "neutral",
};

function statusLabel(status: PluginSummary["status"]): string {
  return status.replaceAll("_", " ");
}

export function PluginsSection() {
  const loadPlugins = useCallback(() => getBridge().listPlugins(), []);
  const loaded = useLoad(loadPlugins);
  const [view, setView] = useState<View>("discover");
  const [kind, setKind] = useState<Kind>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const plugins = useMemo(() => {
    const byView = (loaded.data ?? []).filter((plugin) =>
      view === "installed" ? INSTALLED.has(plugin.status) : true,
    );
    return filterPlugins(byView, kind, query);
  }, [kind, loaded.data, query, view]);

  const run = async (
    id: string,
    action: () => Promise<unknown>,
    done: string,
  ) => {
    setBusy(id);
    try {
      await action();
      await loaded.reload();
      pushToast({ kind: "ok", title: done });
    } catch (error) {
      pushToast({
        kind: "err",
        title: "Plugin action failed",
        detail: formatBridgeError(error),
      });
    } finally {
      setBusy(null);
    }
  };

  const action = (plugin: PluginSummary) => {
    const waiting = busy === plugin.id;
    if (waiting) return <Spinner className="size-4" />;
    if (plugin.status === "available") {
      const install = () => {
        const warning = pluginInstallWarning(plugin);
        if (warning && !window.confirm(warning)) return;
        void run(
          plugin.id,
          () => getBridge().installPlugin(plugin.id),
          `${plugin.name} installed`,
        );
      };
      return (
        <Button variant="primary" size="sm" onClick={install}>
          Install
        </Button>
      );
    }
    if (plugin.status === "update_available") {
      return (
        <Button
          variant="primary"
          size="sm"
          onClick={() =>
            void run(
              plugin.id,
              () => getBridge().updatePlugin(plugin.id),
              `${plugin.name} updated`,
            )
          }
        >
          Update
        </Button>
      );
    }
    if (plugin.status === "needs_auth" && plugin.resourceId) {
      return (
        <Button variant="primary" size="sm" onClick={() => openSettings("mcp")}>
          Connect
        </Button>
      );
    }
    if (plugin.status === "needs_auth") {
      return (
        <Button
          size="sm"
          disabled
          title="Connection setup for this integration is not available yet"
        >
          Setup unavailable
        </Button>
      );
    }
    return null;
  };

  return (
    <div>
      <SectionHeader
        title="Plugins"
        description="Add curated integrations, extensions, skills, and MCP servers that Pi can use."
        actions={
          <RefreshButton
            disabled={loaded.loading}
            onClick={() => void loaded.reload(true)}
          >
            Refresh
          </RefreshButton>
        }
      />

      <div className="mb-3 flex items-center gap-1 border-b border-border-subtle">
        {(["discover", "installed"] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setView(id)}
            className={`border-b-2 px-3 py-2 text-sm capitalize ${view === id ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}
          >
            {id}
          </button>
        ))}
      </div>

      <div className="mb-3 flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-muted" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search plugins…"
            aria-label="Search plugins"
            className="pl-7"
          />
        </div>
        <div className="flex items-center rounded-md border border-border bg-raised p-0.5">
          {KINDS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setKind(id)}
              className={`rounded px-2 py-1 text-2xs ${kind === id ? "bg-surface text-fg" : "text-fg-muted hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loaded.error ? (
        <InlineError
          error={loaded.error}
          onRetry={() => void loaded.reload()}
        />
      ) : null}
      {loaded.loading && loaded.data === null ? (
        <LoadingRow />
      ) : (
        <ListCard>
          {plugins.length === 0 ? (
            <EmptyRow>
              {view === "installed"
                ? "No installed plugins match these filters."
                : "No plugins match these filters."}
            </EmptyRow>
          ) : (
            plugins.map((plugin) => {
              const settingsSection = pluginSettingsSection(plugin);
              return (
                <div key={plugin.id} className="p-3">
                  <div className="flex items-start gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-raised text-fg-muted">
                      <Package className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-fg">
                          {plugin.name}
                        </span>
                        {plugin.featured ? (
                          <Badge tone="info">featured</Badge>
                        ) : null}
                        <Badge tone={STATUS_TONE[plugin.status]}>
                          {statusLabel(plugin.status)}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-fg-muted">
                        {plugin.description}
                      </p>
                      {plugin.id === "github" ? (
                        <p className="mt-1 text-2xs text-warn">
                          MCP tools only — this does not authorize Git or the gh
                          CLI for fetch, pull, or push.
                        </p>
                      ) : null}
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-fg-faint">
                        <span>{plugin.publisher}</span>
                        <span>·</span>
                        <span>{plugin.kind}</span>
                        {plugin.authKind !== "none" ? (
                          <>
                            <span>·</span>
                            <span>
                              {plugin.authKind === "oauth"
                                ? "OAuth"
                                : "API key"}
                            </span>
                          </>
                        ) : null}
                        {plugin.version ? (
                          <>
                            <span>·</span>
                            <span>v{plugin.version}</span>
                          </>
                        ) : null}
                      </div>
                      {plugin.capabilities.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {plugin.capabilities.map((capability) => (
                            <Badge key={capability} tone="neutral">
                              {capability}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                      {plugin.error ? (
                        <p className="mt-1 text-xs text-danger">
                          {plugin.error}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {action(plugin)}
                      {plugin.status !== "available" ? (
                        <>
                          {settingsSection && plugin.status !== "needs_auth" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openSettings(settingsSection)}
                            >
                              Configure
                            </Button>
                          ) : null}
                          <Switch
                            checked={plugin.enabled}
                            disabled={busy === plugin.id}
                            aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
                            onCheckedChange={(enabled) =>
                              void run(
                                plugin.id,
                                () =>
                                  getBridge().setPluginEnabled(
                                    plugin.id,
                                    enabled,
                                  ),
                                `${plugin.name} ${enabled ? "enabled" : "disabled"}`,
                              )
                            }
                          />
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            disabled={busy === plugin.id}
                            onClick={() =>
                              void run(
                                plugin.id,
                                () => getBridge().removePlugin(plugin.id),
                                `${plugin.name} removed`,
                              )
                            }
                          >
                            Remove
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </ListCard>
      )}
    </div>
  );
}
