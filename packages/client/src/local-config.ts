import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ulid } from "ulid";

export const DEFAULT_AGENA_URL = "http://127.0.0.1:7777";

export type AgenaLocalProfile = {
  workspaceId?: string;
  url: string;
  composeProject?: string;
  createdAt?: string;
};

export type AgenaLocalConfig = {
  v: 1;
  defaultProfile?: string;
  profiles: Record<string, AgenaLocalProfile>;
};

export type AgenaLocalCredentials = {
  v: 1;
  profiles: Record<string, { token: string }>;
};

export type LocalConfigOptions = {
  configDir?: string;
  env?: Partial<Record<string, string | undefined>>;
};

export type ResolveLocalClientOptions = LocalConfigOptions & {
  url?: string;
  token?: string;
  profile?: string;
};

export type ResolvedLocalClientConfig = {
  url: string;
  token?: string;
  clientId: string;
  profile?: string;
};

export function defaultAgenaConfigDir(
  env: Partial<Record<string, string | undefined>> = process.env,
): string {
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agena");
}

export function readAgenaLocalConfig(
  opts: LocalConfigOptions = {},
): AgenaLocalConfig {
  const parsed = readJson(configPath(opts, "config.json"));
  if (!parsed) return emptyConfig();
  const profiles = record(parsed.profiles);
  return {
    v: 1,
    ...(typeof parsed.defaultProfile === "string"
      ? { defaultProfile: parsed.defaultProfile }
      : {}),
    profiles: Object.fromEntries(
      Object.entries(profiles).flatMap(([name, raw]) => {
        const profile = record(raw);
        return typeof profile.url === "string"
          ? [[name, profileFromRecord(profile)]]
          : [];
      }),
    ),
  };
}

export function writeAgenaLocalConfig(
  config: AgenaLocalConfig,
  opts: LocalConfigOptions = {},
): void {
  writeJson(configPath(opts, "config.json"), config);
}

export function readAgenaLocalCredentials(
  opts: LocalConfigOptions = {},
): AgenaLocalCredentials {
  const parsed = readJson(configPath(opts, "credentials.json"));
  if (!parsed) return emptyCredentials();
  return {
    v: 1,
    profiles: Object.fromEntries(
      Object.entries(record(parsed.profiles)).flatMap(([name, raw]) => {
        const credential = record(raw);
        return typeof credential.token === "string"
          ? [[name, { token: credential.token }]]
          : [];
      }),
    ),
  };
}

export function writeAgenaLocalCredentials(
  credentials: AgenaLocalCredentials,
  opts: LocalConfigOptions = {},
): void {
  writeJson(configPath(opts, "credentials.json"), credentials, 0o600);
}

export function loadOrCreateClientId(opts: LocalConfigOptions = {}): string {
  const file = configPath(opts, "client-id");
  try {
    const id = readFileSync(file, "utf8").trim();
    if (id) return id;
  } catch {
    // fall through and mint one
  }
  const id = ulid();
  try {
    mkdirSync(configRoot(opts), { recursive: true });
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // unwritable config dir -> per-run id, matching the old CLI behavior
  }
  return id;
}

export function resolveLocalClientConfig(
  opts: ResolveLocalClientOptions = {},
): ResolvedLocalClientConfig {
  const env = opts.env ?? process.env;
  const config = readAgenaLocalConfig(opts);
  const credentials = readAgenaLocalCredentials(opts);
  const profile = opts.profile ?? config.defaultProfile;
  const localUrl = profile ? config.profiles[profile]?.url : undefined;
  const localToken = profile ? credentials.profiles[profile]?.token : undefined;
  const token = opts.token ?? env.AGENA_TOKEN ?? localToken;
  return {
    url: opts.url ?? env.AGENA_URL ?? localUrl ?? DEFAULT_AGENA_URL,
    ...(token ? { token } : {}),
    clientId: loadOrCreateClientId(opts),
    ...(profile ? { profile } : {}),
  };
}

function configRoot(opts: LocalConfigOptions): string {
  return opts.configDir ?? defaultAgenaConfigDir(opts.env);
}

function configPath(opts: LocalConfigOptions, file: string): string {
  return join(configRoot(opts), file);
}

function emptyConfig(): AgenaLocalConfig {
  return { v: 1, profiles: {} };
}

function emptyCredentials(): AgenaLocalCredentials {
  return { v: 1, profiles: {} };
}

function profileFromRecord(
  profile: Record<string, unknown>,
): AgenaLocalProfile {
  return {
    url: profile.url as string,
    ...(typeof profile.workspaceId === "string"
      ? { workspaceId: profile.workspaceId }
      : {}),
    ...(typeof profile.composeProject === "string"
      ? { composeProject: profile.composeProject }
      : {}),
    ...(typeof profile.createdAt === "string"
      ? { createdAt: profile.createdAt }
      : {}),
  };
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (mode !== undefined) chmodSync(path, mode);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
