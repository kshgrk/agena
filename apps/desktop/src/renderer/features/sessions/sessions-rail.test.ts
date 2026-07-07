import type { SessionSummary } from "@agena/protocol";
import { describe, expect, it } from "vitest";
import {
  createSessionInputForActive,
  sessionGroupLabel,
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

  it("inherits project scope when creating from an active project session", () => {
    expect(
      createSessionInputForActive(
        "new task",
        summary({
          projectId: "p-agena",
          projectRoot: ".",
          cwd: "packages/core",
          hostCwdHint: "/Users/kushagrakaushal/Desktop/Rough/agena",
        }),
      ),
    ).toEqual({
      title: "new task",
      scope: "project",
      projectId: "p-agena",
      projectRoot: ".",
      cwd: "packages/core",
      hostCwdHint: "/Users/kushagrakaushal/Desktop/Rough/agena",
    });
  });
});
