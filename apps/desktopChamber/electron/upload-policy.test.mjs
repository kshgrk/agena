import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoCredentialedGitRemotes,
  shouldSkipUploadName,
  shouldSkipUploadPath,
} from "./upload-policy.mjs";

const skipped = new Set([".git", "node_modules"]);

test("only session imports include git metadata", () => {
  assert.equal(shouldSkipUploadName(".git", false, skipped), true);
  assert.equal(shouldSkipUploadName(".git", true, skipped), false);
  assert.equal(shouldSkipUploadName("node_modules", true, skipped), true);
});

test("Codex checkpoint refs are omitted without hiding real branches", () => {
  assert.equal(
    shouldSkipUploadPath(
      ".git/refs/codex/turn-diffs/checkpoints/hash/hash/timestamp/id",
    ),
    true,
  );
  assert.equal(
    shouldSkipUploadPath(".git/logs/refs/codex/turn-diffs/checkpoints/hash"),
    true,
  );
  assert.equal(shouldSkipUploadPath(".git/refs/heads/codex/my-branch"), false);
  assert.equal(shouldSkipUploadPath(".git/refs/remotes/origin/main"), false);
});

test("credentialed HTTP remotes are rejected", () => {
  assert.doesNotThrow(() =>
    assertNoCredentialedGitRemotes(
      '[remote "origin"]\nurl = git@github.com:acme/repo.git\n',
    ),
  );
  assert.throws(
    () =>
      assertNoCredentialedGitRemotes(
        '[remote "origin"]\nurl = https://secret@github.com/acme/repo.git\n',
      ),
    /embedded credentials/,
  );
});
