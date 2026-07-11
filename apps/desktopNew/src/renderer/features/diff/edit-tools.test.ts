import assert from "node:assert/strict";
import { test } from "node:test";
import type { Block, ToolBlock } from "../../store/types.ts";
import {
  isEditToolName,
  listFileEdits,
  parseEditArgs,
} from "./edit-tools.ts";

test("isEditToolName gates on edit-ish names only", () => {
  assert.ok(isEditToolName("edit"));
  assert.ok(isEditToolName("Edit"));
  assert.ok(isEditToolName("str_replace_editor"));
  assert.ok(isEditToolName("write_file"));
  assert.ok(isEditToolName("apply_patch"));
  assert.ok(!isEditToolName("bash"));
  assert.ok(!isEditToolName("read"));
  assert.ok(!isEditToolName("grep"));
});

test("parseEditArgs: old/new string pair", () => {
  const edit = parseEditArgs("edit", {
    file_path: "src/a.ts",
    old_string: "const x = 1;",
    new_string: "const x = 2;",
  });
  assert.deepEqual(edit, {
    path: "src/a.ts",
    kind: "text",
    oldText: "const x = 1;",
    newText: "const x = 2;",
  });
});

test("parseEditArgs: camelCase pair and path key variants", () => {
  const edit = parseEditArgs("edit", {
    path: "b.ts",
    oldText: "a",
    newText: "b",
  });
  assert.deepEqual(edit, { path: "b.ts", kind: "text", oldText: "a", newText: "b" });
});

test("parseEditArgs: multi-edit stacks pairs", () => {
  const edit = parseEditArgs("multi_edit", {
    filePath: "c.ts",
    edits: [
      { old_string: "one", new_string: "uno" },
      { old_string: "two", new_string: "dos" },
      { bogus: true },
    ],
  });
  assert.deepEqual(edit, {
    path: "c.ts",
    kind: "text",
    oldText: "one\ntwo",
    newText: "uno\ndos",
  });
});

test("parseEditArgs: unified patch with @@ headers passes through as hunks", () => {
  const patch = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "@@ -9,1 +9,1 @@",
    "-nine",
    "+9",
  ].join("\n");
  const edit = parseEditArgs("edit", { path: "x.ts", patch });
  assert.deepEqual(edit, {
    path: "x.ts",
    kind: "patch",
    hunks: ["@@ -1,2 +1,2 @@\n keep\n-old\n+new", "@@ -9,1 +9,1 @@\n-nine\n+9"],
  });
});

test("parseEditArgs: headerless patch body becomes old/new texts", () => {
  const edit = parseEditArgs("edit", {
    path: "ci.yml",
    patch: "-      - run: npm ci\n+      - run: pnpm install",
  });
  assert.deepEqual(edit, {
    path: "ci.yml",
    kind: "text",
    oldText: "      - run: npm ci",
    newText: "      - run: pnpm install",
  });
});

test("parseEditArgs: write tool content is a from-empty diff", () => {
  const edit = parseEditArgs("write", { path: "new.txt", content: "hello\n" });
  assert.deepEqual(edit, {
    path: "new.txt",
    kind: "text",
    oldText: "",
    newText: "hello\n",
  });
});

test("parseEditArgs: rejects non-edit tools, missing path, junk args", () => {
  assert.equal(parseEditArgs("bash", { command: "ls" }), null);
  assert.equal(parseEditArgs("edit", { old_string: "a", new_string: "b" }), null);
  assert.equal(parseEditArgs("edit", null), null);
  assert.equal(parseEditArgs("edit", "path"), null);
  assert.equal(parseEditArgs("edit", { path: "a.ts" }), null);
});

function toolBlock(over: Partial<ToolBlock>): ToolBlock {
  return {
    kind: "tool",
    seq: 1,
    at: "2026-07-11T00:00:00Z",
    source: { kind: "user" } as ToolBlock["source"],
    toolCallId: "t1",
    name: "edit",
    args: {},
    status: "completed",
    liveOutput: "",
    ...over,
  };
}

test("listFileEdits: newest first, skips denied and non-edits", () => {
  const blocks: Block[] = [
    toolBlock({
      seq: 1,
      toolCallId: "a",
      args: { path: "one.ts", old_string: "x", new_string: "y" },
    }),
    toolBlock({ seq: 2, toolCallId: "b", name: "bash", args: { command: "ls" } }),
    toolBlock({
      seq: 3,
      toolCallId: "c",
      status: "denied",
      args: { path: "no.ts", old_string: "x", new_string: "y" },
    }),
    toolBlock({
      seq: 4,
      toolCallId: "d",
      args: { path: "two.ts", old_string: "p", new_string: "q" },
    }),
  ];
  const items = listFileEdits(blocks);
  assert.deepEqual(
    items.map((i) => i.block.toolCallId),
    ["d", "a"],
  );
  assert.equal(items[0]!.edit.path, "two.ts");
});
