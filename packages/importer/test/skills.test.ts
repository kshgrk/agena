import { expect, test } from "vitest";
import {
  normalizeSkillFiles,
  parseSkillManifest,
  skillContentHash,
  skillIdentity,
} from "../src/skills.ts";

const file = (path: string, content: string) => ({
  path,
  contentBase64: Buffer.from(content).toString("base64"),
});

test("normalizes a skill package into one stable cross-harness identity", () => {
  const manifest = parseSkillManifest(`---
name: release-helper
description: >
  Ships releases safely
  and reports failures.
version: 1.2.0
---
# Release
`);
  expect(manifest).toEqual({
    name: "release-helper",
    description: "Ships releases safely and reports failures.",
    version: "1.2.0",
  });
  const a = [file("scripts/run.sh", "echo ok\n"), file("SKILL.md", "skill")];
  const b = [...a].reverse();
  expect(skillContentHash(a)).toBe(skillContentHash(b));
  expect(
    skillIdentity({
      contentHash: skillContentHash(a),
      sourceUrl: "https://github.com/acme/skills.git",
      sourcePath: "skills/release-helper",
    }),
  ).toBe("git:https://github.com/acme/skills#skills/release-helper");
});

test("rejects packages that escape their durable install directory", () => {
  expect(() =>
    normalizeSkillFiles([file("SKILL.md", "ok"), file("../secret", "no")]),
  ).toThrow("invalid skill file path");
});
