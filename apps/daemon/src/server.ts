// Composition root + transport (§9.1/§9.2 M1 subset): InMemoryEventStore (P8),
// SessionOrchestrator, WS gateway, and one Node http.Server shared by the Hono
// app (GET /health) and the /v1/ws upgrade. Bearer auth is checked BEFORE the
// upgrade completes — failure is a raw HTTP 401, never a WS close code (§9.4).

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  AgentTaskStore,
  ApprovalQueryStore,
  ClosableStore,
  CreateSessionInput,
  EventStore,
  MessageQueryStore,
  ProjectionStore,
  RecoveryStore,
  RuntimeAdapter,
  RuntimeSessionRefStore,
  SearchStore,
  SessionFilter,
  SessionRecord,
  SessionStatusStore,
} from "@agena/core";
import {
  AgentOrchestrator,
  InMemoryEventStore,
  OrchestratorError,
  PathViolation,
  resolveWorkspacePath,
  SessionOrchestrator,
  StoreError,
} from "@agena/core";
import { synthesizeEvents } from "@agena/importer";
import {
  type CreateSessionRequest,
  completeMcpOAuthRequestSchema,
  createDerivedSessionRequestSchema,
  createPairingRequestSchema,
  createProjectRequestSchema,
  createPtyRequestSchema,
  createSessionRequestSchema,
  createSnapshotRequestSchema,
  createWsTicketRequestSchema,
  type DeleteProjectResponse,
  type DiscoveryEntry,
  type FileEntry,
  fileArchiveQuerySchema,
  fileContentQuerySchema,
  fileUploadQuerySchema,
  type ImportLedgerEntry,
  type ImportSessionRequest,
  type ImportSessionResponse,
  importMcpRequestSchema,
  importSessionRequestSchema,
  importSessionsRequestSchema,
  importSkillRequestSchema,
  type ListSessionsQuery,
  listApprovalsQuerySchema,
  listFilesQuerySchema,
  listImportsQuerySchema,
  listSessionsQuerySchema,
  navigateSessionRequestSchema,
  PROTOCOL_VERSION,
  pluginIdParamsSchema,
  providerIdParamsSchema,
  providerOAuthFlowParamsSchema,
  redeemPairingRequestSchema,
  respondProviderOAuthRequestSchema,
  restoreSnapshotRequestSchema,
  type SessionSummary,
  saveProviderApiKeyRequestSchema,
  searchQuerySchema,
  setPluginEnabledRequestSchema,
  updateSessionStatusRequestSchema,
  WS_PATH,
} from "@agena/protocol";
import { SqliteEventStore } from "@agena/storage-sqlite";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { DaemonConfig } from "./config.ts";
import { DAEMON_VERSION, Gateway } from "./gateway.ts";
import { log } from "./log.ts";
import { McpService } from "./mcp-service.ts";
import { OneTimeTokenStore } from "./one-time-tokens.ts";
import { PluginService } from "./plugin-service.ts";
import { ProviderAuthService } from "./provider-auth-service.ts";
import { PtyManager } from "./pty-manager.ts";
import { SkillService } from "./skill-service.ts";
import { SnapshotManager } from "./snapshots.ts";
import { TunnelManager } from "./tunnel-manager.ts";

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  const ascii = (start: number, value: string) =>
    [...value].every(
      (character, index) => bytes[start + index] === character.charCodeAt(0),
    );
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "BM")) return "image/bmp";
  return null;
}

export interface Daemon {
  port: number;
  /** Exposed for tests/demo (in-process session setup + assertions). */
  store: EventStore;
  orchestrator: SessionOrchestrator;
  close(): Promise<void>;
}

function tokenValueOk(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  return tokenValueOk(header.slice("Bearer ".length), token);
}

function providerAuthUnavailable(c: Context) {
  return c.json(
    {
      code: "NOT_SUPPORTED",
      message: "provider authentication requires the Pi runtime",
      retryable: false,
    },
    501,
  );
}

function invalidProviderRequest(c: Context) {
  return c.json(
    {
      code: "INVALID_PAYLOAD",
      message: "invalid provider authentication request",
      retryable: false,
    },
    400,
  );
}

function providerAuthError(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return c.json(
    {
      code: message.includes("not found")
        ? "NOT_FOUND"
        : "PROVIDER_AUTH_FAILED",
      message,
      retryable: false,
    },
    message.includes("not found") ? 404 : 400,
  );
}

function invalidPluginRequest(c: Context) {
  return c.json(
    {
      code: "INVALID_PAYLOAD",
      message: "invalid plugin request",
      retryable: false,
    },
    400,
  );
}

function pluginError(c: Context, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const missing = message === "Plugin not found";
  return c.json(
    {
      code: missing ? "NOT_FOUND" : "PLUGIN_OPERATION_FAILED",
      message,
      retryable: false,
    },
    missing ? 404 : 400,
  );
}

function upgradeTokenOk(
  req: {
    headers: { authorization?: string | undefined };
    url?: string | undefined;
  },
  token: string,
  tickets: OneTimeTokenStore,
  path: string,
): boolean {
  if (tokenOk(req.headers.authorization, token)) return true;
  const qs = (req.url ?? "").split("?")[1];
  if (!qs) return false;
  const ticket = new URLSearchParams(qs).get("ticket");
  return ticket !== null && tickets.consume(ticket, path);
}

async function validateSessionScope(
  workspaceDir: string,
  input: CreateSessionRequest,
): Promise<{
  scope: CreateSessionRequest["scope"];
  projectId?: string;
  projectRoot?: string;
  cwd: string;
  hostCwdHint?: string;
}> {
  if (input.scope !== "project") {
    return {
      scope: input.scope,
      cwd: (await workspaceDirectory(workspaceDir, input.cwd ?? ".")).relative,
      ...(input.hostCwdHint ? { hostCwdHint: input.hostCwdHint } : {}),
    };
  }
  if (!input.projectId || !input.projectRoot) throw new Error("INVALID_CWD");
  const project = await workspaceDirectory(workspaceDir, input.projectRoot);
  const cwdDir = await workspaceDirectory(
    workspaceDir,
    input.cwd ?? project.relative,
  );
  const projectRel = relative(project.absolute, cwdDir.absolute);
  if (
    projectRel !== "" &&
    (projectRel.startsWith("..") || isAbsolute(projectRel))
  ) {
    throw new Error("INVALID_CWD");
  }
  return {
    scope: "project",
    projectId: input.projectId,
    projectRoot: project.relative,
    cwd: cwdDir.relative,
    ...(input.hostCwdHint ? { hostCwdHint: input.hostCwdHint } : {}),
  };
}

function sessionFilter(input: ListSessionsQuery): SessionFilter {
  return {
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.allProjects !== undefined
      ? { allProjects: input.allProjects }
      : {}),
    ...(input.includeArchived !== undefined
      ? { includeArchived: input.includeArchived }
      : {}),
  };
}

async function workspaceDirectory(
  workspaceDir: string,
  path: string,
): Promise<{ absolute: string; relative: string }> {
  try {
    const root = await resolveWorkspacePath(workspaceDir, ".");
    const absolute = await resolveWorkspacePath(workspaceDir, path);
    if (!(await stat(absolute)).isDirectory()) throw new Error("INVALID_CWD");
    const rel = relative(root, absolute);
    return { absolute, relative: rel === "" ? "." : rel };
  } catch {
    throw new Error("INVALID_CWD");
  }
}

