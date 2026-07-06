// M1-R2 (§8.3 / §14 M1): verify DefaultResourceLoader gives us extension
// discovery control — the adapter's contained loader must load ZERO filesystem
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
import { join } from "node:path";
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

  // The adapter's configuration loads nothing from the filesystem.
  const contained = containedResourceLoader(cwd, agentDir);
  await contained.reload();
  expect(contained.getExtensions().extensions).toEqual([]);
  expect(contained.getExtensions().errors).toEqual([]);
  expect(contained.getSkills().skills).toEqual([]);
});
