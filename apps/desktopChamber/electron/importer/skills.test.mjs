import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSkillRequestSchema } from "@agena/protocol";
import { describe, expect, it } from "vitest";
import { importSkills, scanSkills } from "./skills.mjs";

describe("skill import discovery", () => {
  it("packages a skill recursively, skips symlinks, and exposes no source path", async () => {
    const root = await mkdtemp(join(tmpdir(), "agena-skills-"));
    const skill = join(root, "review");
    await mkdir(join(skill, "references"), { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: review\ndescription: Review code carefully.\n---\nUse the checklist.\n",
    );
    await writeFile(join(skill, "references", "checklist.md"), "Be precise.\n");
    const nested = join(skill, "vendor", "nested");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(nested, "SKILL.md"),
      "---\nname: nested\ndescription: Nested skill.\n---\n",
    );
    await symlink("/etc/passwd", join(skill, "escaped"));

    const scan = await scanSkills({ refresh: true, roots: [root] });
    expect(scan.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "review", fileCount: 2 }),
        expect.objectContaining({ name: "nested", fileCount: 1 }),
      ]),
    );
    expect(JSON.stringify(scan)).not.toContain(root);

    let request;
    const result = await importSkills(
      { ids: [scan.skills.find((item) => item.name === "review").id] },
      {
        async importSkill(value) {
          request = value;
          return { skill: { id: "skill_1" }, updated: false };
        },
      },
    );
    expect(request.files.map((file) => file.path)).toEqual([
      "references/checklist.md",
      "SKILL.md",
    ]);
    expect(request).not.toHaveProperty("contentHash");
    expect(result.skills[0]).toMatchObject({ status: "imported" });
  });

  it("recovers upstream provenance from a cached plugin manifest", async () => {
    const plugin = await mkdtemp(join(tmpdir(), "agena-plugin-"));
    const skill = join(plugin, "skills", "deploy");
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(plugin, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        repository:
          "https://github.com/acme/plugins/tree/main/plugins/deployments",
      }),
    );
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy safely.\n---\n",
    );

    const scan = await scanSkills({
      refresh: true,
      roots: [join(plugin, "skills")],
    });
    let request;
    await importSkills(
      { ids: [scan.skills[0].id] },
      {
        async importSkill(value) {
          request = value;
          return { skill: { id: "skill_1" } };
        },
      },
    );
    expect(request.source).toEqual({
      url: "https://github.com/acme/plugins",
      path: "plugins/deployments/skills/deploy",
    });
  });

  it("omits an empty source path for a repository-root skill", async () => {
    const parent = await mkdtemp(join(tmpdir(), "agena-git-skill-"));
    const skill = join(parent, "root-skill");
    await mkdir(skill);
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: root-skill\ndescription: Root skill.\n---\n",
    );
    const git = (...args) =>
      execFileSync("git", args, { cwd: skill, encoding: "utf8" });
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("remote", "add", "origin", "https://example.com/skills.git");
    git("add", "SKILL.md");
    git("commit", "-m", "skill");

    const scan = await scanSkills({ refresh: true, roots: [parent] });
    let request;
    await importSkills(
      { ids: [scan.skills[0].id] },
      {
        async importSkill(value) {
          request = value;
          return { skill: { id: "skill_1" } };
        },
      },
    );
    expect(request.source).not.toHaveProperty("path");
    expect(importSkillRequestSchema.safeParse(request).success).toBe(true);
  });
});
