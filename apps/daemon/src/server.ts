// Composition root + transport (§9.1/§9.2 M1 subset): InMemoryEventStore (P8),
// SessionOrchestrator, WS gateway, and one Node http.Server shared by the Hono
// app (GET /health) and the /v1/ws upgrade. Bearer auth is checked BEFORE the
// upgrade completes — failure is a raw HTTP 401, never a WS close code (§9.4).

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import type { Server } from "node:http";
import { join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import type {
  CreateSessionInput,
  EventStore,
  RuntimeAdapter,
  SessionFilter,
  SessionRecord,
} from "@agena/core";
import {
  InMemoryEventStore,
  PathViolation,
  resolveWorkspacePath,
  SessionOrchestrator,
} from "@agena/core";
import {
  type CreateSessionRequest,
  createPtyRequestSchema,
  createSessionRequestSchema,
  createSnapshotRequestSchema,
  type DiscoveryEntry,
  type FileEntry,
  fileArchiveQuerySchema,
  fileContentQuerySchema,
  type ListSessionsQuery,
  listApprovalsQuerySchema,
  listFilesQuerySchema,
  listSessionsQuerySchema,
  PROTOCOL_VERSION,
  restoreSnapshotRequestSchema,
  searchQuerySchema,
  updateSessionStatusRequestSchema,
  WS_PATH,
} from "@agena/protocol";
import { SqliteEventStore } from "@agena/storage-sqlite";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import type { DaemonConfig } from "./config.ts";
import { DAEMON_VERSION, Gateway } from "./gateway.ts";
import { log } from "./log.ts";
import { PtyManager } from "./pty-manager.ts";
import { SnapshotManager } from "./snapshots.ts";

export interface Daemon {
  port: number;
  /** Exposed for tests/demo (in-process session setup + assertions). */
  store: EventStore;
  orchestrator: SessionOrchestrator;
  close(): Promise<void>;
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function validateSessionScope(
  workspaceDir: string,
  input: CreateSessionRequest,
): {
  scope: CreateSessionRequest["scope"];
  projectId?: string;
  projectRoot?: string;
  cwd: string;
  hostCwdHint?: string;
} {
  if (input.scope !== "project") {
    return {
      scope: input.scope,
      cwd: workspaceRelative(workspaceDir, input.cwd ?? "."),
      ...(input.hostCwdHint ? { hostCwdHint: input.hostCwdHint } : {}),
    };
  }
  if (!input.projectId || !input.projectRoot) throw new Error("INVALID_CWD");
  const projectRoot = workspaceRelative(workspaceDir, input.projectRoot);
  const cwd = workspaceRelative(workspaceDir, input.cwd ?? projectRoot);
  const workspaceRoot = realpathSync(workspaceDir);
  const projectAbs = realpathSync(resolve(workspaceRoot, projectRoot));
  const cwdAbs = realpathSync(resolve(workspaceRoot, cwd));
  if (cwdAbs !== projectAbs && !cwdAbs.startsWith(`${projectAbs}/`)) {
    throw new Error("INVALID_CWD");
  }
  return {
    scope: "project",
    projectId: input.projectId,
    projectRoot,
    cwd,
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

function workspaceRelative(workspaceDir: string, path: string): string {
  try {
    const root = realpathSync(workspaceDir);
    const abs = realpathSync(resolve(root, path));
    if (abs !== root && !abs.startsWith(`${root}/`)) {
      throw new Error("INVALID_CWD");
    }
    if (!statSync(abs).isDirectory()) throw new Error("INVALID_CWD");
    const rel = relative(root, abs);
    return rel === "" ? "." : rel;
  } catch {
    throw new Error("INVALID_CWD");
  }
}

const EXTENSION_NAME_RE = /^[a-z0-9_]{1,64}$/;

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

export async function startDaemon(
  config: DaemonConfig,
  adapter: RuntimeAdapter,
): Promise<Daemon> {
  const store: EventStore =
    config.storage === "sqlite"
      ? new SqliteEventStore(join(config.stateDir, "db", "agena.db"))
      : new InMemoryEventStore();
  // `gateway` is initialized before any frame can be published (frames only
  // flow after a prompt), so the closure is safe.
  const orchestrator = new SessionOrchestrator(store, adapter, {
    workspaceDir: config.workspaceDir,
    publishFrame: (frame) => gateway.publishFrame(frame),
  });
  const gateway = new Gateway(store, orchestrator);
  const ptys = new PtyManager(store, config.workspaceDir);
  const controlSession = await ensureControlSession(store);
  const snapshots = new SnapshotManager(
    store,
    config.workspaceDir,
    config.stateDir,
    controlSession,
  );
  await snapshots.recoverJournal();
  if (store.reconcileOpenWork) {
    const report = await store.reconcileOpenWork();
    if (report.appended > 0) {
      log("warn", "reconciled open work after restart", { ...report });
    }
  }

  const startedAt = Date.now();
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

  // §9.3 session routes.
  // ponytail: GET/PATCH /v1/sessions/:id lands with richer session management.
  app.use("/v1/*", async (c, next) => {
    if (!tokenOk(c.req.header("authorization"), config.token)) {
      return c.json(
        { code: "UNAUTHORIZED", message: "invalid token", retryable: false },
        401,
      );
    }
    await next();
  });
  app.get("/v1/diagnostics", async (c) =>
    c.json({
      daemon: { version: DAEMON_VERSION, uptimeMs: Date.now() - startedAt },
      protocol: { version: PROTOCOL_VERSION },
      workspace: { path: config.workspaceDir },
      discovery: await discoverAgena(config.workspaceDir),
    }),
  );
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
      const scope = validateSessionScope(config.workspaceDir, parsed.data);
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
      sessions: await store.listSessions(sessionFilter(parsed.data)),
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
    if (!store.search) {
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
      hits: await store.search(parsed.data.q, {
        limit: parsed.data.limit,
        ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
        ...(parsed.data.projectId ? { projectId: parsed.data.projectId } : {}),
        ...(parsed.data.allProjects !== undefined
          ? { allProjects: parsed.data.allProjects }
          : {}),
      }),
    });
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
    if (!store.updateSessionStatus) {
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
      await store.updateSessionStatus(c.req.param("id"), parsed.data.status);
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
    if (!store.listPendingApprovals) {
      return c.json({ approvals: [] });
    }
    return c.json({
      approvals: await store.listPendingApprovals({ allProjects: true }),
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
    if (!store.rebuildProjections) {
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
    return c.json(await store.rebuildProjections(body.sessionId));
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
    if (!tokenOk(req.headers.authorization, config.token)) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    const path = (req.url ?? "").split("?")[0] ?? "";
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
  if (store.close) await store.close();
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
