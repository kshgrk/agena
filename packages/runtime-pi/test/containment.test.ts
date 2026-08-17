// M1-R2 (§8.3 / §14 M1): verify DefaultResourceLoader gives us extension
// discovery control — the adapter's contained loader must load no filesystem
// extensions even when both <piDir>/extensions and <workspace>/.pi/extensions
// contain extension files. Offline: pure filesystem work, no API key.
//
// Installed-API deviation from the plan (recorded): in 0.80.3 an empty
// additionalExtensionPaths does NOT disable discovery; noExtensions: true is
// the control that does. The positive control below proves discovery would
// otherwise happen, so this test fails loudly if a Pi upgrade changes either
// behavior.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { containedResourceLoader } from "../src/adapter.ts";

const EXTENSION_SOURCE = "export default function extension() {}\n";

function plantExtensions(): { cwd: string; agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "agena-m1r2-"));
  const agentDir = join(root, "pi");
  const cwd = join(root, "workspace");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(agentDir, "extensions", "planted-user.ts"),
    EXTENSION_SOURCE,
  );
  writeFileSync(
    join(cwd, ".pi", "extensions", "planted-project.ts"),
    EXTENSION_SOURCE,
  );
  const skillDir = join(dirname(agentDir), "skills", "skill_test");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: test-skill\ndescription: Imported test skill\n---\nUse it.\n",
  );
  return { cwd, agentDir };
}

it("M1-R2: contained loader loads no filesystem extensions", async () => {
  const { cwd, agentDir } = plantExtensions();

  // Positive control: default discovery DOES see the planted user-scope
  // extension — proves the containment assertion below is not vacuous.
  const open = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
  });
  await open.reload();
  const discovered =
    open.getExtensions().extensions.length + open.getExtensions().errors.length;
  expect(discovered).toBeGreaterThan(0);

  // Only Agena's explicit extensions load; planted filesystem extensions do not.
  const contained = containedResourceLoader(cwd, agentDir);
  await contained.reload();
  const paths = contained.getExtensions().extensions.map((e) => e.path);
  expect(paths).toContain("<inline:1>");
  expect(paths.some((path) => path.includes("pi-mcp-adapter"))).toBe(true);
  expect(paths.some((path) => path.includes("planted-"))).toBe(false);
  expect(contained.getExtensions().errors).toEqual([]);
  expect(contained.getSkills().skills.map((skill) => skill.name)).toEqual([
    "test-skill",
  ]);

  const later = join(dirname(agentDir), "skills", "skill_later");
  mkdirSync(later, { recursive: true });
  writeFileSync(
    join(later, "SKILL.md"),
    "---\nname: later-skill\ndescription: Imported after startup\n---\nUse it.\n",
  );
  await contained.reload();
  expect(
    contained
      .getSkills()
      .skills.map((skill) => skill.name)
      .sort(),
  ).toEqual(["later-skill", "test-skill"]);
});

it("appends session-specific system context", async () => {
  const { cwd, agentDir } = plantExtensions();
  const contained = containedResourceLoader(
    cwd,
    agentDir,
    undefined,
    [],
    undefined,
    "You are an Agena side chat.",
  );
  await contained.reload();
  expect(contained.getAppendSystemPrompt()).toEqual([
    "You are an Agena side chat.",
  ]);
});
