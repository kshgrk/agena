import { expect, test } from "vitest";
import { check } from "./check-boundaries.mjs";

test("flags a forbidden workspace edge and a restricted external", () => {
  const violations = check([
    {
      name: "@agena/client",
      dir: "packages/client",
      deps: ["@agena/core"],
      imports: [
        { file: "packages/client/src/x.ts", spec: "@earendil-works/pi-tui" },
      ],
    },
  ]);
  expect(violations).toHaveLength(2);
});

test("passes allowed edges", () => {
  const violations = check([
    {
      name: "@agena/core",
      dir: "packages/core",
      deps: ["@agena/protocol", "ulid"],
      imports: [{ file: "packages/core/src/ids.ts", spec: "@agena/protocol" }],
    },
  ]);
  expect(violations).toEqual([]);
});

test("allows Chamber to depend only on client/protocol and import electron", () => {
  const violations = check([
    {
      name: "@agena/desktop-chamber",
      dir: "apps/desktopChamber",
      deps: ["@agena/client", "@agena/protocol"],
      imports: [
        { file: "apps/desktopChamber/electron/main.mjs", spec: "electron" },
        {
          file: "apps/desktopChamber/src/renderer/lib/ws-bridge.ts",
          spec: "@agena/client",
        },
      ],
    },
  ]);
  expect(violations).toEqual([]);
});

test("flags electron imports outside desktop", () => {
  const violations = check([
    {
      name: "@agena/cli",
      dir: "apps/cli",
      deps: [],
      imports: [{ file: "apps/cli/src/main.ts", spec: "electron" }],
    },
  ]);
  expect(violations).toEqual([
    'apps/cli/src/main.ts: "electron" may only be imported by apps/desktopChamber',
  ]);
});
