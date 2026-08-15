import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_THEME,
  normalizeThemePreference,
  resolveAppearance,
} from "./theme.ts";

test("normalizes legacy and invalid persisted theme preferences", () => {
  assert.deepEqual(normalizeThemePreference("light"), {
    family: "graphite",
    appearance: "light",
  });
  assert.deepEqual(
    normalizeThemePreference({ family: "folio", appearance: "dark" }),
    { family: "folio", appearance: "dark" },
  );
  assert.deepEqual(
    normalizeThemePreference({ family: "unknown", appearance: "sepia" }),
    DEFAULT_THEME,
  );
  assert.deepEqual(
    normalizeThemePreference({ family: "harbor", appearance: "dim" }),
    { family: "harbor", appearance: "dim" },
  );
  assert.deepEqual(
    normalizeThemePreference({ family: "folio", appearance: "dim" }),
    { family: "evergreen", appearance: "dim" },
  );
  assert.deepEqual(
    normalizeThemePreference({ family: "clay", appearance: "light" }),
    { family: "graphite", appearance: "light" },
  );
  assert.deepEqual(normalizeThemePreference("dim"), {
    family: "evergreen",
    appearance: "dim",
  });
});

test("system appearance follows the supplied OS preference", () => {
  assert.equal(resolveAppearance("system", true), "light");
  assert.equal(resolveAppearance("system", false), "dark");
  assert.equal(resolveAppearance("dark", true), "dark");
  assert.equal(resolveAppearance("dim", true), "dark");
});
