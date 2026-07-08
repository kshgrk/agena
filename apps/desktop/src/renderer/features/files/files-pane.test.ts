import { describe, expect, it } from "vitest";
import { fileRootForSession } from "./files-pane.tsx";

describe("fileRootForSession", () => {
  it("opens project sessions at their workspace-relative project root", () => {
    expect(
      fileRootForSession({
        scope: "project",
        projectRoot: "/workspace/openwork",
      }),
    ).toBe("openwork");
    expect(
      fileRootForSession({
        scope: "project",
        projectRoot: "openwork",
      }),
    ).toBe("openwork");
  });

  it("opens global sessions at the workspace root", () => {
    expect(fileRootForSession({ scope: "global" })).toBe(".");
  });
});
