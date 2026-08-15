export type PluginListItem = {
  name: string;
  description: string;
  kind: "integration" | "extension" | "skill" | "mcp";
  publisher: string;
};

export function pluginInstallWarning(plugin: {
  kind: PluginListItem["kind"];
  name: string;
}): string | null {
  return plugin.kind === "extension"
    ? `${plugin.name} runs code inside the Agena daemon and can access its files, network, and processes. Only install it if you trust the publisher.`
    : null;
}

export function pluginSettingsSection(plugin: {
  kind: PluginListItem["kind"];
  resourceId?: string | undefined;
}): "mcp" | "skills" | null {
  if (plugin.kind === "skill") return "skills";
  return plugin.kind === "mcp" ||
    (plugin.kind === "integration" && plugin.resourceId)
    ? "mcp"
    : null;
}

export function filterPlugins<T extends PluginListItem>(
  plugins: readonly T[],
  kind: PluginListItem["kind"] | "all",
  query: string,
): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return plugins.filter((plugin) => {
    if (kind !== "all" && plugin.kind !== kind) return false;
    const text =
      `${plugin.name} ${plugin.description} ${plugin.kind} ${plugin.publisher}`.toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
