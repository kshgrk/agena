import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

let privateScan = new Map();

const json = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
};

const cleanUrl = (value) => {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
};

const idFor = (identity) =>
  createHash("sha256").update(identity).digest("hex").slice(0, 20);

function envRef(value) {
  const match =
    typeof value === "string" && value.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/i);
  return match?.[1] ?? null;
}

function isLoopback(value) {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname;
    return (
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    );
  } catch {
    return false;
  }
}

function normalize(name, raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = typeof raw.url === "string" ? cleanUrl(raw.url) : null;
  const command = typeof raw.command === "string" ? raw.command : null;
  if (!url && !command) return null;
  const args = Array.isArray(raw.args)
    ? raw.args.filter((v) => typeof v === "string")
    : [];
  const transport = url ? (raw.type === "sse" ? "sse" : "http") : "stdio";
  const identity = url
    ? `remote:${url}`
    : `stdio:${JSON.stringify([command, ...args])}`;
  const env = raw.env && typeof raw.env === "object" ? raw.env : {};
  const headers =
    raw.headers && typeof raw.headers === "object"
      ? raw.headers
      : raw.http_headers && typeof raw.http_headers === "object"
        ? raw.http_headers
        : {};
  const tokenNames = new Set();
  for (const [key, value] of [
    ...Object.entries(env),
    ...Object.entries(headers),
  ]) {
    const ref = envRef(value);
    if (ref) tokenNames.add(ref);
    else if (typeof value === "string") tokenNames.add(key);
  }
  for (const key of raw.env_vars ?? [])
    if (typeof key === "string") tokenNames.add(key);
  if (typeof raw.bearer_token_env_var === "string")
    tokenNames.add(raw.bearer_token_env_var);
  for (const value of Object.values(raw.env_http_headers ?? {})) {
    if (typeof value === "string") tokenNames.add(value);
  }
  const authKind =
    tokenNames.size > 0
      ? "api_key"
      : url && !isLoopback(url)
        ? "oauth"
        : "none";
  const secretValues = Object.fromEntries(
    [...tokenNames].flatMap((key) => {
      const literal = env[key] ?? headers[key];
      const value =
        typeof literal === "string" && !envRef(literal)
          ? literal
          : process.env[key];
      return value ? [[key, value]] : [];
    }),
  );
  const authStatus =
    authKind === "oauth"
      ? "needs_authorization"
      : authKind === "api_key" &&
          Object.keys(secretValues).length < tokenNames.size
        ? "missing_secret"
        : "ready";
  const id = idFor(identity);
  const scrubbedEnv = Object.fromEntries(
    Object.entries(env).map(([key, value]) =>
      Object.hasOwn(secretValues, key) ? [key, `\${${key}}`] : [key, value],
    ),
  );
  const scrubbedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) =>
      Object.hasOwn(secretValues, key) ? [key, `\${${key}}`] : [key, value],
    ),
  );
  for (const [header, key] of Object.entries(raw.env_http_headers ?? {})) {
    if (typeof key === "string") scrubbedHeaders[header] = `\${${key}}`;
  }
  if (typeof raw.bearer_token_env_var === "string") {
    scrubbedHeaders.Authorization = `Bearer \${${raw.bearer_token_env_var}}`;
  }
  return {
    public: {
      id,
      identity,
      name,
      transport,
      target: url ?? [command, ...args].join(" "),
      authKind,
      authStatus,
    },
    request: {
      identity,
      name,
      transport,
      ...(url ? { url } : { command, args }),
      env: scrubbedEnv,
      headers: scrubbedHeaders,
      auth: {
        kind: authKind,
        ...(Object.keys(secretValues).length > 0 ? { secretValues } : {}),
      },
    },
  };
}

function claudeEntries(config) {
  const out = [];
  const add = (servers) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, raw] of Object.entries(servers)) out.push([name, raw]);
  };
  add(config?.mcpServers);
  for (const project of Object.values(config?.projects ?? {}))
    add(project?.mcpServers);
  return out;
}

async function claudePluginEntries(home) {
  const installed = await json(
    join(home, ".claude", "plugins", "installed_plugins.json"),
  );
  const out = [];
  for (const installs of Object.values(installed?.plugins ?? {})) {
    for (const install of installs) {
      if (typeof install?.installPath !== "string") continue;
      out.push(
        ...claudeEntries(await json(join(install.installPath, ".mcp.json"))),
      );
    }
  }
  return out;
}

function tomlValue(raw) {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    const quoted = text.match(/^'(.*)'$/s);
    return quoted ? quoted[1] : text;
  }
}

// Only the MCP table subset Codex documents; unrelated TOML is ignored.
function codexEntries(text) {
  const servers = new Map();
  let current = null;
  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.replace(/\s+#.*$/, "").trim();
    const section = line.match(/^\[mcp_servers\.([^.\]]+)(?:\.([^.\]]+))?\]$/);
    if (section) {
      const [, name, child] = section;
      const server = servers.get(name) ?? {};
      servers.set(name, server);
      if (child && !server[child]) server[child] = {};
      current = child ? server[child] : server;
      continue;
    }
    if (line.startsWith("[") && !section) {
      current = null;
      continue;
    }
    const pair = current && line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (pair) current[pair[1]] = tomlValue(pair[2]);
  }
  return [...servers.entries()];
}

export async function scanMcps({ refresh = false, cwd = process.cwd() } = {}) {
  if (!refresh && privateScan.size > 0) {
    return {
      mcps: [...privateScan.values()].map((x) => x.public),
      scannedAt: new Date().toISOString(),
    };
  }
  const home = homedir();
  const entries = claudeEntries(await json(join(home, ".claude.json")));
  entries.push(...claudeEntries(await json(resolve(cwd, ".mcp.json"))));
  entries.push(...(await claudePluginEntries(home)));
  for (const path of [
    join(home, ".codex", "config.toml"),
    resolve(cwd, ".codex", "config.toml"),
  ]) {
    try {
      entries.push(...codexEntries(await readFile(path, "utf8")));
    } catch {
      // absent config
    }
  }
  privateScan = new Map();
  for (const [name, raw] of entries) {
    const item = normalize(name, raw);
    if (!item) continue;
    const previous = privateScan.get(item.public.id);
    if (previous?.public.authStatus !== "ready")
      privateScan.set(item.public.id, item);
  }
  return {
    mcps: [...privateScan.values()].map((x) => x.public),
    scannedAt: new Date().toISOString(),
  };
}

export async function importMcps(plan, client) {
  const mcps = [];
  for (const id of plan?.ids ?? []) {
    const item = privateScan.get(id);
    if (!item) {
      mcps.push({
        id,
        status: "error",
        error: "MCP is no longer in the discovery index",
      });
      continue;
    }
    try {
      const result = await client.importMcp(item.request);
      const imported = result.mcp;
      const mcpId = imported.id;
      mcps.push({
        id,
        status:
          imported.status === "needs_auth" ? "needs_authorization" : "imported",
        ...(mcpId ? { mcpId } : {}),
      });
    } catch (error) {
      mcps.push({
        id,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { mcps };
}
