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