const EXTENSION_NAME_RE = /^[a-z0-9_]{1,64}$/;
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function projectSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64);
  if (!slug || !PROJECT_NAME_RE.test(slug)) throw new Error("INVALID_PROJECT");
  return slug;
}

function projectIdFor(name: string): string {
  return `prj_${name.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

async function createProject(
  workspaceDir: string,
  name: string,
  reuseExisting = false,
) {
  const slug = projectSlug(name);
  const absolute = await resolveWorkspacePath(workspaceDir, slug, {
    forWrite: true,
  });
  try {
    const info = await lstat(absolute);
    if (!info.isDirectory()) throw new Error("PROJECT_EXISTS");
    if (!reuseExisting && (await readdir(absolute)).length > 0)
      throw new Error("PROJECT_EXISTS");
  } catch (err) {
    const code = err instanceof Error ? (err as { code?: string }).code : "";
    if (code !== "ENOENT") throw err;
  }
  await mkdir(absolute, { recursive: true });
  return {
    name: slug,
    projectId: projectIdFor(slug),
    projectRoot: slug,
    cwd: slug,
  };
}

async function discoverAgena(workspaceDir: string): Promise<{
  entries: DiscoveryEntry[];
}> {
  const toolsDir = join(workspaceDir, ".agena", "tools");
  const files = await listToolFiles(toolsDir).catch(() => []);
  const entries: DiscoveryEntry[] = [];
  for (const file of files) {
    const rel = relative(toolsDir, file).replaceAll("\\", "/");
    const name = rel.slice(0, -".ts".length).replaceAll("/", "_");
    const entry: DiscoveryEntry = {
      kind: "tool",
      name,
      file: `.agena/tools/${rel}`,
      status: "ok",
    };
    if (!EXTENSION_NAME_RE.test(name)) {
      entries.push({
        ...entry,
        status: "invalid",
        reason: "path-derived name must match ^[a-z0-9_]{1,64}$",
      });
      continue;
    }
    const source = await readFile(file, "utf8").catch((err) => {
      entry.status = "invalid";
      entry.reason = `cannot read file: ${err instanceof Error ? err.message : String(err)}`;
      return "";
    });
    if (entry.status === "invalid") {
      entries.push(entry);
      continue;
    }
    const reason = invalidToolReason(source, name);
    entries.push(reason ? { ...entry, status: "invalid", reason } : entry);
  }
  return { entries: markCollisions(entries) };
}

async function listToolFiles(dir: string): Promise<string[]> {
  const dirStat = await lstat(dir);
  if (!dirStat.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listToolFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out.sort();
}

function invalidToolReason(source: string, derivedName: string): string | null {
  if (!/export\s+default\s+defineTool\s*\(/.test(source)) {
    return "missing default export defineTool(...)";
  }
  if (!balancedDelimiters(source)) return "unbalanced delimiters";
  const explicitName = /\bname\s*:\s*["'`]([A-Za-z0-9_-]+)["'`]/.exec(
    source,
  )?.[1];
  if (explicitName && explicitName !== derivedName) {
    return `explicit name '${explicitName}' must match path-derived name '${derivedName}'`;
  }
  return null;
}

function balancedDelimiters(source: string): boolean {
  const stack: string[] = [];
  const closes: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const ch of source) {
    if (ch === "(" || ch === "[" || ch === "{") stack.push(ch);
    if (
      (ch === ")" || ch === "]" || ch === "}") &&
      stack.pop() !== closes[ch]
    ) {
      return false;
    }
  }
  return stack.length === 0;
}

function markCollisions(entries: DiscoveryEntry[]): DiscoveryEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.status === "ok")
      counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  }
  return entries.map((entry) =>
    entry.status === "ok" && (counts.get(entry.name) ?? 0) > 1
      ? { ...entry, status: "collision", reason: "duplicate path-derived name" }
      : entry,
  );
}

async function ensureControlSession(store: EventStore): Promise<SessionRecord> {
  const [existing] = await store.listSessions({
    scope: "control",
    includeControl: true,
    includeArchived: true,
  });
  if (existing) return existing;
  return store.createSession({
    workspaceId: "default",
    title: "workspace control",
    scope: "control",
    cwd: ".",
    source: { kind: "daemon" },
  });
}

function agentTasks(store: EventStore): (EventStore & AgentTaskStore) | null {
  return "createSubagentSession" in store
    ? (store as EventStore & AgentTaskStore)
    : null;
}

function sessionSummaries(
  sessions: SessionRecord[],
  tasks: AgentTaskStore | null,
): SessionSummary[] {
  const tasksByChildSessionId = new Map(
    tasks?.listAgentTasks().map((task) => [task.childSessionId, task]) ?? [],
  );
  return sessions.map((session) => {
    const task = tasksByChildSessionId.get(session.sessionId);
    return {
      ...session,
      ...(task
        ? {
            subagent: {
              taskId: task.taskId,
              role: task.role,
              status: task.status,
              createdAt: task.createdAt,
              ...(task.startedAt ? { startedAt: task.startedAt } : {}),
              ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
            },
          }
        : {}),
    };
  });
}

