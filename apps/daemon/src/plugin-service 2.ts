import type { PluginSummary } from "@agena/protocol";
import type { McpService } from "./mcp-service.ts";

interface PackageOwner {
  list(): Array<{
    source: string;
    enabled: boolean;
    installed?: boolean;
  }>;
  install(source: string): Promise<void>;
  remove(source: string): Promise<void>;
  setEnabled(source: string, enabled: boolean): Promise<void>;
  update(source: string, replacement: string): Promise<void>;
}

type PluginDefinition = Omit<
  PluginSummary,
  "status" | "enabled" | "resourceId" | "error"
> &
  (
    | { source: "mcp"; url: string; transport?: "http" | "sse" }
    | { source: "package"; packageSource: string }
  );

const CATALOG: readonly PluginDefinition[] = [
  remote(
    "github",
    "GitHub MCP",
    "GitHub",
    "https://api.githubcopilot.com/mcp/",
    "Model-facing repository, issue, pull-request, and code-search tools. Git and gh authentication are configured separately.",
    ["repositories", "issues", "pull requests", "code search"],
  ),
  remote(
    "vercel",
    "Vercel",
    "Vercel",
    "https://mcp.vercel.com",
    "Inspect projects, deployments, logs, and domains.",
    ["projects", "deployments", "logs"],
  ),
  remote(
    "sentry",
    "Sentry",
    "Sentry",
    "https://mcp.sentry.dev/mcp",
    "Investigate errors, issues, traces, and releases.",
    ["issues", "traces", "releases"],
  ),
  remote(
    "linear",
    "Linear",
    "Linear",
    "https://mcp.linear.app/mcp",
    "Read and manage issues, projects, and team workflows.",
    ["issues", "projects", "teams"],
  ),
  remote(
    "notion",
    "Notion",
    "Notion",
    "https://mcp.notion.com/mcp",
    "Search and update pages, databases, and workspace knowledge.",
    ["pages", "databases", "search"],
  ),
  remote(
    "cloudflare",
    "Cloudflare",
    "Cloudflare",
    "https://bindings.mcp.cloudflare.com/mcp",
    "Work with Workers, storage, observability, and account resources.",
    ["workers", "storage", "observability"],
  ),
  remote(
    "atlassian",
    "Atlassian",
    "Atlassian",
    "https://mcp.atlassian.com/v1/sse",
    "Use Jira issues and Confluence knowledge from Agena.",
    ["jira", "confluence", "search"],
    "sse",
  ),
  remote(
    "figma",
    "Figma",
    "Figma",
    "https://mcp.figma.com/mcp",
    "Inspect design files, components, and design context.",
    ["design files", "components", "design context"],
  ),
  remote(
    "canva",
    "Canva",
    "Canva",
    "https://mcp.canva.com/mcp",
    "Search, inspect, and create Canva designs.",
    ["designs", "assets", "search"],
  ),
  remote(
    "stripe",
    "Stripe",
    "Stripe",
    "https://mcp.stripe.com",
    "Inspect and manage Stripe developer resources.",
    ["customers", "payments", "subscriptions"],
  ),
  extension(
    "loop-guard",
    "Loop Guard",
    "pi-loop-guard",
    "1.0.4",
    "Stops repetitive tool-call loops before they waste time and tokens.",
    ["loop detection"],
  ),
  extension(
    "retry",
    "Retry",
    "@narumitw/pi-retry",
    "0.14.0",
    "Adds controlled retry behavior for transient model failures.",
    ["retry"],
  ),
  extension(
    "lsp",
    "Language Server",
    "@narumitw/pi-lsp",
    "0.14.0",
    "Adds language-server diagnostics and code intelligence.",
    ["diagnostics", "code intelligence"],
  ),
] as const;

export class PluginService {
  readonly #mcps: McpService | null;
  readonly #packages: PackageOwner | null;

  constructor(mcps: McpService | null, packages: PackageOwner | null) {
    this.#mcps = mcps;
    this.#packages = packages;
  }

