import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillContentHash, skillIdentity } from "@agena/importer/skills";
import { SqliteEventStore } from "@agena/storage-sqlite";
import { afterEach, expect, test } from "vitest";
import { SkillService } from "../src/skill-service.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("validates and atomically installs a binary-safe skill package", async () => {
  const state = mkdtempSync(join(tmpdir(), "agena-skill-"));
  dirs.push(state);
  const store = new SqliteEventStore(join(state, "db", "agena.db"));
  const service = new SkillService(store, state);
  const manifest =
    "---\nname: example\ndescription: Example\n---\nUse this skill.\n";
  const files = [
    {
      path: "SKILL.md",
      contentBase64: Buffer.from(manifest).toString("base64"),
    },
    {
      path: "assets/data.bin",
      contentBase64: Buffer.from([0, 255, 1]).toString("base64"),
    },
  ];
  const skill = await service.import({
    identity: skillIdentity({ contentHash: skillContentHash(files) }),
    name: "example",
    description: "Example",
    files,
  });

  expect(skill).toMatchObject({ name: "example", status: "ready" });
  expect(skill.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(readFileSync(join(service.root, skill.id, "assets/data.bin"))).toEqual(
    Buffer.from([0, 255, 1]),
  );
  expect(existsSync(join(service.root, skill.id, "SKILL.md"))).toBe(true);
  expect(service.list()).toHaveLength(1);
  store.close();
});

test("rejects package paths that escape the installed skill", async () => {
  const state = mkdtempSync(join(tmpdir(), "agena-skill-"));
  dirs.push(state);
  const store = new SqliteEventStore(join(state, "db", "agena.db"));
  const service = new SkillService(store, state);
  await expect(
    service.import({
      identity: "bad",
      name: "bad",
      description: "Bad",
      files: [
        {
          path: "../SKILL.md",
          contentBase64: Buffer.from("bad").toString("base64"),
        },
      ],
    }),
  ).rejects.toThrow("invalid skill file path");
  store.close();
});

test("removes staged files when the registry write fails", async () => {
  const state = mkdtempSync(join(tmpdir(), "agena-skill-"));
  dirs.push(state);
  const store = new SqliteEventStore(join(state, "db", "agena.db"));
  const service = new SkillService(store, state);
  Object.defineProperty(store, "upsertSkill", {
    value: () => {
      throw new Error("database unavailable");
    },
  });
  const content = Buffer.from(
    "---\nname: example\ndescription: Example\n---\n",
  ).toString("base64");
  await expect(
    service.import({
      identity: skillIdentity({
        contentHash: skillContentHash([
          { path: "SKILL.md", contentBase64: content },
        ]),
      }),
      name: "example",
      description: "Example",
      files: [{ path: "SKILL.md", contentBase64: content }],
    }),
  ).rejects.toThrow("database unavailable");
  expect(readdirSync(service.root)).toEqual([]);
  store.close();
});

test("checks and atomically updates a Git-backed skill", async () => {
  const state = mkdtempSync(join(tmpdir(), "agena-skill-"));
  const repo = mkdtempSync(join(tmpdir(), "agena-skill-repo-"));
  dirs.push(state, repo);
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  run("init");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  const writeManifest = (description: string) =>
    writeFileSync(
      join(repo, "SKILL.md"),
      `---\nname: example\ndescription: ${description}\n---\nUse it.\n`,
    );
  writeManifest("First");
  run("add", "SKILL.md");
  run("commit", "-m", "first");
  const firstRevision = run("rev-parse", "HEAD");
  const sourceUrl = new URL(`file://${repo}`).toString();
  const contentBase64 = readFileSync(join(repo, "SKILL.md")).toString("base64");
  const files = [{ path: "SKILL.md", contentBase64 }];
  const identity = skillIdentity({
    contentHash: skillContentHash(files),
    sourceUrl,
  });
  const store = new SqliteEventStore(join(state, "db", "agena.db"));
  const service = new SkillService(store, state);
  const imported = await service.import({
    identity,
    name: "example",
    description: "First",
    source: { url: sourceUrl, revision: firstRevision },
    files,
  });

  expect(
    (await service.checkAll()).find((skill) => skill.id === imported.id)
      ?.status,
  ).toBe("ready");
  writeManifest("Second");
  run("add", "SKILL.md");
  run("commit", "-m", "second");
  expect(
    (await service.checkAll()).find((skill) => skill.id === imported.id)
      ?.status,
  ).toBe("update_available");
  expect(await service.update(imported.id)).toMatchObject({
    description: "Second",
    status: "ready",
  });
  store.close();
});

test("rejects a Git source path symlink that escapes its checkout", async () => {
  const state = mkdtempSync(join(tmpdir(), "agena-skill-"));
  const repo = mkdtempSync(join(tmpdir(), "agena-skill-repo-"));
  const outside = mkdtempSync(join(tmpdir(), "agena-skill-outside-"));
  dirs.push(state, repo, outside);
  writeFileSync(
    join(outside, "SKILL.md"),
    "---\nname: example\ndescription: Example\n---\n",
  );
  symlinkSync(outside, join(repo, "linked"));
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  run("init");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("add", "linked");
  run("commit", "-m", "linked skill");
  const sourceUrl = new URL(`file://${repo}`).toString();
  const contentBase64 = readFileSync(join(outside, "SKILL.md")).toString(
    "base64",
  );
  const files = [{ path: "SKILL.md", contentBase64 }];
  const store = new SqliteEventStore(join(state, "db", "agena.db"));
  const service = new SkillService(store, state);
  const skill = await service.import({
    identity: skillIdentity({
      contentHash: skillContentHash(files),
      sourceUrl,
      sourcePath: "linked",
    }),
    name: "example",
    description: "Example",
    source: {
      url: sourceUrl,
      path: "linked",
      revision: run("rev-parse", "HEAD"),
    },
    files,
  });
  await expect(service.update(skill.id)).rejects.toThrow(
    "skill source path escapes checkout",
  );
  store.close();
});