export async function startDaemon(
  config: DaemonConfig,
  adapter: RuntimeAdapter,
): Promise<Daemon> {
  const sqlite =
    config.storage === "sqlite"
      ? new SqliteEventStore(join(config.stateDir, "db", "agena.db"))
      : null;
  const store: EventStore = sqlite ?? new InMemoryEventStore();
  const mcps = sqlite ? new McpService(sqlite, config.stateDir) : null;
  const skills = sqlite ? new SkillService(sqlite, config.stateDir) : null;
  const providers =
    "providers" in adapter &&
    typeof adapter.providers === "object" &&
    adapter.providers !== null
      ? new ProviderAuthService(
          adapter.providers as ConstructorParameters<
            typeof ProviderAuthService
          >[0],
        )
      : null;
  const plugins = new PluginService(
    mcps,
    "packages" in adapter && adapter.packages
      ? (adapter.packages as ConstructorParameters<typeof PluginService>[1])
      : null,
  );
  await mcps?.initialize();
  // `gateway` is initialized before any frame can be published (frames only
  // flow after a prompt), so the closure is safe.
  let gateway: Gateway;
  let agents: AgentOrchestrator | null = null;
  const orchestrator = new SessionOrchestrator(store, adapter, {
    workspaceDir: config.workspaceDir,
    publishFrame: (frame) => gateway.publishFrame(frame),
    visibleBrowser: {
      request: (action) => gateway.requestVisibleBrowser(action),
    },
    ...(agentTasks(store)
      ? {
          subagents: {
            run: (input) => {
              if (!agents) throw new Error("subagent orchestrator unavailable");
              return agents.run(input);
            },
          },
        }
      : {}),
  });
  const taskStore = agentTasks(store);
  if (taskStore) agents = new AgentOrchestrator(taskStore, orchestrator);
  gateway = new Gateway(store, orchestrator);
  const ptys = new PtyManager(store, config.workspaceDir);
  const tunnels = new TunnelManager();
  const controlSession = await ensureControlSession(store);
  const snapshots = new SnapshotManager(
    store,
    config.workspaceDir,
    config.stateDir,
    controlSession,
  );
  await snapshots.recoverJournal();
  const recovery = recoveryStore(store);
  if (recovery) {
    const report = await recovery.reconcileOpenWork();
    if (report.appended > 0) {
      log("warn", "reconciled open work after restart", { ...report });
    }
  }

  const startedAt = Date.now();
  const wsTickets = new OneTimeTokenStore();
  const pairings = new OneTimeTokenStore();
  const app = new Hono();
  // §9.3: /health is unauthenticated by design.
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      version: DAEMON_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      uptimeMs: Date.now() - startedAt,
    }),
  );

  // Browser clients (WsBridge) are cross-origin: the authorization header
  // triggers CORS preflight, so /v1 answers OPTIONS and echoes the origin.
  // Auth still gates every request — CORS only unblocks the browser's checks.
  app.use(
    "/v1/*",
    cors({
      origin: (origin) => origin,
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // §9.3 session routes.
  // ponytail: GET/PATCH /v1/sessions/:id lands with richer session management.
  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/pairings/redeem") {
      await next();
      return;
    }
    if (!tokenOk(c.req.header("authorization"), config.token)) {
      return c.json(
        { code: "UNAUTHORIZED", message: "invalid token", retryable: false },
        401,
      );
    }
    await next();
  });
  app.post("/v1/ws-tickets", async (c) => {
    const parsed = createWsTicketRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return invalidProviderRequest(c);
    const created = wsTickets.create(parsed.data.path, 30_000);
    return c.json({
      ticket: created.token,
      expiresAt: created.expiresAt.toISOString(),
    });
  });
  app.post("/v1/pairings", async (c) => {
    const parsed = createPairingRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return invalidProviderRequest(c);
    const created = pairings.create(parsed.data.daemonUrl, 5 * 60_000);
    const uri = new URL("agena://pair");
    uri.searchParams.set("url", parsed.data.daemonUrl);
    uri.searchParams.set("token", created.token);
    return c.json({
      pairingUri: uri.toString(),
      expiresAt: created.expiresAt.toISOString(),
    });
  });
  app.post("/v1/pairings/redeem", async (c) => {
    const header = c.req.header("authorization");
    const pairingToken = header?.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    const daemonUrl = pairingToken ? pairings.take(pairingToken) : null;
    if (!daemonUrl) {
      return c.json(
        { code: "UNAUTHORIZED", message: "invalid pairing", retryable: false },
        401,
      );
    }
    const parsed = redeemPairingRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return invalidProviderRequest(c);
    return c.json({ daemonUrl, token: config.token });
  });
  app.get("/v1/diagnostics", async (c) =>
    c.json({
      daemon: { version: DAEMON_VERSION, uptimeMs: Date.now() - startedAt },
      protocol: { version: PROTOCOL_VERSION },
      workspace: { path: config.workspaceDir },
      discovery: await discoverAgena(config.workspaceDir),
    }),
  );
  app.post("/v1/images", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 3_000_000) {
      return c.json(
        {
          code: "PAYLOAD_TOO_LARGE",
          message: "image must be between 1 byte and 3 MB",
          retryable: false,
        },
        413,
      );
    }
    const mimeType = sniffImageMime(bytes);
    if (!mimeType) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "supported images are JPEG, PNG, GIF, WebP, and BMP",
          retryable: false,
        },
        400,
      );
    }
    return c.json({
      ref: await store.putBlob(bytes, mimeType),
    });
  });
  app.get("/v1/blobs/:hash", async (c) => {
    const stored = await store.readBlob(`sha256:${c.req.param("hash")}`);
    if (!stored) {
      return c.json(
        { code: "NOT_FOUND", message: "blob not found", retryable: false },
        404,
      );
    }
    const body = stored.bytes.buffer.slice(
      stored.bytes.byteOffset,
      stored.bytes.byteOffset + stored.bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "content-type": stored.mimeType ?? "application/octet-stream",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });
  app.get("/v1/mcps", (c) => c.json({ mcps: mcps?.list() ?? [] }));
  app.get("/v1/plugins", (c) => c.json({ plugins: plugins.list() }));
  app.post("/v1/plugins/:id/install", async (c) => {
    const params = pluginIdParamsSchema.safeParse(c.req.param());
    if (!params.success) return invalidPluginRequest(c);
    try {
      const plugin = await plugins.install(params.data.id);
      await adapter.reloadExtensions?.();
      return c.json({ plugin });
    } catch (error) {
      return pluginError(c, error);
    }
  });
  app.post("/v1/plugins/:id/update", async (c) => {
    const params = pluginIdParamsSchema.safeParse(c.req.param());
    if (!params.success) return invalidPluginRequest(c);
    try {
      const plugin = await plugins.update(params.data.id);
      await adapter.reloadExtensions?.();
      return c.json({ plugin });
    } catch (error) {
      return pluginError(c, error);
    }
  });
  app.patch("/v1/plugins/:id", async (c) => {
    const params = pluginIdParamsSchema.safeParse(c.req.param());
    const body = setPluginEnabledRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!params.success || !body.success) return invalidPluginRequest(c);
    try {
      const plugin = await plugins.setEnabled(
        params.data.id,
        body.data.enabled,
      );
      await adapter.reloadExtensions?.();
      return c.json({ plugin });
    } catch (error) {
      return pluginError(c, error);
    }
  });
  app.delete("/v1/plugins/:id", async (c) => {
    const params = pluginIdParamsSchema.safeParse(c.req.param());
    if (!params.success) return invalidPluginRequest(c);
    try {
      const plugin = await plugins.remove(params.data.id);
      await adapter.reloadExtensions?.();
      return c.json({ plugin });
    } catch (error) {
      return pluginError(c, error);
    }
  });
  app.get("/v1/providers", (c) =>
    providers
      ? c.json({ providers: providers.list() })
      : c.json(
          {
            code: "NOT_SUPPORTED",
            message: "provider authentication requires the Pi runtime",
            retryable: false,
          },
          501,
        ),
  );
  app.put("/v1/providers/:id/api-key", async (c) => {
    if (!providers) return providerAuthUnavailable(c);
    const params = providerIdParamsSchema.safeParse(c.req.param());
    if (!params.success) return invalidProviderRequest(c);
    const parsed = saveProviderApiKeyRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return invalidProviderRequest(c);
    try {
      return c.json({
        provider: await providers.saveApiKey(
          params.data.id,
          parsed.data.apiKey,
          parsed.data.env,
        ),
      });
    } catch (error) {
      return providerAuthError(c, error);
    }
  });
  app.delete("/v1/providers/:id/auth", async (c) => {
    if (!providers) return providerAuthUnavailable(c);
    const params = providerIdParamsSchema.safeParse(c.req.param());
    if (!params.success) return invalidProviderRequest(c);
    try {
      return c.json({ provider: await providers.remove(params.data.id) });
    } catch (error) {
      return providerAuthError(c, error);
    }
  });
  app.post("/v1/providers/:id/oauth/start", async (c) => {
    if (!providers) return providerAuthUnavailable(c);
    const params = providerIdParamsSchema.safeParse(c.req.param());
    if (!params.success) return invalidProviderRequest(c);
    try {
      return c.json(await providers.startOAuth(params.data.id));
    } catch (error) {
      return providerAuthError(c, error);
    }
  });
  app.get("/v1/providers/oauth/:flowId", (c) => {
    if (!providers) return providerAuthUnavailable(c);
    const params = providerOAuthFlowParamsSchema.safeParse(c.req.param());
    if (!params.success) return invalidProviderRequest(c);
    const status = providers.status(params.data.flowId);
    return status
      ? c.json(status)
      : c.json(
          {
            code: "NOT_FOUND",
            message: "provider OAuth flow not found",
            retryable: false,
          },
          404,
        );
  });
  app.post("/v1/providers/oauth/:flowId/respond", async (c) => {
    if (!providers) return providerAuthUnavailable(c);
    const params = providerOAuthFlowParamsSchema.safeParse(c.req.param());
    if (!params.success) return invalidProviderRequest(c);
    const parsed = respondProviderOAuthRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return invalidProviderRequest(c);
    try {
      providers.respond(params.data.flowId, parsed.data);
      const status = providers.status(params.data.flowId);
      return status
        ? c.json(status)
        : c.json(
            {
              code: "NOT_FOUND",
              message: "provider OAuth flow not found",
              retryable: false,
            },
            404,
          );
    } catch (error) {
      return providerAuthError(c, error);
    }
  });
  app.get("/v1/skills", (c) => c.json({ skills: skills?.list() ?? [] }));
  app.post("/v1/skills/check-updates", async (c) => {
    if (!skills)
      return c.json(
        {
          code: "NOT_SUPPORTED",
          message: "skill updates require SQLite",
          retryable: false,
        },
        501,
      );
    return c.json({ skills: await skills.checkAll() });
  });
  app.post("/v1/skills/import", async (c) => {
    if (!skills)
      return c.json(
        {
          code: "NOT_SUPPORTED",
          message: "skill import requires SQLite",
          retryable: false,
        },
        501,
      );
    const parsed = importSkillRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid skill import request",
          retryable: false,
        },
        400,
      );
    try {
      const skill = await skills.import(parsed.data);
      await adapter.reloadExtensions?.();
      return c.json({ skill });
    } catch (error) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message:
            error instanceof Error ? error.message : "skill import failed",
          retryable: false,
        },
        400,
      );
    }
  });
  app.post("/v1/skills/:id/update", async (c) => {
    if (!skills)
      return c.json(
        {
          code: "NOT_SUPPORTED",
          message: "skill updates require SQLite",
          retryable: false,
        },
        501,
      );
    try {
      const skill = await skills.update(c.req.param("id"));
      await adapter.reloadExtensions?.();
      return c.json({ skill });
    } catch (error) {
      return c.json(
        {
          code: "SKILL_UPDATE_FAILED",
          message:
            error instanceof Error ? error.message : "skill update failed",
          retryable: true,
        },
        400,
      );
    }
  });
  app.post("/v1/mcps/import", async (c) => {
    if (!mcps)
      return c.json(
        {
          code: "NOT_SUPPORTED",
          message: "MCP import requires SQLite",
          retryable: false,
        },
        501,
      );
    const parsed = importMcpRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid MCP import request",
          retryable: false,
        },
        400,
      );
    try {
      const mcp = await mcps.import(parsed.data);
      await adapter.reloadExtensions?.();
      return c.json({ mcp });
    } catch (error) {
      return c.json(
        {
          code: "INTERNAL",
          message: error instanceof Error ? error.message : "MCP import failed",
          retryable: false,
        },
        500,
      );
    }
  });
  app.post("/v1/mcps/:id/oauth/start", async (c) => {
    if (!mcps)
      return c.json(
        {
          code: "NOT_SUPPORTED",
          message: "MCP OAuth requires SQLite",
          retryable: false,
        },
        501,
      );
    try {
      return c.json({
        authorizationUrl: await mcps.startOAuth(c.req.param("id")),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "MCP OAuth failed";
      return c.json(
        {
          code: message === "MCP not found" ? "NOT_FOUND" : "MCP_AUTH_FAILED",
          message,
          retryable: false,
        },
        message === "MCP not found" ? 404 : 400,
      );
    }
  });
  app.post("/v1/mcps/:id/oauth/complete", async (c) => {
    if (!mcps)
      return c.json(
        {
          code: "NOT_SUPPORTED",
          message: "MCP OAuth requires SQLite",
          retryable: false,
        },
        501,
      );
    const parsed = completeMcpOAuthRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid MCP OAuth callback",
          retryable: false,
        },
        400,
      );
    try {
      return c.json({
        mcp: await mcps.completeOAuth(
          c.req.param("id"),
          parsed.data.redirectUrl,
        ),
      });
    } catch (error) {
      return c.json(
        {
          code: "MCP_AUTH_FAILED",
          message: error instanceof Error ? error.message : "MCP OAuth failed",
          retryable: false,
        },
        400,
      );
    }
  });
  app.post("/v1/projects", async (c) => {
    const parsed = createProjectRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid project create request",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    try {
      return c.json(
        await createProject(
          config.workspaceDir,
          parsed.data.name,
          parsed.data.reuseExisting,
        ),
        201,
      );
    } catch (err) {
      return projectRouteError(c, err);
    }
  });
  // Full project teardown: rows (Litestream replicates to R2), workspace
  // files, pi session JSONLs, snapshot archives. Live runtimes evicted first.
  app.delete("/v1/projects/:id", async (c) => {
    const projectId = c.req.param("id");
    const deleter =
      "deleteProject" in store
        ? (store as EventStore & {
            deleteProject(id: string): {
              root: string;
              sessionIds: string[];
              piSessionPaths: string[];
              snapshotPaths: string[];
            } | null;
          })
        : null;
    if (!deleter) {
      return c.json(
        {
          code: "UNSUPPORTED",
          message: "store does not support project deletion",
          retryable: false,
        },
        501,
      );
    }
    const sessionIds = (
      await store.listSessions({ projectId, includeArchived: true })
    ).map((s) => s.sessionId);
    await orchestrator.evictSessions(sessionIds);
    const deleted = deleter.deleteProject(projectId);
    if (!deleted) {
      return c.json(
        {
          code: "NOT_FOUND",
          message: `unknown project: ${projectId}`,
          retryable: false,
        },
        404,
      );
    }
    for (const path of [...deleted.piSessionPaths, ...deleted.snapshotPaths]) {
      await rm(path, { force: true }).catch(() => {});
    }
    try {
      const root = await resolveWorkspacePath(
        config.workspaceDir,
        deleted.root,
      );
      await rm(root, { recursive: true, force: true });
    } catch {
      // root escaped the workspace or is already gone — rows are the source of truth
    }
    return c.json({
      projectId,
      deletedSessions: deleted.sessionIds.length,
    } satisfies DeleteProjectResponse);
  });
  // settings_import_plan.md §6: pi-native JSONL comes in, session + events come out.
  app.post("/v1/imports/session", async (c) => {
    const parsed = importSessionRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid session import request",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    try {
      const result = await importSession(store, config, parsed.data);
      return c.json(result, result.alreadyImported ? 200 : 201);
    } catch (err) {
      if (err instanceof ImportRequestError) {
        return c.json(
          {
            code: err.code,
            message: err.message,
            retryable: false,
          },
          err.status,
        );
      }
      log("error", "session import failed", { err: String(err) });
      return c.json(
        {
          code: "INTERNAL",
          message: "session import failed",
          retryable: false,
        },
        500,
      );
    }
  });
  app.post("/v1/imports/sessions", async (c) => {
    const parsed = importSessionsRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid session import batch",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    const sessions = [];
    for (const input of parsed.data.sessions) {
      try {
        sessions.push({
          sourcePath: input.sourceFingerprint.sourcePath,
          result: await importSession(store, config, input),
        });
      } catch (err) {
        const message =
          err instanceof ImportRequestError
            ? err.message
            : "session import failed";
        if (!(err instanceof ImportRequestError))
          log("error", "batched session import failed", { err: String(err) });
        sessions.push({
          sourcePath: input.sourceFingerprint.sourcePath,
          error: message,
        });
      }
    }
    return c.json({ sessions });
  });
  app.get("/v1/imports", async (c) => {
    const parsed = listImportsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid imports query",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    const imports = importStore(store);
    return c.json({
      imports: imports ? imports.listImports(parsed.data.machineId) : [],
      capabilities: { session: true, batch: true },
    });
  });
  app.post("/v1/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid session create request",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    try {
      const scope = await validateSessionScope(
        config.workspaceDir,
        parsed.data,
      );
      const input: CreateSessionInput = {
        workspaceId: "default",
        ...(parsed.data.title === undefined
          ? {}
          : { title: parsed.data.title }),
        scope: scope.scope,
        cwd: scope.cwd,
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
        ...(scope.projectRoot ? { projectRoot: scope.projectRoot } : {}),
        ...(scope.hostCwdHint ? { hostCwdHint: scope.hostCwdHint } : {}),
      };
      const session = await orchestrator.createSession(input);
      return c.json({ sessionId: session.sessionId }, 201);
    } catch (err) {
      if (err instanceof Error && err.message === "INVALID_CWD") {
        return c.json(
          {
            code: "INVALID_PAYLOAD",
            message: "cwd must exist under /workspace and inside project root",
            retryable: false,
          },
          400,
        );
      }
      throw err;
    }
  });
  app.post("/v1/sessions/:id/derived", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createDerivedSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid derived session request",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    try {
      const session = await orchestrator.forkSession({
        parentSessionId: c.req.param("id"),
        mode: parsed.data.mode,
        ...(parsed.data.sourceMessageId
          ? { sourceMessageId: parsed.data.sourceMessageId }
          : {}),
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
      });
      return c.json({ sessionId: session.sessionId }, 201);
    } catch (err) {
      if (err instanceof OrchestratorError) {
        const status = err.code === "SESSION_NOT_FOUND" ? 404 : 409;
        return c.json(
          { code: err.code, message: err.message, retryable: false },
          status,
        );
      }
      if (err instanceof StoreError) {
        return c.json(
          {
            code:
              err.code === "session_not_found"
                ? "SESSION_NOT_FOUND"
                : "INVALID_PAYLOAD",
            message: err.message,
            retryable: false,
          },
          err.code === "session_not_found" ? 404 : 400,
        );
      }
      throw err;
    }
  });
  app.post("/v1/sessions/:id/navigate", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = navigateSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid session navigation request",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    try {
      return c.json(
        await orchestrator.navigateToMessage(
          c.req.param("id"),
          parsed.data.sourceMessageId,
        ),
      );
    } catch (err) {
      if (err instanceof OrchestratorError) {
        return c.json(
          { code: err.code, message: err.message, retryable: false },
          err.code === "SESSION_NOT_FOUND" ? 404 : 409,
        );
      }
      throw err;
    }
  });
  app.get("/v1/sessions", async (c) => {
    const parsed = listSessionsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid session list filters",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    return c.json({
      sessions: sessionSummaries(
        await store.listSessions(sessionFilter(parsed.data)),
        taskStore,
      ),
    });
  });
  app.get("/v1/search", async (c) => {
    const parsed = searchQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid search query",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    const search = searchStore(store);
    if (!search) {
      return c.json(
        {
          code: "INTERNAL",
          message: "store does not support search",
          retryable: false,
        },
        500,
      );
    }
    return c.json({
      hits: await search.search(parsed.data.q, {
        limit: parsed.data.limit,
        ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
        ...(parsed.data.projectId ? { projectId: parsed.data.projectId } : {}),
        ...(parsed.data.allProjects !== undefined
          ? { allProjects: parsed.data.allProjects }
          : {}),
      }),
    });
  });
  app.get("/v1/sessions/:id/user-messages", async (c) => {
    const sessionId = c.req.param("id");
    if (!(await store.getSession(sessionId))) {
      return c.json(
        {
          code: "SESSION_NOT_FOUND",
          message: `unknown session ${sessionId}`,
          retryable: false,
        },
        404,
      );
    }
    const messages = messageQueryStore(store);
    if (!messages) {
      return c.json(
        {
          code: "INTERNAL",
          message: "store does not support message queries",
          retryable: false,
        },
        500,
      );
    }
    return c.json({ messages: await messages.listUserMessages(sessionId) });
  });
  app.patch("/v1/sessions/:id", async (c) => {
    const parsed = updateSessionStatusRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid session status update",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    const statuses = sessionStatusStore(store);
    if (!statuses) {
      return c.json(
        {
          code: "INTERNAL",
          message: "store does not support session status updates",
          retryable: false,
        },
        500,
      );
    }
    try {
      await statuses.updateSessionStatus(c.req.param("id"), parsed.data.status);
      return c.body(null, 204);
    } catch {
      return c.json(
        {
          code: "SESSION_NOT_FOUND",
          message: `unknown session ${c.req.param("id")}`,
          retryable: false,
        },
        404,
      );
    }
  });
  app.get("/v1/approvals", async (c) => {
    const parsed = listApprovalsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid approval list filters",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    const approvals = approvalQueryStore(store);
    if (!approvals) {
      return c.json({ approvals: [] });
    }
    return c.json({
      approvals: await approvals.listPendingApprovals({ allProjects: true }),
    });
  });
  app.get("/v1/files", async (c) => {
    const parsed = listFilesQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid file list query",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    try {
      return c.json(
        await listWorkspaceFiles(config.workspaceDir, parsed.data.path),
      );
    } catch (err) {
      return fileRouteError(c, err);
    }
  });
  app.get("/v1/files/content", async (c) => {
    const parsed = fileContentQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid file content query",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    try {
      const path = await resolveWorkspacePath(
        config.workspaceDir,
        parsed.data.path,
      );
      const info = await stat(path);
      if (!info.isFile()) throw new Error("NOT_FILE");
      c.header("content-length", String(info.size));
      c.header("content-type", "application/octet-stream");
      return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream);
    } catch (err) {
      return fileRouteError(c, err);
    }
  });
  app.get("/v1/files/archive", async (c) => {
    const parsed = fileArchiveQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid file archive query",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    try {
      const root = realpathSync(config.workspaceDir);
      const path = await resolveWorkspacePath(root, parsed.data.path);
      const info = await stat(path);
      if (!info.isDirectory()) throw new Error("NOT_DIRECTORY");
      const rel = relative(root, path) || ".";
      const tar = spawn("tar", ["--zstd", "-cf", "-", "-C", root, rel], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      tar.stderr.resume();
      c.header("content-type", "application/x-tar+zstd");
      c.header(
        "content-disposition",
        'attachment; filename="workspace.tar.zst"',
      );
      return c.body(Readable.toWeb(tar.stdout) as ReadableStream);
    } catch (err) {
      return fileRouteError(c, err);
    }
  });
  app.post("/v1/files/upload", async (c) => {
    const parsed = fileUploadQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid file upload query",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    try {
      return c.json(
        await uploadTar(config.workspaceDir, parsed.data.path, c.req.raw.body),
        201,
      );
    } catch (err) {
      return uploadRouteError(c, err);
    }
  });
  app.get("/v1/sessions/:id/events", async (c) => {
    const fromSeq = Number(c.req.query("fromSeq") ?? "0");
    const limit = Math.min(Number(c.req.query("limit") ?? "500"), 2000);
    if (
      !Number.isInteger(fromSeq) ||
      fromSeq < 0 ||
      !Number.isInteger(limit) ||
      limit < 1
    ) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "fromSeq must be >= 0 and limit must be >= 1",
          retryable: false,
        },
        400,
      );
    }
    try {
      return c.json(await store.readEvents(c.req.param("id"), fromSeq, limit));
    } catch {
      return c.json(
        {
          code: "SESSION_NOT_FOUND",
          message: `unknown session ${c.req.param("id")}`,
          retryable: false,
        },
        404,
      );
    }
  });
  app.post("/v1/admin/rebuild", async (c) => {
    const projections = projectionStore(store);
    if (!projections) {
      return c.json(
        {
          code: "INTERNAL",
          message: "store does not support rebuild",
          retryable: false,
        },
        500,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      sessionId?: unknown;
    };
    if (body.sessionId !== undefined && typeof body.sessionId !== "string") {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "sessionId must be a string",
          retryable: false,
        },
        400,
      );
    }
    return c.json(await projections.rebuildProjections(body.sessionId));
  });
  app.get("/v1/snapshots", async (c) =>
    c.json({ snapshots: await snapshots.list() }),
  );
  app.post("/v1/snapshots", async (c) => {
    const parsed = createSnapshotRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid snapshot create request",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    try {
      return c.json(
        {
          snapshot: await snapshots.create({
            ...(parsed.data.name ? { name: parsed.data.name } : {}),
            ...(parsed.data.sessionId
              ? { sessionId: parsed.data.sessionId }
              : {}),
          }),
        },
        201,
      );
    } catch (err) {
      log("error", "snapshot create failed", { err: String(err) });
      return c.json(
        {
          code: "INTERNAL",
          message: "snapshot create failed",
          retryable: false,
        },
        500,
      );
    }
  });
  app.post("/v1/snapshots/:id/restore", async (c) => {
    const parsed = restoreSnapshotRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid snapshot restore request",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    try {
      return c.json(
        await snapshots.restore(c.req.param("id"), {
          ...(parsed.data.sessionId
            ? { sessionId: parsed.data.sessionId }
            : {}),
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "SNAPSHOT_NOT_FOUND") {
        return c.json(
          {
            code: "SNAPSHOT_NOT_FOUND",
            message: `unknown snapshot ${c.req.param("id")}`,
            retryable: false,
          },
          404,
        );
      }
      log("error", "snapshot restore failed", { err: msg });
      return c.json(
        {
          code: "INTERNAL",
          message: "snapshot restore failed",
          retryable: false,
        },
        500,
      );
    }
  });
  app.delete("/v1/snapshots/:id", async (c) => {
    await snapshots.delete(c.req.param("id"));
    return c.body(null, 204);
  });
  app.post("/v1/ptys", async (c) => {
    const parsed = createPtyRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "invalid PTY create request",
          retryable: false,
          details: parsed.error.issues,
        },
        400,
      );
    }
    try {
      return c.json(await ptys.create(parsed.data), 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "SESSION_NOT_FOUND") {
        return c.json(
          {
            code: "SESSION_NOT_FOUND",
            message: `unknown session ${parsed.data.sessionId}`,
            retryable: false,
          },
          404,
        );
      }
      if (message === "INVALID_CWD") {
        return c.json(
          {
            code: "INVALID_PAYLOAD",
            message: "cwd must exist under /workspace",
            retryable: false,
          },
          400,
        );
      }
      log("error", "pty create failed", { err: message });
      return c.json(
        { code: "INTERNAL", message: "pty create failed", retryable: false },
        500,
      );
    }
  });
  app.get("/v1/ptys", (c) => c.json(ptys.list()));
  app.delete("/v1/ptys/:id", async (c) => {
    if (!(await ptys.kill(c.req.param("id")))) {
      return c.json(
        {
          code: "SESSION_NOT_FOUND",
          message: `unknown pty ${c.req.param("id")}`,
          retryable: false,
        },
        404,
      );
    }
    return c.body(null, 204);
  });

  const { server, port } = await new Promise<{ server: Server; port: number }>(
    (resolve) => {
      const s = serve(
        { fetch: app.fetch, hostname: config.host, port: config.port },
        (info) => resolve({ server: s as Server, port: info.port }),
      );
    },
  );

  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (!upgradeTokenOk(req, config.token, wsTickets, path)) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    const tunnelMatch = /^\/v1\/tunnels\/(\d+)\/ws$/.exec(path);
    if (tunnelMatch?.[1]) {
      tunnels.handleUpgrade(req, socket, head, Number(tunnelMatch[1]));
      return;
    }
    const ptyMatch = /^\/v1\/ptys\/([^/]+)\/ws$/.exec(path);
    const ptyId = ptyMatch?.[1];
    if (ptyId) {
      ptys.handleUpgrade(req, socket, head, decodeURIComponent(ptyId));
      return;
    }
    if (path !== WS_PATH) {
      socket.write(
        "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    gateway.wss.handleUpgrade(req, socket, head, (ws) => gateway.connect(ws));
  });

  return {
    port,
    store,
    orchestrator,
    // ponytail: compact shutdown path; full §9.7 drain metrics/counters land later.
    close: async () => {
      await orchestrator.shutdown();
      await ptys.close();
      await tunnels.close();
      gateway.close();
      server.closeIdleConnections(); // don't hang on kept-alive HTTP sockets
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeStore(store);
      await adapter.dispose().catch((err) => {
        log("warn", "adapter dispose failed", { err: String(err) });
      });
    },
  };
}

