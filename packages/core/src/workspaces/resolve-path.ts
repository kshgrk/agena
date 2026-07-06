import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export class PathViolation extends Error {
  readonly reason: "path_invalid" | "path_escapes_workspace";

  constructor(reason: "path_invalid" | "path_escapes_workspace") {
    super(reason);
    this.name = "PathViolation";
    this.reason = reason;
  }
}

export async function resolveWorkspacePath(
  root: string,
  requested: string,
  _opts: { forWrite?: boolean } = {},
): Promise<string> {
  if (
    typeof requested !== "string" ||
    requested.length === 0 ||
    requested.includes("\0")
  ) {
    throw new PathViolation("path_invalid");
  }

  const parts = requested.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.includes("..")) {
    throw new PathViolation("path_escapes_workspace");
  }

  const workspaceRoot = await realpath(root);
  const candidate = resolve(workspaceRoot, ...parts);
  assertInside(workspaceRoot, candidate);

  const anchor = await realpathDeepestExistingAncestor(candidate);
  assertInside(workspaceRoot, anchor);

  try {
    const final = await realpath(candidate);
    assertInside(workspaceRoot, final);
  } catch {
    // Nonexistent leaf is fine for future write routes; ancestors were checked.
  }

  return candidate;
}

async function realpathDeepestExistingAncestor(path: string): Promise<string> {
  let cursor = path;
  for (;;) {
    try {
      await lstat(cursor);
      return realpath(cursor);
    } catch (err) {
      const code = err instanceof Error ? (err as { code?: string }).code : "";
      if (code !== "ENOENT") throw err;
      const parent = dirname(cursor);
      if (parent === cursor) throw err;
      cursor = parent;
    }
  }
}

function assertInside(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new PathViolation("path_escapes_workspace");
}
