// Cross-session pending approvals: derived from events + the connect-time
// HTTP scan (plan §7.7, D-INV-3). Pending is re-derived state, not memory.
import type { PendingApprovalSummary } from "@agena/protocol";
import { create } from "zustand";
import type { ApprovalsState, PendingApproval } from "./types.ts";

export type ApprovalsStore = ApprovalsState & {
  /** Connect-time GET /v1/approvals?pending=1; event-derived entries win. */
  seedFromHttp: (summaries: PendingApprovalSummary[]) => void;
  add: (approval: PendingApproval) => void;
  remove: (approvalId: string) => void;
};

export const approvalsInitial: ApprovalsState = { pending: {} };

export const useApprovals = create<ApprovalsStore>((set) => ({
  ...approvalsInitial,
  seedFromHttp: (summaries) =>
    set((s) => {
      const seeded: Record<string, PendingApproval> = {};
      for (const a of summaries) {
        seeded[a.approvalId] = {
          sessionId: a.sessionId,
          approvalId: a.approvalId,
          seq: a.seq,
          requestedAt: a.requestedAt,
          request: a.payload,
        };
      }
      return { pending: { ...seeded, ...s.pending } };
    }),
  add: (approval) =>
    set((s) => ({
      pending: { ...s.pending, [approval.approvalId]: approval },
    })),
  remove: (approvalId) =>
    set((s) => {
      if (!(approvalId in s.pending)) return s;
      const pending = { ...s.pending };
      delete pending[approvalId];
      return { pending };
    }),
}));
