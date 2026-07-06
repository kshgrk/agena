import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  PathViolation,
  resolveWorkspacePath,
} from "../src/workspaces/resolve-path.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agena-path-"));
  dirs.push(dir);
  return dir;
}

test("resolves ordinary workspace paths and rejects escapes", async () => {
  const root = tempDir();
  mkdirSync(join(root, "repo"), { recursive: true });
  writeFileSync(join(root, "repo", "a.txt"), "hi");

  await expect(resolveWorkspacePath(root, "repo/a.txt")).resolves.toBe(
    join(realpathSync(root), "repo", "a.txt"),
  );
  await expect(resolveWorkspacePath(root, "../outside")).rejects.toBeInstanceOf(
    PathViolation,
  );
});

test("rejects symlink escapes", async () => {
  const root = tempDir();
  const outside = tempDir();
  mkdirSync(join(root, "repo"), { recursive: true });
  symlinkSync(outside, join(root, "repo", "outside"));

  await expect(
    resolveWorkspacePath(root, "repo/outside/file.txt"),
  ).rejects.toMatchObject({ reason: "path_escapes_workspace" });
});
