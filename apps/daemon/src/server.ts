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
import { dirname, isAbsolute, join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  ApprovalQueryStore,
  ClosableStore,
  CreateSessionInput,
  EventStore,
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
  InMemoryEventStore,
  PathViolation,
  resolveWorkspacePath,
  SessionOrchestrator,
} from "@agena/core";
import { synthesizeEvents } from "@agena/importer";
import {
  type CreateSessionRequest,
  createProjectRequestSchema,
  createPtyRequestSchema,
  createSessionRequestSchema,
  createSnapshotRequestSchema,
  type DeleteProjectResponse,
  type DiscoveryEntry,
  type FileEntry,
  fileArchiveQuerySchema,
  fileContentQuerySchema,
  fileUploadQuerySchema,
  type ImportLedgerEntry,
  importSessionRequestSchema,
  type ListSessionsQuery,
  listApprovalsQuerySchema,
  listFilesQuerySchema,
  listImportsQuerySchema,
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
import { TunnelManager } from "./tunnel-manager.ts";

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

async function createProject(workspaceDir: string, name: string) {
  const slug = projectSlug(name);
  const absolute = await resolveWorkspacePath(workspaceDir, slug, {
    forWrite: true,
  });
  try {
    const info = await lstat(absolute);
    if (!info.isDirectory()) throw new Error("PROJECT_EXISTS");
    if ((await readdir(absolute)).length > 0) throw new Error("PROJECT_EXISTS");
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
  let gateway: Gateway;
  const orchestrator = new SessionOrchestrator(store, adapter, {
    workspaceDir: config.workspaceDir,
    publishFrame: (frame) => gateway.publishFrame(frame),
    visibleBrowser: {
      request: (action) => gateway.requestVisibleBrowser(action),
    },
  });
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
        await createProject(config.workspaceDir, parsed.data.name),
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
    const imports = importStore(store);
    if (!imports) {
      return c.json(
        {
          code: "INTERNAL",
          message: "store does not support imports",
          retryable: false,
        },
        500,
      );
    }
    const fp = parsed.data.sourceFingerprint;
    const existing = imports.findImport(
      fp.machineId,
      fp.harness,
      fp.sourceSessionId,
    );
    if (existing?.sessionId) {
      return c.json({
        sessionId: existing.sessionId,
        seededEvents: 0,
        alreadyImported: true,
      });
    }
    const header = piSessionHeader(parsed.data.piSession);
    if (!header) {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "piSession must be pi v3 JSONL with a session header",
          retryable: false,
        },
        400,
      );
    }
    try {
      const scope = await validateSessionScope(config.workspaceDir, {
        scope: "project",
        projectId: parsed.data.projectId,
        projectRoot: parsed.data.projectRoot,
      });
      // Same layout SessionManager writes (`--<cwd-dashes>--/<ts>_<id>.jsonl`)
      // under the piDir the runtime adapter derives from AGENA_STATE_DIR.
      const sessionFile = join(
        config.stateDir,
        "pi",
        "sessions",
        `--${header.cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
        `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`,
      );
      await mkdir(dirname(sessionFile), { recursive: true });
      await writeFile(sessionFile, parsed.data.piSession);
      const origin =
        fp.harness === "claude"
          ? ("import.claude" as const)
          : fp.harness === "codex"
            ? ("import.codex" as const)
            : undefined; // pi sources are already pi-native
      const session = await store.createSession({
        workspaceId: "default",
        ...(parsed.data.title !== undefined
          ? { title: parsed.data.title }
          : {}),
        scope: "project",
        cwd: scope.cwd,
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
        ...(scope.projectRoot ? { projectRoot: scope.projectRoot } : {}),
        source: { kind: "importer" },
        ...(origin ? { origin } : {}),
      });
      // Claim the fingerprint right after creating the session: a concurrent
      // duplicate POST loses on UNIQUE(machine_id, harness, source_session_id)
      // here, and a later failure (event seeding) still leaves the ledger row,
      // so a retry dedupes instead of duplicating the session.
      // ponytail: not one transaction — a crash between createSession and this
      // insert can orphan one session; a store-level import txn fixes it.
      try {
        imports.insertImport({
          sessionId: session.sessionId,
          projectId: parsed.data.projectId,
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
        // lost the race — hide the extra session and defer to the winner
        await sessionStatusStore(store)?.updateSessionStatus(
          session.sessionId,
          "archived",
        );
        return c.json({
          sessionId: winner.sessionId,
          seededEvents: 0,
          alreadyImported: true,
        });
      }
      await imports.updateRuntimeSessionRef(session.sessionId, sessionFile);
      const events = synthesizeEvents(
        parsed.data.piSession,
        parsed.data.title !== undefined ? { title: parsed.data.title } : {},
      );
      await store.appendEvents({
        sessionId: session.sessionId,
        branchId: session.rootBranchId,
        events,
      });
      return c.json(
        {
          sessionId: session.sessionId,
          seededEvents: events.length,
          alreadyImported: false,
        },
        201,
      );
    } catch (err) {
      if (err instanceof Error && err.message === "INVALID_CWD") {
        return c.json(
          {
            code: "INVALID_PAYLOAD",
            message: "projectRoot must exist under /workspace",
            retryable: false,
          },
          400,
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
    if (!tokenOk(req.headers.authorization, config.token)) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    const path = (req.url ?? "").split("?")[0] ?? "";
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
  const tmp = await mkdtemp(join(root, ".agena-upload-"));
  const archive = join(tmp, "upload.tar");
  const extractDir = join(tmp, "content");
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
    await rename(extractDir, target);
    return { path: rel, fileCount };
  } finally {
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
