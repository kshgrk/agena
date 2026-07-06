// Composition root + transport (§9.1/§9.2 M1 subset): InMemoryEventStore (P8),
// SessionOrchestrator, WS gateway, and one Node http.Server shared by the Hono
// app (GET /health) and the /v1/ws upgrade. Bearer auth is checked BEFORE the
// upgrade completes — failure is a raw HTTP 401, never a WS close code (§9.4).
import { timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import type { EventStore, RuntimeAdapter } from "@agena/core";
import { InMemoryEventStore, SessionOrchestrator } from "@agena/core";
import {
  createPtyRequestSchema,
  PROTOCOL_VERSION,
  WS_PATH,
} from "@agena/protocol";
import { SqliteEventStore } from "@agena/storage-sqlite";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { DaemonConfig } from "./config.ts";
import { DAEMON_VERSION, Gateway } from "./gateway.ts";
import { log } from "./log.ts";
import { PtyManager } from "./pty-manager.ts";

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

  // §9.3 session routes (M1 subset: create + list — what `agena` needs to boot).
  // ponytail: GET/PATCH /v1/sessions/:id, /events cold read, list filters land M2.
  app.use("/v1/*", async (c, next) => {
    if (!tokenOk(c.req.header("authorization"), config.token)) {
      return c.json(
        { code: "UNAUTHORIZED", message: "invalid token", retryable: false },
        401,
      );
    }
    await next();
  });
  app.post("/v1/sessions", async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}));
    const title = (body as { title?: unknown } | null)?.title;
    if (title !== undefined && typeof title !== "string") {
      return c.json(
        {
          code: "INVALID_PAYLOAD",
          message: "title must be a string",
          retryable: false,
        },
        400,
      );
    }
    // ponytail: single implicit workspace in M1; real workspaceId with M2's state tree
    const session = await orchestrator.createSession({
      workspaceId: "default",
      ...(title === undefined ? {} : { title }),
    });
    return c.json({ sessionId: session.sessionId }, 201);
  });
  app.get("/v1/sessions", async (c) =>
    c.json({ sessions: await store.listSessions() }),
  );
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
