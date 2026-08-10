// node --experimental-strip-types --test src/renderer/features/approvals/model.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalRequested } from "@agena/protocol";
import type { PendingApproval } from "../../store/types.ts";
import {
  approvalTitle,
  buildApprovalResponse,
  countdown,
  DENY,
  initialText,
  oldestFirst,
  sessionQueue,
  subjectRows,
  subjectSummary,
} from "./model.ts";

const req = (over: Partial<ApprovalRequested>): ApprovalRequested => ({
  approvalId: "a1",
  kind: "confirm",
  message: "Run this?",
  ...over,
});

// ---- response mapping per kind ------------------------------------------------

test("confirm maps to accepted", () => {
  assert.deepEqual(
    buildApprovalResponse("confirm", { optionId: null, text: "" }),
    {
      kind: "confirm",
      accepted: true,
    },
  );
});

test("select requires a chosen option", () => {
  assert.equal(
    buildApprovalResponse("select", { optionId: null, text: "" }),
    null,
  );
  assert.deepEqual(
    buildApprovalResponse("select", { optionId: "opt-2", text: "" }),
    {
      kind: "select",
      optionId: "opt-2",
    },
  );
});

test("input and editor carry the text verbatim", () => {
  assert.deepEqual(
    buildApprovalResponse("input", { optionId: null, text: "hello" }),
    {
      kind: "input",
      text: "hello",
    },
  );
  assert.deepEqual(
    buildApprovalResponse("editor", {
      optionId: "ignored",
      text: "line1\nline2",
    }),
    { kind: "editor", text: "line1\nline2" },
  );
});

test("deny is the kind-independent response with no reason field", () => {
  assert.deepEqual(DENY, { kind: "deny" });
});

// ---- prefill ------------------------------------------------------------------

test("initialText prefers defaultValue, editor falls back to subject.command", () => {
  assert.equal(initialText(req({ kind: "editor", defaultValue: "dv" })), "dv");
  assert.equal(
    initialText(req({ kind: "editor", subject: { command: "rm -rf /tmp/x" } })),
    "rm -rf /tmp/x",
  );
  assert.equal(
    initialText(req({ kind: "input", subject: { command: "c" } })),
    "",
  );
  assert.equal(initialText(req({ kind: "input" })), "");
});

// ---- titles / subject -----------------------------------------------------------

test("approvalTitle: explicit title, then toolName, then generic", () => {
  assert.equal(
    approvalTitle(req({ title: "Delete branch?" })),
    "Delete branch?",
  );
  assert.equal(
    approvalTitle(req({ subject: { toolName: "bash" } })),
    "Approve bash?",
  );
  assert.equal(approvalTitle(req({})), "Approval requested");
});

test("subjectRows renders present fields verbatim in stable order", () => {
  const rows = subjectRows(
    req({
      subject: {
        toolName: "bash",
        command: "git push --force",
        cwd: "/workspace/app",
        args: { force: true },
      },
    }),
  );
  assert.deepEqual(
    rows.map(([label]) => label),
    ["tool", "command", "cwd", "args"],
  );
  assert.equal(rows[1]?.[1], "git push --force");
  assert.equal(rows[3]?.[1], JSON.stringify({ force: true }, null, 2));
  assert.deepEqual(subjectRows(req({})), []);
});

test("subjectSummary prefers command, truncates long args json", () => {
  assert.equal(
    subjectSummary(req({ subject: { command: "ls", action: "exec" } })),
    "ls",
  );
  assert.equal(subjectSummary(req({ subject: { action: "write" } })), "write");
  const long = subjectSummary(
    req({ subject: { args: { k: "x".repeat(200) } } }),
  );
  assert.ok(long !== null && long.length === 80 && long.endsWith("…"));
  assert.equal(subjectSummary(req({})), null);
});

// ---- countdown -------------------------------------------------------------

test("countdown label boundaries and urgency", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  assert.deepEqual(countdown(at(-1), now), { label: "expired", urgent: true });
  assert.deepEqual(countdown(at(5_000), now), {
    label: "expires in 5s",
    urgent: true,
  });
  assert.deepEqual(countdown(at(45_000), now), {
    label: "expires in 45s",
    urgent: false,
  });
  assert.deepEqual(countdown(at(150_000), now), {
    label: "expires in 2m",
    urgent: false,
  });
  assert.equal(countdown("not-a-date", now), null);
});

// ---- ordering -------------------------------------------------------------------

const p = (
  approvalId: string,
  sessionId: string,
  seq: number,
  requestedAt: string,
): PendingApproval => ({
  approvalId,
  sessionId,
  seq,
  requestedAt,
  request: req({ approvalId }),
});

test("oldestFirst orders by requestedAt then seq across sessions", () => {
  const pending = {
    c: p("c", "s2", 1, "2026-01-01T00:00:02Z"),
    a: p("a", "s1", 5, "2026-01-01T00:00:01Z"),
    b: p("b", "s1", 4, "2026-01-01T00:00:01Z"),
  };
  assert.deepEqual(
    oldestFirst(pending).map((x) => x.approvalId),
    ["b", "a", "c"],
  );
});

test("sessionQueue filters to one session in seq order", () => {
  const pending = {
    a: p("a", "s1", 9, "2026-01-01T00:00:01Z"),
    b: p("b", "s2", 2, "2026-01-01T00:00:02Z"),
    c: p("c", "s1", 3, "2026-01-01T00:00:03Z"),
  };
  assert.deepEqual(
    sessionQueue(pending, "s1").map((x) => x.approvalId),
    ["c", "a"],
  );
  assert.deepEqual(sessionQueue(pending, null), []);
});