async function closeStore(store: EventStore): Promise<void> {
  await closableStore(store)?.close();
}

function sessionStatusStore(store: EventStore): SessionStatusStore | null {
  return "updateSessionStatus" in store
    ? (store as EventStore & SessionStatusStore)
    : null;
}

function approvalQueryStore(store: EventStore): ApprovalQueryStore | null {
  return "listPendingApprovals" in store
    ? (store as EventStore & ApprovalQueryStore)
    : null;
}

function searchStore(store: EventStore): SearchStore | null {
  return "search" in store ? (store as EventStore & SearchStore) : null;
}

function messageQueryStore(store: EventStore): MessageQueryStore | null {
  return "listUserMessages" in store
    ? (store as EventStore & MessageQueryStore)
    : null;
}

function projectionStore(store: EventStore): ProjectionStore | null {
  return "rebuildProjections" in store
    ? (store as EventStore & ProjectionStore)
    : null;
}

function recoveryStore(store: EventStore): RecoveryStore | null {
  return "reconcileOpenWork" in store
    ? (store as EventStore & RecoveryStore)
    : null;
}

// Import-ledger capabilities live on SqliteEventStore only (plan §6); typed
// structurally like the other opt-in store guards above.
type ImportLedgerStore = RuntimeSessionRefStore & {
  insertImport(
    entry: Omit<ImportLedgerEntry, "id" | "importedAt">,
  ): ImportLedgerEntry;
  findImport(
    machineId: string,
    harness: string,
    sourceSessionId: string,
  ): ImportLedgerEntry | null;
  listImports(machineId?: string): ImportLedgerEntry[];
};

