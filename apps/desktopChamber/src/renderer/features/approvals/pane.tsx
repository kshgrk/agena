// Approvals host — mounted ALWAYS by the shell (not a dockview panel).
// Non-blocking surface: a banner queue floating at the top of the transcript
// area for the ACTIVE session, a global all-sessions popover, and a focused
// modal opened on demand (statusbar chip → OPEN_APPROVAL_EVENT, transcript
// "Review…" affordances, the command palette, banner maximize buttons).
// Pending state is re-derived (events + connect-time HTTP seed in
// connectAndBootstrap), never memory.
import { ChevronLeft, ChevronRight, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { OPEN_APPROVAL_EVENT } from "../../shell/panes.ts";
import type { PendingApproval } from "../../store/index.ts";
import {
  registerCommands,
  useApprovals,
  useSessions,
  useUi,
} from "../../store/index.ts";
import {
  Badge,
  Button,
  Dialog,
  DialogTitle,
  IconButton,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  RelativeTime,
} from "../../ui/index.ts";
import { pushToastWithAction } from "../toasts/push.ts";
import { ApprovalCard, Countdown } from "./card.tsx";
import {
  approvalTitle,
  oldestFirst,
  sessionQueue,
  subjectSummary,
} from "./model.ts";

/** Once-per-approvalId toast guard (module scope survives StrictMode remounts). */
const toastedIds = new Set<string>();

/** Banners rendered before the queue collapses into a "review all" row. */
const MAX_BANNERS = 3;

const openApprovalEvent = (approvalId: string) =>
  window.dispatchEvent(
    new CustomEvent(OPEN_APPROVAL_EVENT, { detail: { approvalId } }),
  );

// Palette entry (ARCHITECTURE contract 2; registered once at module init).
registerCommands([
  {
    id: "approvals.review",
    title: "Review Pending Approvals",
    group: "Session",
    keywords: ["approve", "deny", "pending", "permission"],
    when: () => Object.keys(useApprovals.getState().pending).length > 0,
    run: () => {
      const oldest = oldestFirst(useApprovals.getState().pending)[0];
      if (oldest) openApprovalEvent(oldest.approvalId);
    },
  },
]);

function sessionLabel(sessionId: string): string {
  return (
    useSessions.getState().byId[sessionId]?.title ??
    `session ${sessionId.slice(-6)}`
  );
}

// ---- banner ---------------------------------------------------------------------

function ApprovalBanner({
  approval,
  onReview,
}: {
  approval: PendingApproval;
  onReview: () => void;
}) {
  return (
    <div className="pointer-events-auto w-full rounded-lg border border-warn/35 bg-warn/10 p-3 shadow-md animate-fade-slide-in">
      <ApprovalCard approval={approval} variant="banner" onReview={onReview} />
    </div>
  );
}

// ---- global list popover ------------------------------------------------------------

function GlobalListPopover({
  all,
  label,
  onOpen,
}: {
  all: PendingApproval[];
  label: string;
  onOpen: (p: PendingApproval) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger>
        <Button
          size="sm"
          className="pointer-events-auto shadow-md"
          icon={<ShieldAlert className="text-warn" />}
        >
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-96 max-h-80 overflow-y-auto">
        <div className="px-2 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wider text-fg-muted">
          Pending approvals
        </div>
        {all.map((p) => {
          const summary = subjectSummary(p.request);
          return (
            <PopoverClose asChild key={p.approvalId}>
              <button
                type="button"
                onClick={() => onOpen(p)}
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-fg/6"
              >
                <span className="flex w-full items-baseline gap-2">
                  <span className="min-w-0 truncate text-sm text-fg">
                    {approvalTitle(p.request)}
                  </span>
                  <RelativeTime
                    iso={p.requestedAt}
                    className="ml-auto shrink-0 text-2xs text-fg-faint"
                  />
                </span>
                <span className="flex w-full items-center gap-1.5 text-xs text-fg-muted">
                  <span className="status-dot shrink-0 bg-warn" aria-hidden />
                  <span className="shrink-0">{sessionLabel(p.sessionId)}</span>
                  {summary !== null ? (
                    <span className="min-w-0 truncate font-mono">
                      · {summary}
                    </span>
                  ) : null}
                </span>
              </button>
            </PopoverClose>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

// ---- the host --------------------------------------------------------------------

export function ApprovalsHost() {
  const pending = useApprovals((s) => s.pending);
  const activeSessionId = useSessions((s) => s.activeSessionId);
  /** Focused modal target; the queue advances/closes by state when it resolves. */
  const [modal, setModal] = useState<{
    approvalId: string;
    sessionId: string;
  } | null>(null);

  const openApproval = (p: PendingApproval) => {
    const sessions = useSessions.getState();
    if (sessions.activeSessionId !== p.sessionId)
      sessions.setActive(p.sessionId);
    setModal({ approvalId: p.approvalId, sessionId: p.sessionId });
  };

  // Force-open requests (statusbar chip, transcript cards, palette, toasts).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const approvalId = (e as CustomEvent<{ approvalId?: string }>).detail
        ?.approvalId;
      if (!approvalId) return;
      const p = useApprovals.getState().pending[approvalId];
      if (p) openApproval(p);
    };
    window.addEventListener(OPEN_APPROVAL_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_APPROVAL_EVENT, onOpen);
  }, []);

  // Non-active-session pendings surface once as an actionable toast.
  useEffect(() => {
    for (const p of Object.values(pending)) {
      if (p.sessionId === activeSessionId || toastedIds.has(p.approvalId)) {
        continue;
      }
      toastedIds.add(p.approvalId);
      pushToastWithAction({
        kind: "warn",
        title: `Approval requested in ${sessionLabel(p.sessionId)}`,
        detail: approvalTitle(p.request),
        action: {
          label: "Review",
          run: () => openApprovalEvent(p.approvalId),
        },
      });
    }
  }, [pending, activeSessionId]);

  // Modal target answered/expired/cancelled → advance to the session's next
  // pending (head of queue), else close. State-derived, not memory.
  useEffect(() => {
    if (modal === null || pending[modal.approvalId] !== undefined) return;
    const next = sessionQueue(pending, modal.sessionId)[0];
    setModal(
      next ? { approvalId: next.approvalId, sessionId: next.sessionId } : null,
    );
  }, [pending, modal]);

  const current = modal !== null ? pending[modal.approvalId] : undefined;

  // D-INV-3: the native browser view paints above renderer DOM — count the
  // modal as an overlay so the host hides it.
  const modalUp = current !== undefined;
  useEffect(() => {
    if (!modalUp) return;
    useUi.getState().enterOverlay();
    return () => useUi.getState().exitOverlay();
  }, [modalUp]);

  const activeQueue = sessionQueue(pending, activeSessionId);
  const all = oldestFirst(pending);
  const others = all.filter((p) => p.sessionId !== activeSessionId);
  const modalQueue =
    modal !== null ? sessionQueue(pending, modal.sessionId) : [];
  const modalIndex =
    current !== undefined
      ? modalQueue.findIndex((p) => p.approvalId === current.approvalId)
      : -1;

  return (
    <>
      {activeQueue.length > 0 || others.length > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 top-12 z-30 flex flex-col items-center gap-2 px-4">
          <div className="flex w-full max-w-xl flex-col items-center gap-2">
            {activeQueue.slice(0, MAX_BANNERS).map((p) => (
              <ApprovalBanner
                key={p.approvalId}
                approval={p}
                onReview={() => openApproval(p)}
              />
            ))}
            <div className="flex items-center gap-2">
              {activeQueue.length > MAX_BANNERS ? (
                <Button
                  size="sm"
                  className="pointer-events-auto shadow-md"
                  onClick={() => {
                    const head = activeQueue[0];
                    if (head) openApproval(head);
                  }}
                >
                  Review all ({activeQueue.length})
                </Button>
              ) : null}
              {others.length > 0 ? (
                <GlobalListPopover
                  all={all}
                  label={
                    activeQueue.length > 0
                      ? `${others.length} in other session${others.length === 1 ? "" : "s"}`
                      : `${others.length} pending approval${others.length === 1 ? "" : "s"}`
                  }
                  onOpen={openApproval}
                />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {current !== undefined ? (
        <Dialog
          open
          size="lg"
          onOpenChange={(open) => {
            if (!open) setModal(null); // Esc/backdrop: dismiss without responding
          }}
        >
          <div className="mb-3 flex items-center gap-2">
            <DialogTitle className="min-w-0 truncate">
              {approvalTitle(current.request)}
            </DialogTitle>
            <Badge tone="warn" className="max-w-56 shrink-0 truncate">
              {sessionLabel(current.sessionId)}
            </Badge>
            <span className="flex-1" />
            {current.request.expiresAt !== undefined ? (
              <Countdown expiresAt={current.request.expiresAt} />
            ) : null}
          </div>
          <ApprovalCard
            key={current.approvalId}
            approval={current}
            variant="modal"
          />
          {modalQueue.length > 1 ? (
            <div className="mt-3 flex items-center justify-center gap-1 text-xs text-fg-muted tabular-nums">
              <IconButton
                label="Previous approval"
                size="sm"
                noTooltip
                disabled={modalIndex <= 0}
                onClick={() => {
                  const prev = modalQueue[modalIndex - 1];
                  if (prev) openApproval(prev);
                }}
              >
                <ChevronLeft />
              </IconButton>
              <span>
                {modalIndex + 1} of {modalQueue.length}
              </span>
              <IconButton
                label="Next approval"
                size="sm"
                noTooltip
                disabled={modalIndex >= modalQueue.length - 1}
                onClick={() => {
                  const next = modalQueue[modalIndex + 1];
                  if (next) openApproval(next);
                }}
              >
                <ChevronRight />
              </IconButton>
            </div>
          ) : null}
        </Dialog>
      ) : null}
    </>
  );
}
