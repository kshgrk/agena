// Pure approval view logic: response mapping per kind, subject derivation,
// queue ordering, expiry countdown. No React, no store imports — runnable
// under `node --experimental-strip-types --test` (model.test.ts).
import type { ApprovalRequested, ApprovalResponse } from "@agena/protocol";
import type { PendingApproval } from "../../store/types.ts";

/** `{ kind: "deny" }` is valid for EVERY approval kind (protocol §4.5). The
 * protocol carries no deny reason in v1, so there is no reason affordance. */
export const DENY: ApprovalResponse = { kind: "deny" };

export type ApprovalFormState = {
  optionId: string | null;
  text: string;
};

/** Editor prefills from the subject when there is no explicit defaultValue. */
export function initialText(request: ApprovalRequested): string {
  if (request.defaultValue !== undefined) return request.defaultValue;
  if (request.kind === "editor") return request.subject?.command ?? "";
  return "";
}

export function initialForm(request: ApprovalRequested): ApprovalFormState {
  return { optionId: null, text: initialText(request) };
}

/**
 * The accept-path response for a request. Returns null while unanswerable
 * (a select with no option chosen) — callers disable Approve on null.
 */
export function buildApprovalResponse(
  kind: ApprovalRequested["kind"],
  form: ApprovalFormState,
): ApprovalResponse | null {
  switch (kind) {
    case "confirm":
      return { kind: "confirm", accepted: true };
    case "select":
      return form.optionId === null
        ? null
        : { kind: "select", optionId: form.optionId };
    case "input":
      return { kind: "input", text: form.text };
    case "editor":
      return { kind: "editor", text: form.text };
  }
}

export function approvalTitle(request: ApprovalRequested): string {
  if (request.title !== undefined && request.title !== "") {
    return request.title;
  }
  const tool = request.subject?.toolName;
  return tool !== undefined && tool !== ""
    ? `Approve ${tool}?`
    : "Approval requested";
}

/**
 * Every present subject field, verbatim (D-INV-3: never truncate what the
 * user is approving). args render as pretty JSON.
 */
export function subjectRows(
  request: ApprovalRequested,
): Array<[label: string, value: string]> {
  const s = request.subject;
  if (!s) return [];
  const rows: Array<[string, string]> = [];
  if (s.toolName !== undefined) rows.push(["tool", s.toolName]);
  if (s.command !== undefined) rows.push(["command", s.command]);
  if (s.cwd !== undefined) rows.push(["cwd", s.cwd]);
  if (s.action !== undefined) rows.push(["action", s.action]);
  if (s.args !== undefined) {
    rows.push(["args", JSON.stringify(s.args, null, 2) ?? "undefined"]);
  }
  return rows;
}

/** One-line tool-call context for banner headers and the global list. */
export function subjectSummary(request: ApprovalRequested): string | null {
  const s = request.subject;
  if (!s) return null;
  const primary = s.command ?? s.action ?? s.cwd;
  if (primary !== undefined) return primary;
  if (s.args !== undefined) {
    const json = JSON.stringify(s.args) ?? "";
    return json.length > 80 ? `${json.slice(0, 79)}…` : json;
  }
  return null;
}

export type CountdownState = { label: string; urgent: boolean };

/** null for an unparseable expiresAt (render nothing rather than lie). */
export function countdown(
  expiresAt: string,
  nowMs: number,
): CountdownState | null {
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return null;
  const ms = deadline - nowMs;
  // ponytail: coarse units on purpose — minutes above 60s, whole seconds below
  const label =
    ms <= 0
      ? "expired"
      : ms >= 60_000
        ? `expires in ${Math.floor(ms / 60_000)}m`
        : `expires in ${Math.ceil(ms / 1000)}s`;
  return { label, urgent: ms < 30_000 };
}

/** Transcript order within one session. */
export const bySeq = (a: PendingApproval, b: PendingApproval): number =>
  a.seq - b.seq;

/** Oldest-first across sessions (requestedAt ISO strings compare lexically). */
export function oldestFirst(
  pending: Readonly<Record<string, PendingApproval>>,
): PendingApproval[] {
  return Object.values(pending).sort(
    (a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.seq - b.seq,
  );
}

/** The pending queue of one session, transcript order. */
export function sessionQueue(
  pending: Readonly<Record<string, PendingApproval>>,
  sessionId: string | null,
): PendingApproval[] {
  if (sessionId === null) return [];
  return Object.values(pending)
    .filter((p) => p.sessionId === sessionId)
    .sort(bySeq);
}
