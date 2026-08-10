// THE single wire entry: bridge.onBatch(ingestBatch). Order within a batch is
// binding (shared/bridge.ts): events → syncs → snapshots → frames.
import {
  type AgenaEvent,
  approvalRequestedSchema,
  fastModeChangedSchema,
} from "@agena/protocol";
import type { UiBatch } from "../../shared/bridge.ts";
import { useApprovals } from "./approvals.ts";
import { useConnection } from "./connection.ts";
import { useSessions } from "./sessions.ts";
import {
  applyEvent,
  applyFrame,
  applySnapshot,
  getBridge,
  markSynced,
  useTranscripts,
} from "./transcript.ts";

// ---- subscriptions ------------------------------------------------------------

// ponytail: cursors read once per connect generation; live cursor advances
// flow through ingest/markSynced, not this map.
let cursorsPromise: Promise<
  Record<string, { branchId: string; seq: number }>
> | null = null;
const subscribedIds = new Set<string>();

/**
 * THE single subscribe path (no double-subscribe): first call per session wins;
 * Without an explicit cursor, uncached sessions load their newest HTTP page
 * before subscribing; persisted replay is the fallback. Rejects with the
 * bridge error so callers can toast.
 */
export async function ensureSubscribed(
  sessionId: string,
  fromSeq?: number,
): Promise<void> {
  if (!useConnection.getState().info) {
    throw new Error("not connected — call connect() first");
  }
  if (subscribedIds.has(sessionId)) return;
  subscribedIds.add(sessionId);
  try {
    const bridge = getBridge();
    if (!bridge) throw new Error("bridge unavailable");
    let seq = fromSeq;
    if (seq === undefined) {
      cursorsPromise ??= bridge.loadPersisted().then((p) => p.cursors);
      const savedSeq = (await cursorsPromise)[sessionId]?.seq ?? 0;
      const loadedSeq = useTranscripts.getState().bySession[sessionId]?.lastSeq;
      seq = loadedSeq && loadedSeq > 0 ? loadedSeq : savedSeq;
      if (!loadedSeq) {
        const headSeq = useSessions.getState().byId[sessionId]?.lastSeq ?? 0;
        try {
          seq =
            (await useTranscripts.getState().primeRecent(sessionId, headSeq)) ||
            seq;
        } catch {
          // A saved head cursor without hydrated history renders a blank chat.
          // Replay from zero when compact paging is unavailable.
          seq = 0;
        }
      }
    }
    await bridge.subscribe(sessionId, seq);
  } catch (err) {
    subscribedIds.delete(sessionId);
    throw err;
  }
}

/**
 * A fresh connect() tears down the main-process client and every subscription
 * with it — call this right before connecting so ensureSubscribed can
 * re-subscribe everything from disk cursors again. (SDK-level reconnects
 * re-subscribe by themselves; do NOT call this on "reconnecting".)
 */
export function resetSubscriptions(): void {
  subscribedIds.clear();
  cursorsPromise = null;
}

// ---- batch ingest ---------------------------------------------------------------

function routeApprovalEvent(event: AgenaEvent): void {
  if (event.type === "approval.requested") {
    const p = approvalRequestedSchema.safeParse(event.payload);
    if (!p.success) return; // malformed → transcript already rendered a marker
    useApprovals.getState().add({
      sessionId: event.sessionId,
      approvalId: p.data.approvalId,
      seq: event.seq,
      requestedAt: event.createdAt,
      request: p.data,
    });
    return;
  }
  if (
    event.type === "approval.responded" ||
    event.type === "approval.expired" ||
    event.type === "approval.cancelled"
  ) {
    const id = (event.payload as { approvalId?: unknown } | null)?.approvalId;
    if (typeof id === "string") useApprovals.getState().remove(id);
  }
}

function routeSessionEvent(event: AgenaEvent): void {
  if (event.type === "fast.mode.changed") {
    const payload = fastModeChangedSchema.safeParse(event.payload);
    if (payload.success) {
      useConnection
        .getState()
        .setFastMode(event.sessionId, payload.data.enabled);
    }
    return;
  }
  if (event.type !== "session.title.changed") return;
  const title = (event.payload as { title?: unknown } | null)?.title;
  if (typeof title === "string") {
    useSessions.getState().setTitle(event.sessionId, title);
  }
}

export function ingestBatch(batch: UiBatch): void {
  const transcripts = useTranscripts.getState();
  const sessions = useSessions.getState();

  for (const { event, replayed } of batch.events) {
    const prev = useTranscripts.getState().bySession[event.sessionId];
    if (prev && event.seq <= prev.lastSeq) continue; // duplicate delivery
    transcripts.update(event.sessionId, (t) => applyEvent(t, event, replayed));
    routeApprovalEvent(event);
    routeSessionEvent(event);
    sessions.bump(event.sessionId, event.seq, event.createdAt);
  }

  for (const sync of batch.syncs) {
    transcripts.update(sync.sessionId, (t) => ({
      ...markSynced(t, sync.upToSeq),
      branchId: t.branchId ?? sync.branchId,
    }));
  }

  for (const snap of batch.snapshots) {
    transcripts.update(snap.sessionId, (t) => applySnapshot(t, snap));
  }

  for (const frame of batch.frames) {
    transcripts.update(frame.sessionId, (t) => applyFrame(t, frame));
  }

  for (const sessionId of batch.lostSessions) {
    sessions.markLost(sessionId);
  }
}