function importStore(store: EventStore): ImportLedgerStore | null {
  return "insertImport" in store
    ? (store as EventStore & ImportLedgerStore)
    : null;
}

/** First JSONL line must be a pi v3 session header with a filename-safe id. */
function piSessionHeader(
  piSession: string,
): { id: string; timestamp: string; cwd: string } | null {
  let header: unknown;
  try {
    header = JSON.parse(piSession.split("\n", 1)[0] ?? "");
  } catch {
    return null;
  }
  const h = header as Record<string, unknown>;
  if (
    h?.type !== "session" ||
    h.version !== 3 ||
    typeof h.id !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(h.id) ||
    typeof h.timestamp !== "string" ||
    !/^[0-9TZ:.+-]+$/.test(h.timestamp) ||
    typeof h.cwd !== "string" ||
    h.cwd === ""
  ) {
    return null;
  }
  return { id: h.id, timestamp: h.timestamp, cwd: h.cwd };
}

class ImportRequestError extends Error {
  readonly code: "INVALID_PAYLOAD" | "INTERNAL";
  readonly status: 400 | 500;

  constructor(
    code: "INVALID_PAYLOAD" | "INTERNAL",
    status: 400 | 500,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function importSession(
  store: EventStore,
  config: DaemonConfig,
  input: ImportSessionRequest,
): Promise<ImportSessionResponse> {
  const imports = importStore(store);
  if (!imports)
    throw new ImportRequestError(
      "INTERNAL",
      500,
      "store does not support imports",
    );
  const fp = input.sourceFingerprint;
  const subagent = input.subagent;
  const existing = imports.findImport(
    fp.machineId,
    fp.harness,
    fp.sourceSessionId,
  );
  if (existing?.sessionId)
    return {
      sessionId: existing.sessionId,
      seededEvents: 0,
      alreadyImported: true,
    };
  const header = piSessionHeader(input.piSession);
  if (!header)
    throw new ImportRequestError(
      "INVALID_PAYLOAD",
      400,
      "piSession must be pi v3 JSONL with a session header",
    );
  let scope: Awaited<ReturnType<typeof validateSessionScope>>;
  try {
    scope = await validateSessionScope(config.workspaceDir, {
      scope: "project",
      projectId: input.projectId,
      projectRoot: input.projectRoot,
    });
  } catch (err) {
    if (err instanceof Error && err.message === "INVALID_CWD")
      throw new ImportRequestError(
        "INVALID_PAYLOAD",
        400,
        "projectRoot must exist under /workspace",
      );
    throw err;
  }
  const sessionFile = join(
    config.stateDir,
    "pi",
    "sessions",
    `--${header.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
    `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`,
  );
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, input.piSession);
  const origin =
    fp.harness === "claude"
      ? ("import.claude" as const)
      : fp.harness === "codex"
        ? ("import.codex" as const)
        : undefined;
  const parent = subagent
    ? imports.findImport(
        fp.machineId,
        fp.harness,
        subagent.parentSourceSessionId,
      )
    : null;
  const parentSessionId = parent?.sessionId;
  if (subagent && !parentSessionId)
    throw new ImportRequestError(
      "INVALID_PAYLOAD",
      400,
      "parent session must be imported before its subagents",
    );
  const taskId = subagent ? `import:${fp.harness}:${fp.sourceSessionId}` : null;
  const taskStore = subagent ? agentTasks(store) : null;
  if (subagent && !taskStore)
    throw new ImportRequestError(
      "INTERNAL",
      500,
      "store does not support imported subagents",
    );
  let session: SessionRecord;
  if (subagent && taskStore && parentSessionId && taskId) {
    session = (
      await taskStore.createSubagentSession({
        parentSessionId,
        title: input.title ?? subagent.role,
        source: { kind: "importer" },
        ...(origin ? { origin } : {}),
        task: {
          taskId,
          parentRunId: `import:${subagent.parentSourceSessionId}`,
          parentMessageId: `import:${subagent.parentSourceSessionId}`,
          parentToolCallId: `import:${subagent.agentId}`,
          role: subagent.role,
          task: subagent.task,
          execution: subagent.execution,
          context: "fresh",
          workspaceMode: "shared_readonly",
          requestedModel: subagent.model,
          resolvedModel: subagent.model,
        },
      })
    ).session;
  } else {
    session = await store.createSession({
      workspaceId: "default",
      ...(input.title !== undefined ? { title: input.title } : {}),
      scope: "project",
      cwd: scope.cwd,
      ...(scope.projectId ? { projectId: scope.projectId } : {}),
      ...(scope.projectRoot ? { projectRoot: scope.projectRoot } : {}),
      source: { kind: "importer" },
      ...(origin ? { origin } : {}),
    });
  }
  try {
    imports.insertImport({
      sessionId: session.sessionId,
      projectId: input.projectId,
      machineId: fp.machineId,
      harness: fp.harness,
      sourcePath: fp.sourcePath,
      sourceSessionId: fp.sourceSessionId,
      sourceMtimeMs: fp.mtimeMs,
      sourceSize: fp.size,
    });
  } catch (err) {
    const winner = imports.findImport(
      fp.machineId,
      fp.harness,
      fp.sourceSessionId,
    );
    if (!winner?.sessionId) throw err;
    await sessionStatusStore(store)?.updateSessionStatus(
      session.sessionId,
      "archived",
    );
    return {
      sessionId: winner.sessionId,
      seededEvents: 0,
      alreadyImported: true,
    };
  }
  await imports.updateRuntimeSessionRef(session.sessionId, sessionFile);
  const events = synthesizeEvents(
    input.piSession,
    input.title !== undefined ? { title: input.title } : {},
  );
  await store.appendEvents({
    sessionId: session.sessionId,
    branchId: session.rootBranchId,
    events,
  });
  if (subagent && taskId && parentSessionId) {
    const parentSession = await store.getSession(parentSessionId);
    if (!parentSession) throw new Error("imported parent session disappeared");
    await store.appendEvents({
      sessionId: parentSessionId,
      branchId: parentSession.rootBranchId,
      events: [
        {
          type: "agent.task.started",
          v: 1,
          source: { kind: "importer" },
          payload: { taskId, startedAt: header.timestamp },
        },
        {
          type: "agent.task.completed",
          v: 1,
          source: { kind: "importer" },
          payload: {
            taskId,
            resultMessageId: `import:${fp.sourceSessionId}:result`,
            summary: [],
          },
        },
      ],
    });
  }
  return {
    sessionId: session.sessionId,
    seededEvents: events.length,
    alreadyImported: false,
  };
}

function closableStore(store: EventStore): ClosableStore | null {
  return "close" in store ? (store as EventStore & ClosableStore) : null;
}

async function uploadTar(
  workspaceDir: string,
  requested: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<{ path: string; fileCount: number }> {
  if (!body) throw new Error("EMPTY_UPLOAD");
  if (isAbsolute(requested)) throw new PathViolation("path_escapes_workspace");
  const target = await resolveWorkspacePath(workspaceDir, requested, {
    forWrite: true,
  });
  const root = await resolveWorkspacePath(workspaceDir, ".");
  const rel = relative(root, target) || ".";
  // Keep archive validation and extraction off the mounted workspace Volume:
  // it is slower for short-lived metadata-heavy work than container-local SSD.
  const tmp = await mkdtemp(join(tmpdir(), "agena-upload-"));
  const archive = join(tmp, "upload.tar");
  const extractDir = join(tmp, "content");
  const stage = join(root, `.agena-upload-${basename(tmp)}`);
  try {
    await pipeline(
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(archive),
    );
    const entries = (await execOut("tar", ["-tf", archive]))
      .split("\n")
      .filter(Boolean);
    if (entries.some(unsafeTarEntry)) {
      throw new PathViolation("path_escapes_workspace");
    }
    await rejectTarLinks(archive);
    await mkdir(extractDir);
    await execOut("tar", ["-xf", archive, "-C", extractDir]);
    const fileCount = await countExtractedFiles(extractDir);
    await ensureReplaceableDirectory(target);
    await mkdir(dirname(target), { recursive: true });
    await mkdir(stage);
    await execOut("cp", ["-a", `${extractDir}/.`, stage]);
    await rename(stage, target);
    return { path: rel, fileCount };
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(tmp, { recursive: true, force: true });
  }
}

function unsafeTarEntry(entry: string): boolean {
  const cleaned = entry.replace(/^\.\//, "");
  if (!cleaned || cleaned === ".") return false;
  return (
    cleaned.includes("\0") ||
    cleaned.startsWith("/") ||
    cleaned.split("/").includes("..")
  );
}

async function ensureReplaceableDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) throw new Error("TARGET_EXISTS");
    if ((await readdir(path)).length > 0) throw new Error("TARGET_EXISTS");
    await rm(path, { recursive: true, force: true });
  } catch (err) {
    const code = err instanceof Error ? (err as { code?: string }).code : "";
    if (code !== "ENOENT") throw err;
  }
}

async function countExtractedFiles(dir: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error("UNSAFE_TAR");
    if (entry.isDirectory()) count += await countExtractedFiles(path);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

function execOut(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${cmd} failed (${code})`));
    });
  });
}

