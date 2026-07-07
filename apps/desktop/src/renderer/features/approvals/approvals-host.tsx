// Approvals host (plan §7.7, D-INV-3): the trusted modal renders ONLY the
// canonical approval.requested payload; pending state lives in useApprovals
// (event-derived + connect-time HTTP seed). First-write-wins is daemon truth.
import type { ApprovalResponse } from "@agena/protocol";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import type { BridgeError } from "../../../shared/bridge.ts";
import { getBridge } from "../../lib/bridge.ts";
import {
  type PendingApproval,
  useApprovals,
  useSessions,
} from "../../store/index.ts";
import {
  Badge,
  Button,
  CodeBlock,
  cx,
  IconButton,
  Modal,
  ModalDescription,
  ModalFooter,
  ModalTitle,
  Spinner,
  TextArea,
  TextInput,
  toast,
} from "../../ui/index.ts";

/** Dispatch `new CustomEvent(OPEN_APPROVAL_EVENT, { detail: { approvalId } })` to force-open. */
export const OPEN_APPROVAL_EVENT = "agena:open-approval";

/** Once-per-approvalId toast guard (module scope: survives StrictMode remounts). */
const toastedIds = new Set<string>();

const bySeq = (a: PendingApproval, b: PendingApproval) => a.seq - b.seq;

/** Oldest-first across sessions (requestedAt ISO strings compare lexically). */
function oldestFirst(
  pending: Readonly<Record<string, PendingApproval>>,
): PendingApproval[] {
  return Object.values(pending).sort(
    (a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.seq - b.seq,
  );
}

// ---- host ---------------------------------------------------------------

export function ApprovalsHost() {
  const pending = useApprovals((s) => s.pending);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const sessionsById = useSessions((s) => s.byId);
  /** Explicitly navigated/forced approval (wins over the auto-oldest rule). */
  const [viewId, setViewId] = useState<string | null>(null);
  /** Ids the user closed without answering; new pendings still auto-open. */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // Connect-time seed: GET /v1/approvals?pending=1 → store (events win).
  useEffect(() => {
    getBridge()
      .listApprovals()
      .then((summaries) => useApprovals.getState().seedFromHttp(summaries))
      .catch(() => {}); // disconnected: replayed events re-derive pendings
  }, []);

  // Force-open any pending approval (chip, transcript cards, palette).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const approvalId = (e as CustomEvent<{ approvalId?: string }>).detail
        ?.approvalId;
      if (!approvalId) return;
      const p = useApprovals.getState().pending[approvalId];
      if (!p) return;
      const sessions = useSessions.getState();
      if (sessions.activeSessionId !== p.sessionId) {
        sessions.setActive(p.sessionId);
      }
      setViewId(approvalId);
    };
    window.addEventListener(OPEN_APPROVAL_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_APPROVAL_EVENT, onOpen);
  }, []);

  // Non-active-session pendings surface as an info toast, once per approvalId.
  useEffect(() => {
    for (const p of Object.values(pending)) {
      if (p.sessionId === activeSessionId || toastedIds.has(p.approvalId)) {
        continue;
      }
      toastedIds.add(p.approvalId);
      // ponytail: toast() has no click handler; the chip covers jump-to-session
      toast(
        `Approval requested in ${sessionsById[p.sessionId]?.title ?? p.sessionId}`,
        { tone: "info" },
      );
    }
  }, [pending, activeSessionId, sessionsById]);

  // What the modal shows: forced view first, else the oldest not-dismissed
  // pending of the active session. Removal (responded/expired/cancelled
  // events) closes it by state, not by memory.
  const forced = viewId !== null ? pending[viewId] : undefined;
  const activePendings = Object.values(pending)
    .filter((p) => p.sessionId === activeSessionId)
    .sort(bySeq);
  const current =
    forced ?? activePendings.find((p) => !dismissed.has(p.approvalId));
  if (!current) return null;

  const list =
    current.sessionId === activeSessionId
      ? activePendings
      : Object.values(pending)
          .filter((p) => p.sessionId === current.sessionId)
          .sort(bySeq);
  const index = list.findIndex((p) => p.approvalId === current.approvalId);

  const close = () => {
    // Dismiss the whole current batch so closing doesn't nag with the next one.
    setDismissed(
      (prev) => new Set([...prev, ...list.map((p) => p.approvalId)]),
    );
    setViewId(null);
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      size="lg"
    >
      <ApprovalDialog
        key={current.approvalId}
        approval={current}
        sessionTitle={
          sessionsById[current.sessionId]?.title ?? current.sessionId
        }
        index={index}
        count={list.length}
        onNav={(dir) => {
          const next = list[index + dir];
          if (next) setViewId(next.approvalId);
        }}
      />
    </Modal>
  );
}

