import type { SessionSummary } from "@agena/protocol";
import { describe, expect, it } from "vitest";
import type { Block } from "../../store/types.ts";
import {
  isCodexImportedSubagent,
  visibleCodexSubagentBlocks,
} from "./codex-subagent.ts";

const session = (origin: SessionSummary["origin"]): SessionSummary =>
  ({ sessionId: "s", origin, sessionKind: "subagent" }) as SessionSummary;

const user = {
  kind: "user",
  seq: 1,
  at: "2026-01-01",
  source: { kind: "importer" },
  messageId: "u",
  content: [],
} as Block;
const first = {
  kind: "assistant",
  seq: 2,
  at: "2026-01-01",
  source: { kind: "importer" },
  messageId: "a1",
  content: [],
  status: "completed",
} as Block;
const final = {
  kind: "assistant",
  seq: 3,
  at: "2026-01-01",
  source: { kind: "importer" },
  messageId: "a2",
  content: [],
  status: "completed",
} as Block;

describe("Codex imported subagent transcript", () => {
  it("shows only its final response", () => {
    expect(
      visibleCodexSubagentBlocks(session("import.codex"), [user, first, final]),
    ).toEqual([final]);
  });

  it("leaves Claude subagents unchanged", () => {
    expect(isCodexImportedSubagent(session("import.claude"))).toBe(false);
    expect(
      visibleCodexSubagentBlocks(session("import.claude"), [user, final]),
    ).toEqual([user, final]);
  });
});