  list(): PluginSummary[] {
    return CATALOG.map((definition) => this.#summary(definition));
  }

  async install(id: string): Promise<PluginSummary> {
    const definition = required(id);
    if (definition.source === "package") {
      if (!this.#packages)
        throw new Error("Pi packages require the Pi runtime");
      await this.#packages.install(definition.packageSource);
    } else {
      if (!this.#mcps) throw new Error("MCP plugins require SQLite");
      const existing = this.#mcps.findByIdentity(identity(definition.url));
      if (existing) {
        if (!existing.enabled) await this.#mcps.setEnabled(existing.id, true);
      } else {
        await this.#mcps.import({
          identity: identity(definition.url),
          name: definition.id,
          transport: definition.transport ?? "http",
          url: definition.url,
          auth: { kind: definition.authKind },
        });
      }
    }
    return this.#summary(definition);
  }

  async update(id: string): Promise<PluginSummary> {
    const definition = required(id);
    if (definition.source === "package") {
      if (!this.#packages)
        throw new Error("Pi packages require the Pi runtime");
      const current = this.#packageRecord(definition);
      if (!current) return this.install(id);
      await this.#packages.update(current.source, definition.packageSource);
    }
    return this.#summary(definition);
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginSummary> {
    const definition = required(id);
    if (definition.source === "package") {
      if (!this.#packages)
        throw new Error("Pi packages require the Pi runtime");
      await this.#packages.setEnabled(definition.packageSource, enabled);
    } else {
      const mcp = this.#mcps?.findByIdentity(identity(definition.url));
      if (!mcp || !this.#mcps) throw new Error("Plugin is not installed");
      await this.#mcps.setEnabled(mcp.id, enabled);
    }
    return this.#summary(definition);
  }

  async remove(id: string): Promise<PluginSummary> {
    const definition = required(id);
    if (definition.source === "package") {
      if (!this.#packages)
        throw new Error("Pi packages require the Pi runtime");
      await this.#packages.remove(definition.packageSource);
    } else {
      const mcp = this.#mcps?.findByIdentity(identity(definition.url));
      if (mcp && this.#mcps) await this.#mcps.remove(mcp.id);
    }
    return this.#summary(definition);
  }

  #summary(definition: PluginDefinition): PluginSummary {
    const base = {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      publisher: definition.publisher,
      kind: definition.kind,
      category: definition.category,
      authKind: definition.authKind,
      featured: definition.featured,
      capabilities: [...definition.capabilities],
      ...(definition.version ? { version: definition.version } : {}),
      ...(definition.homepage ? { homepage: definition.homepage } : {}),
    };
    if (definition.source === "package") {
      const record = this.#packageRecord(definition);
      return {
        ...base,
        status: !record
          ? "available"
          : record.installed === false
            ? "error"
            : record.enabled
              ? "installed"
              : "disabled",
        enabled: record?.enabled ?? false,
        ...(record ? { resourceId: record.source } : {}),
        ...(record?.installed === false
          ? { error: "Installed package files are missing" }
          : {}),
      };
    }
    const mcp = this.#mcps?.findByIdentity(identity(definition.url));
    if (!mcp) return { ...base, status: "available", enabled: false };
    return {
      ...base,
      authKind: mcp.authKind,
      status: !mcp.enabled
        ? "disabled"
        : mcp.status === "connected"
          ? "ready"
          : mcp.status === "needs_auth"
            ? "needs_auth"
            : mcp.status === "error"
              ? "error"
              : "installed",
      enabled: mcp.enabled,
      resourceId: mcp.id,
    };
  }

  #packageRecord(definition: Extract<PluginDefinition, { source: "package" }>) {
    const name = definition.packageSource.slice(
      0,
      definition.packageSource.lastIndexOf("@"),
    );
    return this.#packages?.list().find((record) => {
      const recordName = record.source.slice(0, record.source.lastIndexOf("@"));
      return recordName === name;
    });
  }
}

function required(id: string): PluginDefinition {
  const definition = CATALOG.find((plugin) => plugin.id === id);
  if (!definition) throw new Error("Plugin not found");
  return definition;
}

function identity(url: string): string {
  return `remote:${url.replace(/\/$/, "")}`;
}

function remote(
  id: string,
  name: string,
  publisher: string,
  url: string,
  description: string,
  capabilities: string[],
  transport: "http" | "sse" = "http",
): PluginDefinition {
  return {
    id,
    name,
    publisher,
    url,
    description,
    capabilities,
    transport,
    source: "mcp",
    kind: "integration",
    category: "productivity",
    authKind: "oauth",
    featured: ["github", "vercel", "linear", "notion"].includes(id),
  };
}

function extension(
  id: string,
  name: string,
  packageName: string,
  version: string,
  description: string,
  capabilities: string[],
): PluginDefinition {
  return {
    id,
    name,
    publisher: packageName,
    packageSource: `npm:${packageName}@${version}`,
    version,
    description,
    capabilities,
    source: "package",
    kind: "extension",
    category: "developer_tools",
    authKind: "none",
    featured: false,
  };
}