// ---- dialog body (keyed by approvalId so kind-state resets per approval) ----

type ApprovalDialogProps = {
  approval: PendingApproval;
  sessionTitle: string;
  index: number;
  count: number;
  onNav: (dir: -1 | 1) => void;
};

function ApprovalDialog({
  approval,
  sessionTitle,
  index,
  count,
  onNav,
}: ApprovalDialogProps) {
  const { request, sessionId, approvalId } = approval;
  const [submitting, setSubmitting] = useState(false);
  const [optionId, setOptionId] = useState<string | null>(null);
  const [text, setText] = useState(request.defaultValue ?? "");

  const respond = async (response: ApprovalResponse) => {
    setSubmitting(true);
    try {
      await getBridge().respondToApproval(sessionId, approvalId, response);
      useApprovals.getState().remove(approvalId);
      toast(response.kind === "deny" ? "Denied" : "Approved", { tone: "ok" });
    } catch (err) {
      const e = err as Partial<BridgeError>;
      if (e.code === "APPROVAL_NOT_PENDING") {
        // First-write-wins: someone else answered; daemon truth closes us.
        useApprovals.getState().remove(approvalId);
        toast("Already answered by another client", { tone: "info" });
      } else {
        setSubmitting(false); // keep the modal open to retry
        toast(e.message ?? "Failed to respond", { tone: "err" });
      }
    }
  };

  const approve = () => {
    if (request.kind === "confirm") {
      void respond({ kind: "confirm", accepted: true });
    } else if (request.kind === "select") {
      if (optionId !== null) void respond({ kind: "select", optionId });
    } else {
      void respond({ kind: request.kind, text });
    }
  };
  const approveDisabled =
    submitting || (request.kind === "select" && optionId === null);

  // Subject grid: rows only for present fields, every value verbatim.
  const subject = request.subject;
  const rows: Array<[label: string, value: string]> = [];
  if (subject?.toolName !== undefined) rows.push(["tool", subject.toolName]);
  if (subject?.command !== undefined) rows.push(["command", subject.command]);
  if (subject?.cwd !== undefined) rows.push(["cwd", subject.cwd]);
  if (subject?.action !== undefined) rows.push(["action", subject.action]);
  const hasArgs = subject !== undefined && subject.args !== undefined;

  return (
    <>
      <div className="flex items-center gap-2">
        <ModalTitle>Approval requested</ModalTitle>
        <Badge tone="neutral" className="max-w-56 truncate">
          {sessionTitle}
        </Badge>
      </div>
      <ModalDescription className="whitespace-pre-wrap">
        {request.message}
      </ModalDescription>

      {(rows.length > 0 || hasArgs) && (
        <div className="mt-3 grid grid-cols-[max-content_1fr] items-start gap-x-3 gap-y-1 rounded border border-border bg-surface p-2.5 font-mono text-xs">
          {rows.map(([label, value]) => (
            <Fragment key={label}>
              <span className="text-ink-mute">{label}</span>
              <span className="break-all text-ink">{value}</span>
            </Fragment>
          ))}
          {hasArgs && (
            <>
              <span className="text-ink-mute">args</span>
              <details className="min-w-0">
                <summary className="cursor-pointer select-none text-ink-dim hover:text-ink">
                  json
                </summary>
                <CodeBlock
                  code={JSON.stringify(subject?.args, null, 2) ?? "undefined"}
                  lang="json"
                  className="mt-1"
                />
              </details>
            </>
          )}
        </div>
      )}

      {request.kind === "select" && (
        <div
          role="radiogroup"
          aria-label="Options"
          className="mt-3 flex flex-col gap-1"
        >
          {(request.options ?? []).map((o) => (
            <label
              key={o.id}
              className={cx(
                "flex cursor-pointer items-start gap-2 rounded border px-2.5 py-1.5 transition-colors",
                optionId === o.id
                  ? "border-accent bg-accent/10"
                  : "border-border hover:border-border-strong hover:bg-raised",
              )}
            >
              <input
                type="radio"
                name={`approval-${approvalId}`}
                checked={optionId === o.id}
                onChange={() => setOptionId(o.id)}
                disabled={submitting}
                className="mt-0.5 accent-accent"
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-xs text-ink">{o.label}</span>
                {o.description !== undefined && (
                  <span className="text-[11px] text-ink-dim">
                    {o.description}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}

      {request.kind === "input" && (
        <TextInput
          className="mt-3 w-full font-mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={submitting}
        />
      )}

      {request.kind === "editor" && (
        <TextArea
          className="mt-3 w-full font-mono"
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={submitting}
        />
      )}

      {request.expiresAt !== undefined && (
        <Countdown expiresAt={request.expiresAt} />
      )}

      <ModalFooter>
        {count > 1 && (
          <div className="mr-auto flex items-center gap-1 text-xs text-ink-mute">
            <IconButton
              label="Previous approval"
              size="sm"
              disabled={submitting || index <= 0}
              onClick={() => onNav(-1)}
            >
              <ChevronLeft />
            </IconButton>
            <span className="tabular-nums">
              {index + 1} of {count}
            </span>
            <IconButton
              label="Next approval"
              size="sm"
              disabled={submitting || index >= count - 1}
              onClick={() => onNav(1)}
            >
              <ChevronRight />
            </IconButton>
          </div>
        )}
        <Button
          variant="danger"
          disabled={submitting}
          onClick={() => void respond({ kind: "deny" })}
        >
          Deny
        </Button>
        <Button
          variant="solid"
          disabled={approveDisabled}
          onClick={approve}
          icon={submitting ? <Spinner /> : null}
        >
          Approve
        </Button>
      </ModalFooter>
    </>
  );
}

// ---- expiry countdown -----------------------------------------------------

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return null;
  const ms = deadline - now;
  // ponytail: coarse units on purpose — minutes above 60s, whole seconds below
  const label =
    ms <= 0
      ? "expired"
      : ms >= 60_000
        ? `expires in ${Math.floor(ms / 60_000)}m`
        : `expires in ${Math.ceil(ms / 1000)}s`;
  return (
    <div
      className={cx(
        "mt-3 flex items-center gap-1.5 text-[11px]",
        ms < 30_000 ? "text-warn" : "text-ink-mute",
      )}
    >
      <Clock className="size-3" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

// ---- status-bar chip --------------------------------------------------------

export function ApprovalChip() {
  const pending = useApprovals((s) => s.pending);
  const items = oldestFirst(pending);
  if (items.length === 0) return null;
  const n = items.length;

  const open = () => {
    const oldest = items[0];
    if (!oldest) return;
    // The host's listener switches the active session if needed, then opens.
    window.dispatchEvent(
      new CustomEvent(OPEN_APPROVAL_EVENT, {
        detail: { approvalId: oldest.approvalId },
      }),
    );
  };

  return (
    <button
      type="button"
      onClick={open}
      aria-label={`${n} pending approval${n === 1 ? "" : "s"}`}
      className="rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <Badge tone="warn" className="cursor-pointer hover:bg-warn/20">
        <span
          className="size-1.5 animate-pulse rounded-full bg-warn"
          aria-hidden
        />
        {n} approval{n === 1 ? "" : "s"}
      </Badge>
    </button>
  );
}
