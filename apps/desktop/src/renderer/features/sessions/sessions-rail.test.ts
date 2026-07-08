import type { SessionSummary } from "@agena/protocol";
import { describe, expect, it } from "vitest";
import {
  createGlobalSessionInput,
  sessionGroupLabel,
  splitSessionSections,
} from "./sessions-rail.tsx";

const AT = "2026-07-07T00:00:00.000Z";

function summary(partial: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: "s1",
    workspaceId: "w1",
    rootBranchId: "b1",
    lastSeq: 0,
    createdAt: AT,
    updatedAt: AT,
    scope: "project",
    status: "idle",
    projectId: "p1",
    projectRoot: ".",
    cwd: ".",
    ...partial,
  };
}

describe("sessions rail scope helpers", () => {
  it("uses the host cwd folder for project labels when projectRoot is generic", () => {
    expect(
      sessionGroupLabel(
        summary({ hostCwdHint: "/Users/kushagrakaushal/Desktop/Rough/agena" }),
      ),
    ).toBe("agena");
  });

  it("creates global sessions explicitly", () => {
    expect(createGlobalSessionInput()).toEqual({
      scope: "global",
      cwd: ".",
    });
  });

  it("splits project sessions from global sessions", () => {
    const sections = splitSessionSections(
      {
        projectA: summary({
          sessionId: "projectA",
          projectId: "p-a",
          projectRoot: "/workspace/a",
        }),
        projectB: summary({
          sessionId: "projectB",
          projectId: "p-b",
          projectRoot: "/workspace/b",
        }),
        global: summary({
          sessionId: "global",
          scope: "global",
          projectId: undefined,
          projectRoot: undefined,
        }),
        control: summary({
          sessionId: "control",
          scope: "control",
          projectId: undefined,
          projectRoot: undefined,
        }),
      },
      ["projectA", "global", "projectB", "control"],
      false,
    );

    expect(sections.projectGroups.map((g) => [g.key, g.ids])).toEqual([
      ["p-a", ["projectA"]],
      ["p-b", ["projectB"]],
    ]);
    expect(sections.globalIds).toEqual(["global"]);
  });
});
