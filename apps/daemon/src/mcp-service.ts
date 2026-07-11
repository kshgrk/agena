import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImportMcpRequest, McpSummary } from "@agena/protocol";
import {
  completeAuthFromInput,
  type PiMcpServerEntry,
  startAuth,
} from "@agena/runtime-pi";
import type {
  McpRegistryRecord,
  SqliteEventStore,
} from "@agena/storage-sqlite";

type SecretFile = Record<string, string>;

export class McpService {
  readonly #store: SqliteEventStore;
  readonly #piConfigPath: string;
  readonly #secretPath: string;
  readonly #secretKeyPath: string;

  constructor(store: SqliteEventStore, stateDir: string) {
    this.#store = store;
    this.#piConfigPath = join(stateDir, "pi", "mcp.json");
    this.#secretPath = join(stateDir, "config", "mcp-secrets.enc");
    this.#secretKeyPath = join(stateDir, "config", "mcp-secrets.key");
    process.env.MCP_OAUTH_DIR = join(stateDir, "config", "mcp-oauth");
  }

  async initialize(): Promise<void> {
    const secrets = await this.#readSecrets();
    for (const [name, value] of Object.entries(secrets))
      process.env[name] = value;
    await this.#writeAdapterConfig();
  }

  list(): McpSummary[] {
    return this.#store.listMcps().map(toSummary);
  }

  async import(input: ImportMcpRequest): Promise<McpSummary> {
    const secrets = await this.#readSecrets();
    const env = { ...(input.env ?? {}) };
    const headers = { ...(input.headers ?? {}) };
    for (const [key, value] of Object.entries(input.auth.secretValues ?? {})) {
      const envName = secretEnvName(input.name, key);
      secrets[envName] = value;
      process.env[envName] = value;
      replaceSecretReference(env, key, value, envName);
      replaceSecretReference(headers, key, value, envName);
      if (!(key in env) && !(key in headers)) env[key] = `\${${envName}}`;
    }
    await this.#writeSecrets(secrets);
    const record = this.#store.upsertMcp({
      identity: input.identity,
      name: input.name,
      transport: input.transport,
      ...(input.command ? { command: input.command } : {}),
      ...(input.args ? { args: input.args } : {}),
      ...(input.url ? { url: input.url } : {}),
      authKind: input.auth.kind,
      status: input.auth.kind === "oauth" ? "needs_auth" : "imported",
      ...(Object.keys(env).length ? { env } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    await this.#writeAdapterConfig();
    return toSummary(record);
  }

  async startOAuth(id: string): Promise<string> {
    const mcp = this.#required(id);
    if (mcp.authKind !== "oauth" || !mcp.url)
      throw new Error("MCP does not use OAuth");
    const result = await startAuth(mcp.name, mcp.url, toServerEntry(mcp));
    if (!result.authorizationUrl) {
      this.#store.setMcpStatus(id, "connected");
    }
    return result.authorizationUrl;
  }

  async completeOAuth(id: string, redirectUrl: string): Promise<McpSummary> {
    const mcp = this.#required(id);
    await completeAuthFromInput(mcp.name, redirectUrl);
    const updated = this.#store.setMcpStatus(id, "connected");
    if (!updated) throw new Error("MCP not found");
    return toSummary(updated);
  }

  #required(id: string): McpRegistryRecord {
    const mcp = this.#store.getMcp(id);
    if (!mcp) throw new Error("MCP not found");
    return mcp;
  }

  async #readSecrets(): Promise<SecretFile> {
    try {
      const envelope = JSON.parse(await readFile(this.#secretPath, "utf8")) as {
        iv: string;
        tag: string;
        ciphertext: string;
      };
      const key = await this.#secretKey();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plaintext) as SecretFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async #writeSecrets(secrets: SecretFile): Promise<void> {
    await mkdir(join(this.#secretPath, ".."), { recursive: true, mode: 0o700 });
    const key = await this.#secretKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(secrets), "utf8"),
      cipher.final(),
    ]);
    const envelope = JSON.stringify({
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
    const tmp = `${this.#secretPath}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${envelope}\n`, { mode: 0o600 });
    await rename(tmp, this.#secretPath);
    await chmod(this.#secretPath, 0o600);
  }

  async #secretKey(): Promise<Buffer> {
    try {
      const key = await readFile(this.#secretKeyPath);
      if (key.length !== 32) throw new Error("invalid MCP secret key");
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(join(this.#secretKeyPath, ".."), {
        recursive: true,
        mode: 0o700,
      });
      const key = randomBytes(32);
      try {
        await writeFile(this.#secretKeyPath, key, { mode: 0o600, flag: "wx" });
        return key;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST")
          throw writeError;
        return this.#secretKey();
      }
    }
  }

  async #writeAdapterConfig(): Promise<void> {
    const mcpServers = Object.fromEntries(
      this.#store.listMcps().map((mcp) => [mcp.name, toServerEntry(mcp)]),
    );
    await mkdir(join(this.#piConfigPath, ".."), {
      recursive: true,
      mode: 0o700,
    });
    const tmp = `${this.#piConfigPath}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ mcpServers }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(tmp, this.#piConfigPath);
    await chmod(this.#piConfigPath, 0o600);
  }
}

function secretEnvName(server: string, key: string): string {
  return `AGENA_MCP_${createHash("sha256").update(`${server}\0${key}`).digest("hex").slice(0, 20).toUpperCase()}`;
}

function replaceSecretReference(
  record: Record<string, string>,
  key: string,
  secret: string,
  envName: string,
): void {
  for (const [name, value] of Object.entries(record)) {
    if (name === key || value === secret) record[name] = `\${${envName}}`;
    else record[name] = value.replaceAll(`\${${key}}`, `\${${envName}}`);
  }
}

function toServerEntry(mcp: McpRegistryRecord): PiMcpServerEntry {
  return {
    ...(mcp.command ? { command: mcp.command } : {}),
    ...(mcp.args ? { args: mcp.args } : {}),
    ...(mcp.url ? { url: mcp.url } : {}),
    ...(mcp.env ? { env: mcp.env } : {}),
    ...(mcp.headers ? { headers: mcp.headers } : {}),
    ...(mcp.authKind === "oauth"
      ? {
          auth: "oauth" as const,
          oauth: { redirectUri: "http://127.0.0.1:19876/callback" },
        }
      : mcp.authKind === "none"
        ? { auth: false as const }
        : {}),
    lifecycle: "lazy",
  };
}

function toSummary(mcp: McpRegistryRecord): McpSummary {
  const { env: _env, headers: _headers, ...summary } = mcp;
  return summary;
}
