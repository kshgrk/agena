import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEventStore } from "@agena/core";
import { afterEach, expect, test } from "vitest";
import { SessionChangesService } from "../src/session-changes.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("groups observed commits and current edits, then serves their exact text", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agena-changes-"));
  dirs.push(workspace);
  const repo = join(workspace, "repo");
  execFileSync("git", ["init", repo]);
  git(repo, "config", "user.name", "Agena Test");
  git(repo, "config", "user.email", "agena@example.test");
  const path = join(repo, "hello.txt");
  writeFileSync(path, "one\n");
  git(repo, "add", "hello.txt");
  git(repo, "commit", "-m", "baseline");

  const store = new InMemoryEventStore();
  const session = await store.createSession({
    workspaceId: "ws",
    projectRoot: "repo",
    cwd: "repo",
    title: "Git session",
  });
  const service = new SessionChangesService(workspace, store);
  await service.observe(session.sessionId, "session_resume");

  writeFileSync(path, "one\ntwo\n");
  git(repo, "add", "hello.txt");
  git(repo, "commit", "-m", "add second line");
  await service.observe(session.sessionId, "turn_completed");
  writeFileSync(path, "one\ntwo\nthree\n");

  const [summary, concurrent] = await Promise.all([
    service.get(session.sessionId),
    service.get(session.sessionId),
  ]);
  expect(concurrent).toBe(summary);
  expect(summary.worktrees).toHaveLength(1);
  const worktree = summary.worktrees[0];
  expect(worktree?.commits.map((item) => item.title)).toEqual([
    "add second line",
  ]);
  expect(worktree?.current.unstaged.map((item) => item.path)).toEqual([
    "hello.txt",
  ]);
  expect(summary.totals).toMatchObject({
    files: 1,
    additions: 2,
    deletions: 0,
  });

  const commit = worktree?.commits[0];
  expect(commit).toBeDefined();
  const committed = await service.diff(session.sessionId, {
    worktreeId: worktree?.worktreeId ?? "",
    source: "commit",
    path: "hello.txt",
    commit: commit?.oid,
  });
  expect(committed).toMatchObject({
    kind: "text",
    oldText: "one\n",
    newText: "one\ntwo\n",
  });

  const unstaged = await service.diff(session.sessionId, {
    worktreeId: worktree?.worktreeId ?? "",
    source: "unstaged",
    path: "hello.txt",
  });
  expect(unstaged).toMatchObject({
    kind: "text",
    oldText: "one\ntwo\n",
    newText: "one\ntwo\nthree\n",
  });
});
