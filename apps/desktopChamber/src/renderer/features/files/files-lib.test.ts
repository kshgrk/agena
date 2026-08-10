import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileEntry } from "@agena/protocol";
import {
  breadcrumbs,
  childPath,
  type DirState,
  fileRootForSession,
  flattenTree,
  isImagePath,
  looksBinary,
  shikiLangForPath,
  sortEntries,
  workspaceRelative,
} from "./files-lib.ts";

function entry(name: string, type: FileEntry["type"] = "file"): FileEntry {
  return { name, type, size: 10, mtime: "2026-07-11T00:00:00Z", mode: 0o644 };
}

test("workspaceRelative strips the /workspace prefix", () => {
  assert.equal(workspaceRelative("/workspace"), ".");
  assert.equal(workspaceRelative("/workspace/"), ".");
  assert.equal(workspaceRelative("/workspace/app"), "app");
  assert.equal(workspaceRelative("app/src"), "app/src");
});

test("fileRootForSession: project root when present, else workspace", () => {
  assert.equal(
    fileRootForSession({ scope: "project", projectRoot: "/workspace/app" }),
    "app",
  );
  assert.equal(fileRootForSession({ scope: "global" }), ".");
  assert.equal(fileRootForSession(null), ".");
  assert.equal(fileRootForSession({ scope: "project" }), ".");
});

test("childPath and breadcrumbs", () => {
  assert.equal(childPath(".", "src"), "src");
  assert.equal(childPath("src", "a.ts"), "src/a.ts");
  assert.deepEqual(breadcrumbs("src/a/b.ts"), ["src", "a", "b.ts"]);
  assert.deepEqual(breadcrumbs("."), ["."]);
});

test("sortEntries: dirs first, then name", () => {
  const sorted = sortEntries([
    entry("z.ts"),
    entry("lib", "dir"),
    entry("a.ts"),
    entry("app", "dir"),
  ]);
  assert.deepEqual(
    sorted.map((e) => e.name),
    ["app", "lib", "a.ts", "z.ts"],
  );
});

test("flattenTree: descends only expanded dirs, notes for state", () => {
  const dirs: Record<string, DirState> = {
    ".": {
      status: "ready",
      entries: [entry("src", "dir"), entry("empty", "dir"), entry("readme.md")],
    },
    src: { status: "ready", entries: [entry("a.ts")] },
    empty: { status: "ready", entries: [] },
  };
  const rows = flattenTree(".", dirs, new Set(["src", "empty"]));
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.path}`),
    ["dir:empty", "note:empty", "dir:src", "file:src/a.ts", "file:readme.md"],
  );
  const collapsed = flattenTree(".", dirs, new Set());
  assert.deepEqual(
    collapsed.map((r) => `${r.kind}:${r.path}`),
    ["dir:empty", "dir:src", "file:readme.md"],
  );
});

test("flattenTree: unloaded root and error dirs render notes", () => {
  assert.deepEqual(flattenTree(".", {}, new Set()), [
    { kind: "note", path: ".", depth: 0, note: "loading" },
  ]);
  const rows = flattenTree(
    ".",
    {
      ".": { status: "ready", entries: [entry("bad", "dir")] },
      bad: { status: "error", message: "nope" },
    },
    new Set(["bad"]),
  );
  assert.deepEqual(rows[1], {
    kind: "note",
    path: "bad",
    depth: 1,
    note: "error",
    message: "nope",
  });
});

test("looksBinary: NUL in the first KiB", () => {
  assert.equal(looksBinary(new TextEncoder().encode("hello world")), false);
  assert.equal(looksBinary(new Uint8Array([104, 0, 105])), true);
  const lateNul = new Uint8Array(2048);
  lateNul.fill(65);
  lateNul[2000] = 0;
  assert.equal(looksBinary(lateNul), false);
});

test("isImagePath / shikiLangForPath", () => {
  assert.ok(isImagePath("assets/logo.png"));
  assert.ok(!isImagePath("src/app.ts"));
  assert.equal(shikiLangForPath("src/app.ts"), "typescript");
  assert.equal(shikiLangForPath("src/App.tsx"), "tsx");
  assert.equal(shikiLangForPath("Dockerfile"), "docker");
  assert.equal(shikiLangForPath("Makefile"), "make");
  assert.equal(shikiLangForPath("notes.unknownext"), "text");
  assert.equal(shikiLangForPath("LICENSE"), "text");
});
