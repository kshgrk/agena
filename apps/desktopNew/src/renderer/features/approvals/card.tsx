// The one approval surface, shared by the inline banner and the focused modal
// (design.md §8). Renders ONLY the canonical approval.requested payload
// (D-INV-3); responds through respondOptimistic (optimistic pending-removal
// with error rollback — first-write-wins is daemon truth).
import type { ApprovalRequested, ApprovalResponse } from "@agena/protocol";
import { Clock, Maximize2, ShieldAlert } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import type { BridgeError } from "../../../shared/bridge.ts";
import { getBridge } from "../../lib/bridge.ts";
import type { PendingApproval } from "../../store/index.ts";
import { pushToast, useApprovals } from "../../store/index.ts";
import {
  Button,
  cx,
  IconButton,
  Input,
  Kbd,
  Textarea,
} from "../../ui/index.ts";
import {
  approvalTitle,
  buildApprovalResponse,
  countdown,
  DENY,
  initialForm,
} from "./model.ts";

// Typed input/editor text survives a failed submit → rollback → remount.
const drafts = new Map<string, string>();

/**
 * Optimistic respond: remove from pending immediately, roll back on failure.
 * APPROVAL_NOT_PENDING means another client won the write — daemon truth, the
 * removal stands.
 */
export async function respondOptimistic(
  approval: PendingApproval,
  response: ApprovalResponse,
): Promise<void> {
  useApprovals.getState().remove(approval.approvalId);
  try {
    await getBridge().respondToApproval(
      approval.sessionId,
      approval.approvalId,
      response,
    );
    drafts.delete(approval.approvalId);
    pushToast({
      kind: "ok",
      title: response.kind === "deny" ? "Denied" : "Approved",
    });
  } catch (err) {
    const e = err as Partial<BridgeError>;
    if (e.code === "APPROVAL_NOT_PENDING") {
      drafts.delete(approval.approvalId);
      pushToast({ kind: "info", title: "Already answered by another client" });
      return;
    }
    useApprovals.getState().add(approval); // rollback
    pushToast({
      kind: "err",
      title: "Failed to respond",
      detail: e.message ?? "respondToApproval failed",
    });
  }
}

// ---- pieces -----------------------------------------------------------------

export function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const c = countdown(expiresAt, now);
  if (!c) return null;
  return (
    <span
      className={cx(
        "flex shrink-0 items-center gap-1 text-xs tabular-nums",
        c.urgent ? "text-warn" : "text-fg-muted",
      )}
    >
      <Clock className="size-3.5" aria-hidden />
      {c.label}
    </span>
  );
}

/** Full subject, verbatim, in the tool-card well spec — never truncated,
 * scrolls when long (design.md §8). */
function SubjectWell({ request }: { request: ApprovalRequested }) {
  const s = request.subject;
  if (!s) return null;
  const rows: Array<[string, string]> = [];
  if (s.toolName !== undefined) rows.push(["tool", s.toolName]);
  if (s.command !== undefined) rows.push(["command", s.command]);
  if (s.cwd !== undefined) rows.push(["cwd", s.cwd]);
  if (s.action !== undefined) rows.push(["action", s.action]);
  if (s.args !== undefined) {
    rows.push(["args", JSON.stringify(s.args, null, 2) ?? "undefined"]);
  }
  if (rows.length === 0) return null;
  return (
    <div className="max-h-80 overflow-auto rounded-md bg-inset p-2.5 font-mono text-sm">
      <div className="grid grid-cols-[max-content_1fr] items-start gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <span className="text-fg-muted">{label}</span>
            <span className="min-w-0 whitespace-pre-wrap break-all text-fg">
              {value}
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// ---- the card ----------------------------------------------------------------

export type ApprovalCardProps = {
  approval: PendingApproval;
  /** banner = inline queue entry · modal = focused dialog body. */
  variant: "banner" | "modal";
  /** Banner-only: open the focused modal on this approval. */
  onReview?: () => void;
};

export function ApprovalCard({ approval, variant, onReview }: ApprovalCardProps) {
  const { request } = approval;
  const [form, setForm] = useState(() => {
    const f = initialForm(request);
    const draft = drafts.get(approval.approvalId);
    return draft === undefined ? f : { ...f, text: draft };
  });

  const response = buildApprovalResponse(request.kind, form);
  const approve = () => {
    if (response === null) return;
    if (request.kind === "input" || request.kind === "editor") {
      drafts.set(approval.approvalId, form.text);
    }
    void respondOptimistic(approval, response);
  };
  const deny = () => void respondOptimistic(approval, DENY);

  // Modal keyboard: y/n only where unambiguous — confirm kind, no field focus.
  // (Esc closes via the dialog itself, without responding.)
  const confirmKeys = variant === "modal" && request.kind === "confirm";
  useEffect(() => {
    if (!confirmKeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      ) {
        return;
      }
      if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        approve();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        deny();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // confirm-kind approve/deny don't read form state, so the binding only
    // depends on which approval is showing.
  }, [confirmKeys, approval.approvalId]);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* header — the modal renders its own title row in the dialog */}
      {variant === "banner" ? (
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 shrink-0 text-warn" aria-hidden />
          <span className="min-w-0 truncate text-sm font-medium text-fg">
            {approvalTitle(request)}
          </span>
          <span className="flex-1" />
          {request.expiresAt !== undefined ? (
            <Countdown expiresAt={request.expiresAt} />
          ) : null}
          {onReview ? (
            <IconButton label="Review in dialog" size="sm" onClick={onReview}>
              <Maximize2 />
            </IconButton>
          ) : null}
        </div>
      ) : null}

      {request.message !== "" ? (
        <p className="whitespace-pre-wrap text-sm text-fg-secondary">
          {request.message}
        </p>
      ) : null}

      <SubjectWell request={request} />

      {request.kind === "select" ? (
        <div role="radiogroup" aria-label="Options" className="flex flex-col gap-1">
          {(request.options ?? []).map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={form.optionId === o.id}
              onClick={() => setForm((f) => ({ ...f, optionId: o.id }))}
              className={cx(
                "rounded-md border px-2.5 py-1.5 text-left transition-colors",
                form.optionId === o.id
                  ? "border-accent/35 bg-accent/10"
                  : "border-border-subtle hover:bg-raised",
              )}
            >
              <span className="block text-sm text-fg">{o.label}</span>
              {o.description !== undefined ? (
                <span className="block text-xs text-fg-muted">
                  {o.description}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {request.kind === "input" ? (
        <Input
          className="font-mono"
          value={form.text}
          autoFocus={variant === "modal"}
          onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              approve();
            }
          }}
        />
      ) : null}

      {request.kind === "editor" ? (
        <Textarea
          className="min-h-0 resize-y font-mono"
          rows={variant === "modal" ? 12 : 5}
          value={form.text}
          autoFocus={variant === "modal"}
          spellCheck={false}
          onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
        />
      ) : null}

      {/* actions */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={deny}>
          Deny
          {confirmKeys ? <Kbd>N</Kbd> : null}
        </Button>
        <Button variant="primary" disabled={response === null} onClick={approve}>
          Approve
          {confirmKeys ? <Kbd>Y</Kbd> : null}
        </Button>
      </div>
    </div>
  );
}