async function listWorkspaceFiles(workspaceDir: string, requested: string) {
  const dir = await resolveWorkspacePath(workspaceDir, requested);
  const info = await stat(dir);
  if (!info.isDirectory()) throw new Error("NOT_DIRECTORY");
  const names = (await readdir(dir)).sort((a, b) => a.localeCompare(b));
  const entries: FileEntry[] = [];
  for (const name of names) {
    const item = await lstat(join(dir, name));
    entries.push({
      name,
      type: fileType(item),
      size: item.size,
      mtime: item.mtime.toISOString(),
      mode: item.mode,
    });
  }
  return { entries, nextCursor: null };
}

function fileType(item: Awaited<ReturnType<typeof lstat>>): FileEntry["type"] {
  if (item.isFile()) return "file";
  if (item.isDirectory()) return "dir";
  if (item.isSymbolicLink()) return "symlink";
  return "other";
}

function fileRouteError(c: Context, err: unknown): Response {
  if (err instanceof PathViolation) {
    return c.json(
      {
        code: "PATH_ESCAPES_WORKSPACE",
        message: "path must stay inside workspace",
        retryable: false,
        details: { reason: err.reason },
      },
      403,
    );
  }
  const code = err instanceof Error ? (err as { code?: string }).code : "";
  const message = err instanceof Error ? err.message : String(err);
  if (code === "ENOENT") {
    return c.json(
      { code: "NOT_FOUND", message: "file not found", retryable: false },
      404,
    );
  }
  if (message === "NOT_FILE" || message === "NOT_DIRECTORY") {
    return c.json(
      {
        code: "INVALID_PAYLOAD",
        message:
          message === "NOT_FILE"
            ? "path is not a file"
            : "path is not a directory",
        retryable: false,
      },
      400,
    );
  }
  log("error", "file route failed", { err: message });
  return c.json(
    { code: "INTERNAL", message: "file route failed", retryable: false },
    500,
  );
}

