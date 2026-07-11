import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  normalizeSkillFiles,
  parseSkillManifest,
  type SkillPackageFile,
  skillContentHash,
  skillIdentity,
} from "@agena/importer/skills";
import type { ImportSkillRequest, SkillSummary } from "@agena/protocol";
import type { SqliteEventStore } from "@agena/storage-sqlite";

const exec = promisify(execFile);
const MAX_FILES = 500;
const MAX_BYTES = 10 * 1024 * 1024;

export class SkillService {
  readonly #store: SqliteEventStore;
  readonly root: string;

  constructor(store: SqliteEventStore, stateDir: string) {
    this.#store = store;
    this.root = join(stateDir, "skills");
  }

  list(): SkillSummary[] {
    return this.#store.listSkills();
  }

  async import(input: ImportSkillRequest): Promise<SkillSummary> {
    const files = normalizeSkillFiles(input.files);
    const contentHash = skillContentHash(files);
    const identity = skillIdentity({
      contentHash,
      ...(input.source?.url ? { sourceUrl: input.source.url } : {}),
      ...(input.source?.path ? { sourcePath: input.source.path } : {}),
    });
    if (identity !== input.identity)
      throw new Error("skill identity does not match package");
    const manifest = manifestOf(files);
    if (manifest.name !== input.name)
      throw new Error("skill name does not match SKILL.md");
    if (manifest.description !== input.description)
      throw new Error("skill description does not match SKILL.md");
    const nameCollision = this.#store
      .listSkills()
      .find(
        (skill) => skill.name === manifest.name && skill.identity !== identity,
      );
    if (nameCollision)
      throw new Error(`skill name "${manifest.name}" is already installed`);
    const id = skillId(identity);
    return this.#install(id, files, () =>
      this.#store.upsertSkill({
        identity,
        name: manifest.name,
        description: manifest.description,
        contentHash,
        ...(input.source?.url ? { sourceUrl: input.source.url } : {}),
        ...(input.source?.path ? { sourcePath: input.source.path } : {}),
        ...(input.source?.revision
          ? { sourceRevision: input.source.revision }
          : {}),
        status: "ready",
      }),
    );
  }

  async checkAll(): Promise<SkillSummary[]> {
    const skills = this.list();
    const byRemote = new Map<string, SkillSummary[]>();
    for (const skill of skills) {
      if (!skill.sourceUrl) continue;
      const group = byRemote.get(skill.sourceUrl);
      if (group) group.push(skill);
      else byRemote.set(skill.sourceUrl, [skill]);
    }
    await Promise.all(
      [...byRemote].map(async ([url, group]) => {
        try {
          const revision = await remoteHead(url);
          for (const skill of group)
            this.#store.setSkillStatus(
              skill.id,
              revision !== skill.sourceRevision ? "update_available" : "ready",
            );
        } catch {
          for (const skill of group)
            this.#store.setSkillStatus(skill.id, "error");
        }
      }),
    );
    return this.list();
  }

  async update(id: string): Promise<SkillSummary> {
    const skill = this.#required(id);
    if (!skill.sourceUrl) throw new Error("skill has no Git source");
    const checkout = await mkdtemp(join(tmpdir(), "agena-skill-git-"));
    try {
      await exec("git", [
        "clone",
        "--depth",
        "1",
        "--no-tags",
        "--",
        skill.sourceUrl,
        checkout,
      ]);
      const revision = (
        await exec("git", ["-C", checkout, "rev-parse", "HEAD"])
      ).stdout.trim();
      const checkoutRoot = await realpath(checkout);
      const packageRoot = await realpath(
        resolve(checkoutRoot, skill.sourcePath ?? "."),
      );
      const packagePath = relative(checkoutRoot, packageRoot);
      if (packagePath === ".." || packagePath.startsWith(`..${sep}`))
        throw new Error("skill source path escapes checkout");
      const files = await readPackage(packageRoot);
      const manifest = manifestOf(files);
      if (manifest.name !== skill.name)
        throw new Error("updated skill name does not match SKILL.md");
      return this.#install(id, files, () =>
        this.#store.upsertSkill({
          identity: skill.identity,
          name: manifest.name,
          description: manifest.description,
          contentHash: skillContentHash(files),
          sourceUrl: skill.sourceUrl,
          ...(skill.sourcePath ? { sourcePath: skill.sourcePath } : {}),
          sourceRevision: revision,
          status: "ready",
        }),
      );
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  }

  #required(id: string): SkillSummary {
    const skill = this.#store.getSkill(id);
    if (!skill) throw new Error("skill not found");
    return skill;
  }

  async #install(
    id: string,
    files: SkillPackageFile[],
    persist: () => SkillSummary,
  ): Promise<SkillSummary> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stage = join(this.root, `.${id}.${randomUUID()}.tmp`);
    const target = join(this.root, id);
    const backup = join(this.root, `.${id}.${randomUUID()}.old`);
    await mkdir(stage, { mode: 0o700 });
    try {
      for (const file of files) {
        const destination = join(stage, file.path);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(
          destination,
          Buffer.from(file.contentBase64, "base64"),
          {
            mode: file.path.startsWith("scripts/") ? 0o700 : 0o600,
          },
        );
      }
      let hadTarget = false;
      try {
        await rename(target, backup);
        hadTarget = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await rename(stage, target);
      } catch (error) {
        if (hadTarget) await rename(backup, target);
        throw error;
      }
      let skill: SkillSummary;
      try {
        skill = persist();
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        if (hadTarget) await rename(backup, target);
        throw error;
      }
      if (hadTarget)
        await rm(backup, { recursive: true, force: true }).catch((error) =>
          console.warn(
            "[agena-skills] could not remove old skill backup",
            error,
          ),
        );
      return skill;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}

function skillId(identity: string): string {
  return `skill_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function manifestOf(files: SkillPackageFile[]) {
  const file = files.find((entry) => entry.path === "SKILL.md");
  if (!file) throw new Error("skill package needs SKILL.md");
  return parseSkillManifest(
    Buffer.from(file.contentBase64, "base64").toString("utf8"),
  );
}

async function remoteHead(url: string): Promise<string> {
  const revision = (await exec("git", ["ls-remote", "--", url, "HEAD"])).stdout
    .trim()
    .split(/\s+/)[0];
  if (!revision) throw new Error("Git remote has no HEAD");
  return revision;
}

async function readPackage(root: string): Promise<SkillPackageFile[]> {
  const files: SkillPackageFile[] = [];
  let bytes = 0;
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink())
        throw new Error("skill packages may not contain symlinks");
      if (info.isDirectory()) {
        if (entry.name === "node_modules") continue;
        try {
          if ((await lstat(join(path, "SKILL.md"))).isFile()) continue;
        } catch {
          // ordinary supporting directory
        }
        await walk(path);
      } else if (info.isFile()) {
        bytes += info.size;
        if (files.length >= MAX_FILES || bytes > MAX_BYTES)
          throw new Error("skill package exceeds safe import limits");
        files.push({
          path: relative(root, path).replaceAll("\\", "/"),
          contentBase64: (await readFile(path)).toString("base64"),
        });
      }
    }
  }
  await walk(root);
  return normalizeSkillFiles(files);
}
