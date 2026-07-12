// Plan §6 end-to-end: POST a converted pi session, see a resumable session row,
// seeded events, live projections, and idempotent re-import via the ledger.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeRuntimeAdapter } from "@agena/core/testing";
import type { SqliteEventStore } from "@agena/storage-sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { startDaemon } from "../src/server.ts";

// ponytail: mock until M1 lands the real synthesizeEvents; this test owns the
// daemon flow (route → file → session → events → ledger), not the converter.
vi.mock("@agena/importer", () => ({
  synthesizeEvents: (_piJsonl: string, meta: { title?: string }) => [
    ...(meta.title
      ? [
          {
            type: "session.title.changed",
            v: 1,
            source: { kind: "importer" },
            payload: { title: meta.title },
          },
        ]
      : []),
    {
      type: "message.user.created",
      v: 1,
      source: { kind: "importer" },
      payload: {
        messageId: "imp-msg-1",
        content: [{ type: "text", text: "hello import" }],
      },
    },
  ],
}));

const TOKEN = "test-token";
const dirs: string[] = [];
let closeDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeDaemon?.();
  closeDaemon = undefined;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

test("imports a pi session, seeds events, and dedupes re-imports", async () => {
  const workspaceDir = tempDir("agena-import-ws-");
  const stateDir = tempDir("agena-import-state-");
  mkdirSync(join(workspaceDir, "proj"));
  const daemon = await startDaemon(
    {
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      runtime: "fake",
      workspaceDir,
      stateDir,
      storage: "sqlite",
    },
    new FakeRuntimeAdapter(),
  );
  closeDaemon = () => daemon.close();

  const piSession = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-src-1",
      timestamp: "2026-01-02T03:04:05.678Z",
      cwd: "/workspace/proj",
    }),
    JSON.stringify({ type: "message", id: "e1", parentId: null }),
  ].join("\n");
  const body = {
    projectId: "prj_proj",
    projectRoot: "proj",
    title: "Imported chat",
    sourceFingerprint: {
      harness: "claude",
      machineId: "machine-1",
      sourcePath: "/home/u/.claude/projects/p/s.jsonl",
      sourceSessionId: "src-1",
      mtimeMs: 123,
      size: piSession.length,
    },
    piSession,
  };
  const url = `http://127.0.0.1:${daemon.port}/v1/imports/session`;
  const post = () =>
    fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const first = await post();
  expect(first.status).toBe(201);
  const created = (await first.json()) as {
    sessionId: string;
    seededEvents: number;
    alreadyImported: boolean;
  };
  expect(created.alreadyImported).toBe(false);
  expect(created.seededEvents).toBe(2);

  // pi JSONL landed where SessionManager expects it, and the session row
  // points at it (resume path).
  const sessionFile = join(
    stateDir,
    "pi",
    "sessions",
    "--workspace-proj--",
    "2026-01-02T03-04-05-678Z_pi-src-1.jsonl",
  );
  expect(existsSync(sessionFile)).toBe(true);
  const session = await daemon.store.getSession(created.sessionId);
  expect(session?.runtimeSessionRef).toBe(sessionFile);
  expect(session?.title).toBe("Imported chat");

  // session.created + 2 seeded events; messages projection is searchable.
  const page = await daemon.store.readEvents(created.sessionId, 0);
  expect(page.events.length).toBe(3);
  expect(page.events[0]?.payload).toMatchObject({ origin: "import.claude" });
  const hits = await (daemon.store as SqliteEventStore).search("hello import");
  expect(hits.some((h) => h.sessionId === created.sessionId)).toBe(true);

  // Idempotent re-import: same fingerprint returns the existing session.
  const second = await post();
  expect(second.status).toBe(200);
  const dup = (await second.json()) as {
    sessionId: string;
    seededEvents: number;
    alreadyImported: boolean;
  };
  expect(dup).toEqual({
    sessionId: created.sessionId,
    seededEvents: 0,
    alreadyImported: true,
  });
  expect(
    (await daemon.store.readEvents(created.sessionId, 0)).events.length,
  ).toBe(3);

  const childPiSession = piSession.replace("pi-src-1", "pi-child-1");
  const childBody = {
    ...body,
    title: "Security review",
    sourceFingerprint: {
      ...body.sourceFingerprint,
      sourcePath: "/home/u/.claude/projects/p/src-1/subagents/agent-1.jsonl",
      sourceSessionId: "agent-1",
      size: childPiSession.length,
    },
    subagent: {
      parentSourceSessionId: "src-1",
      agentId: "agent-1",
      role: "security",
      task: "Review authentication",
      execution: "foreground",
      model: { provider: "anthropic", id: "claude" },
    },
    piSession: childPiSession,
  };
  const childResponse = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(childBody),
  });
  expect(childResponse.status).toBe(201);
  const child = (await childResponse.json()) as { sessionId: string };
  expect(await daemon.store.getSession(child.sessionId)).toMatchObject({
    sessionKind: "subagent",
    origin: "import.claude",
    parentSessionId: created.sessionId,
  });
  expect(
    (daemon.store as SqliteEventStore).getAgentTask("import:claude:agent-1"),
  ).toMatchObject({
    childSessionId: child.sessionId,
    status: "completed",
    role: "security",
  });

  // Ledger listing, filtered by machine.
  const list = async (qs: string) =>
    (await (
      await fetch(`http://127.0.0.1:${daemon.port}/v1/imports${qs}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as { imports: Array<Record<string, unknown>> };
  const mine = await list("?machineId=machine-1");
  expect(mine.imports).toHaveLength(2);
  expect(mine.imports[0]).toMatchObject({
    sessionId: created.sessionId,
    projectId: "prj_proj",
    machineId: "machine-1",
    harness: "claude",
    sourceSessionId: "src-1",
  });
  expect((await list("?machineId=other")).imports).toHaveLength(0);
  expect((await list("")).imports).toHaveLength(2);

  // Full project teardown: rows, ledger, pi file, workspace dir — and the
  // fingerprint is importable again afterwards.
  const del = await fetch(
    `http://127.0.0.1:${daemon.port}/v1/projects/prj_proj`,
    { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } },
  );
  expect(del.status).toBe(200);
  expect(await del.json()).toEqual({
    projectId: "prj_proj",
    deletedSessions: 2,
  });
  expect(await daemon.store.getSession(created.sessionId)).toBeNull();
  expect((await list("")).imports).toHaveLength(0);
  expect(existsSync(sessionFile)).toBe(false);
  expect(existsSync(join(workspaceDir, "proj"))).toBe(false);
  expect(
    (
      await fetch(`http://127.0.0.1:${daemon.port}/v1/projects/prj_proj`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    ).status,
  ).toBe(404);

  mkdirSync(join(workspaceDir, "proj")); // the real flow re-runs createProject first
  const third = await post();
  expect(third.status).toBe(201);
  const fresh = (await third.json()) as { alreadyImported: boolean };
  expect(fresh.alreadyImported).toBe(false);
});
