// Fake /workspace/repo-a file tree served by listFiles/readFile and the fake pty.
import type { FileEntry } from "@agena/protocol";

export type FixtureFile = { type: "file"; content: string };
export type FixtureDir = { type: "dir"; children: Record<string, FixtureNode> };
export type FixtureNode = FixtureFile | FixtureDir;

export const REPO_ROOT = "/workspace/repo-a";
const MTIME = "2026-07-05T18:20:00.000Z";

const PACKAGE_JSON = `{
  "name": "repo-a",
  "private": true,
  "version": "0.4.2",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest",
    "lint": "biome check ."
  },
  "dependencies": {
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
`;

const README_MD = `# repo-a

Internal auth service playground. Sessions, refresh tokens, and the
occasional flaky test that keeps CI interesting.

## Quick start

\`\`\`sh
pnpm install
pnpm dev
\`\`\`

## Testing

\`\`\`sh
pnpm test          # watch mode
pnpm test --run    # single pass (what CI does)
\`\`\`

Auth internals live in \`src/auth\`. Refresh is time-sensitive — if you touch
\`session.ts\`, run the suite at least twice; the old race only showed up
under load.
`;

const VITE_CONFIG = `import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2023",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
`;

const SESSION_TS = `// Session lifecycle: issue, refresh, revoke. Times are epoch ms.
import { z } from "zod";

export const sessionSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  refreshToken: z.string().min(32),
});
export type Session = z.infer<typeof sessionSchema>;

const SESSION_TTL_MS = 3_600_000; // 1h
const REFRESH_GRACE_MS = 30_000;

export type Clock = { now(): number };
export const systemClock: Clock = { now: () => Date.now() };

type Store = Map<string, Session>;
const sessions: Store = new Map();

// Serializes refreshes per session id: two concurrent refreshes for the same
// session must not both mint tokens (that was the CI race).
const refreshLocks = new Map<string, Promise<Session>>();

export function issueSession(userId: string, clock: Clock = systemClock): Session {
  const now = clock.now();
  const session: Session = {
    id: cryptoRandomId(),
    userId,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS,
    refreshToken: cryptoRandomId() + cryptoRandomId(),
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): Session | null {
  return sessions.get(id) ?? null;
}

export async function refreshSession(
  id: string,
  token: string,
  clock: Clock = systemClock,
): Promise<Session> {
  const inFlight = refreshLocks.get(id);
  if (inFlight) return inFlight;

  const work = doRefresh(id, token, clock).finally(() => {
    refreshLocks.delete(id);
  });
  refreshLocks.set(id, work);
  return work;
}

async function doRefresh(id: string, token: string, clock: Clock): Promise<Session> {
  const current = sessions.get(id);
  if (!current) throw new Error("session not found");
  if (current.refreshToken !== token) throw new Error("bad refresh token");

  const now = clock.now();
  if (now > current.expiresAt + REFRESH_GRACE_MS) {
    sessions.delete(id);
    throw new Error("session expired");
  }

  const next: Session = {
    ...current,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS,
    refreshToken: cryptoRandomId() + cryptoRandomId(),
  };
  sessions.set(id, next);
  return next;
}

export function revokeSession(id: string): boolean {
  return sessions.delete(id);
}

export function activeSessionCount(): number {
  return sessions.size;
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
`;

const SESSION_TEST_TS = `import { describe, expect, it } from "vitest";
import { issueSession, refreshSession, revokeSession, type Clock } from "./session.ts";

const fixedClock = (start: number): Clock & { advance(ms: number): void } => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

describe("session refresh", () => {
  it("extends expiry by a full ttl", async () => {
    const clock = fixedClock(1_000_000);
    const s = issueSession("u1", clock);
    clock.advance(1_800_000);
    const next = await refreshSession(s.id, s.refreshToken, clock);
    expect(next.expiresAt).toBeGreaterThan(clock.now() + 3_599_000);
  });

  it("only one of two concurrent refreshes mints tokens", async () => {
    const clock = fixedClock(1_000_000);
    const s = issueSession("u2", clock);
    const [a, b] = await Promise.all([
      refreshSession(s.id, s.refreshToken, clock),
      refreshSession(s.id, s.refreshToken, clock),
    ]);
    expect(a.refreshToken).toBe(b.refreshToken);
  });

  it("rejects a revoked session", async () => {
    const s = issueSession("u3");
    revokeSession(s.id);
    await expect(refreshSession(s.id, s.refreshToken)).rejects.toThrow("not found");
  });
});
`;

export const repoTree: FixtureDir = {
  type: "dir",
  children: {
    "package.json": { type: "file", content: PACKAGE_JSON },
    "README.md": { type: "file", content: README_MD },
    "vite.config.ts": { type: "file", content: VITE_CONFIG },
    src: {
      type: "dir",
      children: {
        auth: {
          type: "dir",
          children: {
            "session.ts": { type: "file", content: SESSION_TS },
            "session.test.ts": { type: "file", content: SESSION_TEST_TS },
          },
        },
      },
    },
  },
};

/** The fake /workspace: repo-a plus any folders "copied in" via ⌘O. */
const workspace: FixtureDir = {
  type: "dir",
  children: { "repo-a": repoTree },
};

/** Ingest a host folder capture as /workspace/<name> (⌘O copy simulation). */
export function addWorkspaceFolder(
  name: string,
  files: Array<{ path: string; size: number; text: string | null }>,
): void {
  const dir: FixtureDir = { type: "dir", children: {} };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    const leaf = parts.pop();
    if (!leaf) continue;
    let node = dir;
    for (const part of parts) {
      const next = node.children[part];
      if (next?.type === "dir") {
        node = next;
      } else {
        const created: FixtureDir = { type: "dir", children: {} };
        node.children[part] = created;
        node = created;
      }
    }
    node.children[leaf] = {
      type: "file",
      content:
        f.text ??
        `«binary or large file (${f.size} bytes) — not copied in mock»\n`,
    };
  }
  workspace.children[name] = dir;
}

function walk(root: FixtureDir, rel: string): FixtureNode | null {
  let node: FixtureNode = root;
  for (const part of rel.split("/")) {
    if (node.type !== "dir") return null;
    const child: FixtureNode | undefined = node.children[part];
    if (!child) return null;
    node = child;
  }
  return node;
}

/**
 * "." | "/workspace" → the workspace root (project folders); absolute
 * /workspace/<x> paths walk from there. Bare relative paths keep resolving
 * against repo-a first for back-compat (fake pty cwd), then the workspace.
 */
export function nodeAt(path: string): FixtureNode | null {
  const clean = (s: string) => s.replace(/^\.?\/*/, "").replace(/\/+$/, "");
  if (path.startsWith("/workspace")) {
    const rel = clean(path.slice("/workspace".length));
    return rel === "" ? workspace : walk(workspace, rel);
  }
  const rel = clean(path);
  if (rel === "" || rel === ".") return workspace;
  return walk(repoTree, rel) ?? walk(workspace, rel);
}

export function listDir(path: string): FileEntry[] | null {
  const node = nodeAt(path);
  if (node?.type !== "dir") return null;
  return Object.entries(node.children).map(([name, child]) => ({
    name,
    type: child.type === "dir" ? ("dir" as const) : ("file" as const),
    size: child.type === "file" ? child.content.length : 0,
    mtime: MTIME,
    mode: child.type === "dir" ? 0o755 : 0o644,
  }));
}

export function readFixtureFile(path: string): string | null {
  const node = nodeAt(path);
  return node?.type === "file" ? node.content : null;
}