async function rejectTarLinks(archive: string): Promise<void> {
  const verbose = (await execOut("tar", ["-tvf", archive]))
    .split("\n")
    .filter(Boolean);
  if (verbose.some((line) => line[0] === "l" || line[0] === "h")) {
    throw new Error("UNSAFE_TAR");
  }
}

function projectRouteError(c: Context, err: unknown): Response {
  if (err instanceof PathViolation) {
    return c.json(
      {
        code: "PATH_ESCAPES_WORKSPACE",
        message: "project path must stay inside workspace",
        retryable: false,
        details: { reason: err.reason },
      },
      403,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message === "INVALID_PROJECT") {
    return c.json(
      {
        code: "INVALID_PAYLOAD",
        message: "project name must contain letters or numbers",
        retryable: false,
      },
      400,
    );
  }
  if (message === "PROJECT_EXISTS") {
    return c.json(
      {
        code: "PROJECT_EXISTS",
        message: "project path already exists and is not empty",
        retryable: false,
      },
      409,
    );
  }
  log("error", "project route failed", { err: message });
  return c.json(
    { code: "INTERNAL", message: "project route failed", retryable: false },
    500,
  );
}

function uploadRouteError(c: Context, err: unknown): Response {
  if (err instanceof PathViolation) return fileRouteError(c, err);
  const message = err instanceof Error ? err.message : String(err);
  if (message === "UNSAFE_TAR") {
    return c.json(
      {
        code: "INVALID_PAYLOAD",
        message: "tar archive contains unsafe entries",
        retryable: false,
      },
      400,
    );
  }
  if (message === "EMPTY_UPLOAD") {
    return c.json(
      {
        code: "INVALID_PAYLOAD",
        message: "upload body is empty",
        retryable: false,
      },
      400,
    );
  }
  if (message === "TARGET_EXISTS") {
    return c.json(
      {
        code: "TARGET_EXISTS",
        message: "upload target already exists and is not empty",
        retryable: false,
      },
      409,
    );
  }
  log("error", "file upload failed", { err: message });
  return c.json(
    { code: "INTERNAL", message: "file upload failed", retryable: false },
    500,
  );
}
