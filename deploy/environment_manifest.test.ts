import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const moduleDir = resolve(import.meta.dirname);

function python(source: string, ...args: string[]): string {
  return execFileSync("python3", ["-c", source, ...args], {
    encoding: "utf8",
  });
}

describe("environment manifest", () => {
  test("normalizes packages and records only additions to the base image", () => {
    const dir = mkdtempSync(join(tmpdir(), "agena-env-"));
    const manifest = join(dir, "environment.toml");
    writeFileSync(manifest, '[packages]\nsystem = ["jq", "gh", "jq"]\n');

    const output = python(
      "import sys; sys.path.insert(0, sys.argv[1]); " +
        "from environment_manifest import read_system_packages, record_manual_packages; " +
        "from pathlib import Path; p=Path(sys.argv[2]); " +
        "print(','.join(read_system_packages(p))); " +
        "record_manual_packages(p, {'git', 'jq'}, {'git', 'gh', 'jq'})",
      moduleDir,
      manifest,
    );

    expect(output.trim()).toBe("gh,jq");
    expect(readFileSync(manifest, "utf8")).toBe(
      '[packages]\nsystem = ["gh"]\n',
    );
  });

  test("rejects values that are not Debian package names", () => {
    const output = python(
      "import sys; sys.path.insert(0, sys.argv[1]); " +
        "from environment_manifest import system_packages\n" +
        "try: system_packages('[packages]\\nsystem = [\"gh;rm\"]\\n')\n" +
        "except ValueError as error: print(error)",
      moduleDir,
    );

    expect(output.trim()).toBe("invalid Debian package name: gh;rm");
  });
});
