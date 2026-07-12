import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertExactPackageSource,
  PiPackageService,
} from "../src/package-service.ts";

test("package sources require immutable versions", () => {
  assert.doesNotThrow(() => assertExactPackageSource("npm:example@1.2.3"));
  assert.doesNotThrow(() =>
    assertExactPackageSource("npm:@scope/example@1.2.3"),
  );
  assert.doesNotThrow(() =>
    assertExactPackageSource(
      "https://github.com/example/plugin.git#0123456789abcdef0123456789abcdef01234567",
    ),
  );
  assert.throws(() => assertExactPackageSource("npm:example@latest"));
  assert.throws(() => assertExactPackageSource("npm:example@^1.2.3"));
  assert.throws(() => assertExactPackageSource("example@1.2.3"));
  assert.throws(() =>
    assertExactPackageSource("https://github.com/example/plugin.git#main"),
  );
});

test("enabled package state survives restart and remains explicit", () => {
  const dir = mkdtempSync(join(tmpdir(), "agena-pi-packages-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agena-packages.json"),
    JSON.stringify({
      packages: [
        { source: "npm:enabled@1.0.0", enabled: true },
        { source: "npm:disabled@2.0.0", enabled: false },
      ],
    }),
  );
  try {
    const service = new PiPackageService({ piDir: dir });
    // State alone cannot activate code: the package must also exist in Pi's
    // managed install root.
    assert.deepEqual(service.extensionSources, []);
    assert.deepEqual(service.list(), [
      { source: "npm:enabled@1.0.0", enabled: true, installed: false },
      { source: "npm:disabled@2.0.0", enabled: false, installed: false },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
