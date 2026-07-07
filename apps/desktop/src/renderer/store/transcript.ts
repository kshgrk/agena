// Pure transcript reducers (D-INV-5): durable events finalize, frames touch
// in-flight state only, malformed known payloads become marker blocks, unknown
// types become neutral markers and never crash (D-INV-6). Richer twin of
// packages/tui/src/store.ts. The zustand container at the bottom is plumbing.
import {
  type AgenaEvent,
  type AgenaFrame,
  durableEventSchemas,
  type EventSource,
  type InFlightSnapshot,
  knownAgenaEventSchema,
  knownAgenaFrameSchema,
} from "@agena/protocol";
import { create } from "zustand";
import type { AgenaBridge } from "../../shared/bridge.ts";
import { peekBridge } from "../lib/bridge.ts";
import {
  type ApprovalBlock,
  type Block,
  emptyTranscript,
  type InFlightTail,
  type MarkerKind,
  type RawEventRow,
  type ToolBlock,
  type TranscriptState,
} from "./types.ts";

// ---- shared helpers ----------------------------------------------------------

/** Bridge accessor; null in tests / before any bridge is installed. */
export function getBridge(): AgenaBridge | null {
  return peekBridge();
}

type BlockBase = { seq: number; at: string; source: EventSource };

function baseOf(event: AgenaEvent): BlockBase {
  return { seq: event.seq, at: event.createdAt, source: event.source };
}

function rawRow(event: AgenaEvent): RawEventRow {
  return {
    seq: event.seq,
    type: event.type,
    at: event.createdAt,
    source: event.source,
    payload: event.payload,
  };
}

/** Mutable working set the per-event mapping writes into (applyEvent copies
 * from state; prependOlderEvents starts empty and re-bases afterwards). */
type Draft = {
  blocks: Block[];
  toolIndex: Record<string, number>;
  approvalIndex: Record<string, number>;
  inFlight: InFlightTail | null;
};

function marker(base: BlockBase, markerKind: MarkerKind, text: string): Block {
  return { ...base, kind: "marker", markerKind, text };
}

function patchTool(
  d: Draft,
  toolCallId: string,
  patch: Partial<ToolBlock>,
): void {
  const i = d.toolIndex[toolCallId];
  if (i === undefined) return;
  const b = d.blocks[i];
  if (b?.kind !== "tool") return;
  d.blocks[i] = { ...b, ...patch };
}

function patchApproval(
  d: Draft,
  approvalId: string,
  patch: Partial<ApprovalBlock>,
): void {
  const i = d.approvalIndex[approvalId];
  if (i === undefined) return;
  const b = d.blocks[i];
  if (b?.kind !== "approval") return;
  d.blocks[i] = { ...b, ...patch };
}

// ---- the per-event mapping (shared by applyEvent and prependOlderEvents) ------

function reduceEvent(d: Draft, event: AgenaEvent): void {
  const parsed = knownAgenaEventSchema.safeParse(event);
  const base = baseOf(event);
  if (!parsed.success) {
    if (event.type in durableEventSchemas) {
      d.blocks.push(
        marker(
          base,
          "malformed",
          `malformed event ${event.type} (seq ${event.seq})`,
        ),
      );
    } else {
      d.blocks.push(
        marker(base, "unknown", `event ${event.type} (seq ${event.seq})`),
      );
    }
    return;
  }
  const ev = parsed.data;
  switch (ev.type) {
    case "message.user.created": {
      const p = ev.payload;
      d.blocks.push({
        ...base,
        kind: "user",
        messageId: p.messageId,
        content: p.content,
        ...(p.queued ? { queued: p.queued } : {}),
      });
      break;
    }
    case "message.assistant.started":
      d.inFlight = {
        messageId: ev.payload.messageId,
        model: ev.payload.model,
        blocks: [],
      };
      break;
    case "message.assistant.completed": {
      const p = ev.payload;
      // authoritative content REPLACES whatever the delta buffer accumulated (P12)
      d.blocks.push({
        ...base,
        kind: "assistant",
        messageId: p.messageId,
        content: p.content,
        model: p.model,
        status: "completed",
        stopReason: p.stopReason,
        ...(p.usage ? { usage: p.usage } : {}),
      });
      if (d.inFlight?.messageId === p.messageId) d.inFlight = null;
      break;
    }
    case "message.assistant.aborted": {
      const p = ev.payload;
      const match = d.inFlight?.messageId === p.messageId ? d.inFlight : null;
      d.blocks.push({
        ...base,
        kind: "assistant",
        messageId: p.messageId,
        content: p.partialContent,
        status: "aborted",
        abortReason: p.reason,
        ...(match?.model ? { model: match.model } : {}),
      });
      if (match) d.inFlight = null;
      break;
    }
    case "message.assistant.failed": {
      const p = ev.payload;
      const match = d.inFlight?.messageId === p.messageId ? d.inFlight : null;
      d.blocks.push({
        ...base,
        kind: "assistant",
        messageId: p.messageId,
        content: p.partialContent,
        status: "failed",
        error: p.error,
        ...(match?.model ? { model: match.model } : {}),
      });
      if (match) d.inFlight = null;
      break;
    }
    case "message.runtime.created": {
      const p = ev.payload;
      const meta = p.meta
        ? {
            ...(p.meta.command !== undefined
              ? { command: p.meta.command }
              : {}),
            ...(p.meta.exitCode !== undefined
              ? { exitCode: p.meta.exitCode }
              : {}),
            ...(p.meta.customType !== undefined
              ? { customType: p.meta.customType }
              : {}),
          }
        : undefined;
      d.blocks.push({
        ...base,
        kind: "runtime",
        messageId: p.messageId,
        runtimeType: p.runtimeType,
        content: p.content,
        ...(meta ? { meta } : {}),
      });
      break;
    }
    case "tool.call.started": {
      const p = ev.payload;
      d.toolIndex[p.toolCallId] = d.blocks.length;
      d.blocks.push({
        ...base,
        kind: "tool",
        toolCallId: p.toolCallId,
        name: p.name,
        args: p.args,
        status: "running",
        liveOutput: "",
      });
      break;
    }
    case "tool.call.completed": {
      const p = ev.payload;
      patchTool(d, p.toolCallId, {
        status: "completed",
        result: p.result,
        durationMs: p.durationMs,
      });
      break;
    }
    case "tool.call.failed": {
      const p = ev.payload;
      patchTool(d, p.toolCallId, {
        status: "failed",
        error: p.error,
        ...(p.partialOutput ? { partialOutput: p.partialOutput } : {}),
        ...(p.durationMs !== undefined ? { durationMs: p.durationMs } : {}),
      });
      break;
    }
    case "tool.call.aborted": {
      const p = ev.payload;
      patchTool(d, p.toolCallId, {
        status: "aborted",
        partialOutput: p.partialOutput,
        abortReason: p.reason,
      });
      break;
    }
    case "tool.call.denied": {
      const p = ev.payload;
      patchTool(d, p.toolCallId, {
        status: "denied",
        deniedReason: p.reason,
        ...(p.approvalId ? { approvalId: p.approvalId } : {}),
      });
      break;
    }
    case "approval.requested": {
      const p = ev.payload;
      d.approvalIndex[p.approvalId] = d.blocks.length;
      d.blocks.push({
        ...base,
        kind: "approval",
        approvalId: p.approvalId,
        request: p,
        state: "pending",
      });
      break;
    }
    case "approval.responded": {
      const p = ev.payload;
      patchApproval(d, p.approvalId, {
        state: "responded",
        response: p.response,
        respondedBy: p.respondedBy,
      });
      break;
    }
    case "approval.expired":
      patchApproval(d, ev.payload.approvalId, { state: "expired" });
      break;
    case "approval.cancelled":
      patchApproval(d, ev.payload.approvalId, {
        state: "cancelled",
        cancelReason: ev.payload.reason,
      });
      break;
    case "model.changed": {
      const to = ev.payload.to;
      d.blocks.push(marker(base, "model", `model → ${to.provider}/${to.id}`));
      break;
    }
    case "thinking.level.changed":
      d.blocks.push(marker(base, "thinking", `thinking → ${ev.payload.to}`));
      break;
    case "compaction.created":
      d.blocks.push(
        marker(
          base,
          "compaction",
          `compacted history up to seq ${ev.payload.replacesUpToSeq}`,
        ),
      );
      break;
    case "compaction.failed":
      d.blocks.push(
        marker(
          base,
          "compaction-failed",
          `compaction failed: ${ev.payload.error.code}`,
        ),
      );
      break;
    case "terminal.session.started":
      d.blocks.push(
        marker(base, "terminal-start", `terminal opened (${ev.payload.shell})`),
      );
      break;
    case "terminal.session.ended": {
      const p = ev.payload;
      d.blocks.push(
        marker(
          base,
          "terminal-end",
          `terminal closed${p.exitCode !== null ? ` (exit ${p.exitCode})` : ""}`,
        ),
      );
      break;
    }
    case "run.failed": {
      const p = ev.payload;
      d.blocks.push(
        marker(
          base,
          "run-failed",
          `run failed${p.phase ? ` at ${p.phase}` : ""}: ${p.error.code}`,
        ),
      );
      break;
    }
    // session/run/snapshot lifecycle stays out of the block list; the timeline
    // reads rawEvents.
    case "session.created":
    case "run.started":
    case "run.completed":
    case "run.aborted":
    case "snapshot.created":
    case "snapshot.restored":
    case "snapshot.restore_failed":
    case "snapshot.deleted":
      break;
  }
}

// ---- pure reducers -------------------------------------------------------------

export function applyEvent(
  state: TranscriptState,
  event: AgenaEvent,
  _replayed: boolean,
): TranscriptState {
  if (event.seq <= state.lastSeq) return state; // duplicate/older: drop
  const d: Draft = {
    blocks: [...state.blocks],
    toolIndex: { ...state.toolIndex },
    approvalIndex: { ...state.approvalIndex },
    inFlight: state.inFlight,
  };
  reduceEvent(d, event);
  return {
    ...state,
    branchId: state.branchId ?? event.branchId,
    blocks: d.blocks,
    toolIndex: d.toolIndex,
    approvalIndex: d.approvalIndex,
    inFlight: d.inFlight,
    rawEvents: [...state.rawEvents, rawRow(event)],
    lastSeq: event.seq,
  };
}

/** Frames touch in-flight state only; nothing is trusted before the sync. */
export function applyFrame(
  state: TranscriptState,
  frame: AgenaFrame,
): TranscriptState {
  const parsed = knownAgenaFrameSchema.safeParse(frame);
  if (!parsed.success || !state.live) return state;
  const f = parsed.data;
  if (f.type === "message.assistant.text.delta") {
    const p = f.payload;
    if (!state.inFlight || state.inFlight.messageId !== p.messageId) {
      return state; // mistargeted/stale delta: drop
    }
    const blocks = [...state.inFlight.blocks];
    while (blocks.length <= p.blockIndex)
      blocks.push({ type: "text", text: "" });
    const target = blocks[p.blockIndex];
    if (!target) return state;
    blocks[p.blockIndex] = { ...target, text: target.text + p.delta };
    return { ...state, inFlight: { ...state.inFlight, blocks } };
  }
  // tool.call.output.delta
  const p = f.payload;
  const i = state.toolIndex[p.toolCallId];
  if (i === undefined) return state;
  const b = state.blocks[i];
  if (b?.kind !== "tool") return state;
  const blocks = [...state.blocks];
  blocks[i] = { ...b, liveOutput: p.reset ? p.delta : b.liveOutput + p.delta };
  return { ...state, blocks };
}

/** Seeds the streaming tail + running tool output from the wire snapshot. */
export function applySnapshot(
  state: TranscriptState,
  snap: InFlightSnapshot,
): TranscriptState {
  let inFlight: InFlightTail | null = null;
  if (snap.assistant) {
    inFlight = {
      messageId: snap.assistant.messageId,
      model: snap.assistant.model,
      blocks: snap.assistant.blocks.map((b) =>
        b.type === "text" || b.type === "thinking"
          ? { type: b.type, text: b.text }
          : { type: "text" as const, text: "" },
      ),
    };
  }
  const blocks = [...state.blocks];
  for (const tc of snap.toolCalls) {
    const out = tc.partialOutput;
    if (out === undefined) continue;
    const i = state.toolIndex[tc.toolCallId];
    if (i === undefined) continue;
    const b = blocks[i];
    if (b?.kind !== "tool" || b.status !== "running") continue;
    blocks[i] = { ...b, liveOutput: out };
  }
  return {
    ...state,
    blocks,
    inFlight,
    runtimeStatus: {
      state: snap.status.state,
      ...(snap.status.detail !== undefined
        ? { detail: snap.status.detail }
        : {}),
    },
    queue: snap.queue,
  };
}

/**
 * Prepend an older, seq-ascending page (all seq < current oldest). Terminal
 * tool/approval events whose start block is inside the page resolve within it;
 * existing indices shift by the number of prepended blocks.
 */
export function prependOlderEvents(
  state: TranscriptState,
  events: AgenaEvent[],
): TranscriptState {
  if (events.length === 0) return state;
  const d: Draft = {
    blocks: [],
    toolIndex: {},
    approvalIndex: {},
    inFlight: null,
  };
  const raw: RawEventRow[] = [];
  for (const event of events) {
    reduceEvent(d, event);
    raw.push(rawRow(event));
  }
  const shift = d.blocks.length;
  const rebase = (idx: Readonly<Record<string, number>>) =>
    Object.fromEntries(Object.entries(idx).map(([k, v]) => [k, v + shift]));
  return {
    ...state,
    blocks: [...d.blocks, ...state.blocks],
    rawEvents: [...raw, ...state.rawEvents],
    // the page's own entries (earlier starts) win on collision
    toolIndex: { ...rebase(state.toolIndex), ...d.toolIndex },
    approvalIndex: { ...rebase(state.approvalIndex), ...d.approvalIndex },
  };
}

/** The sync envelope arrived: frames are trustworthy from here. */
export function markSynced(
  state: TranscriptState,
  upToSeq: number,
): TranscriptState {
  return { ...state, live: true, lastSeq: Math.max(state.lastSeq, upToSeq) };
}

// ---- store ----------------------------------------------------------------------

const PAGE = 200;

export type TranscriptsStore = {
  bySession: Readonly<Record<string, TranscriptState>>;
  loadingOlder: Readonly<Record<string, boolean>>;
  /** ingest-internal: apply a reducer to one session's transcript. */
  update: (
    sessionId: string,
    fn: (t: TranscriptState) => TranscriptState,
  ) => void;
  /** Backward-page older events for a session via the bridge. */
  prependOlder: (sessionId: string) => Promise<void>;
};

export const transcriptsInitial = {
  bySession: {},
  loadingOlder: {},
} as const;

export const useTranscripts = create<TranscriptsStore>((set, get) => ({
  ...transcriptsInitial,
  update: (sessionId, fn) =>
    set((s) => {
      const cur = s.bySession[sessionId] ?? emptyTranscript(sessionId);
      const next = fn(cur);
      if (next === cur && s.bySession[sessionId]) return s;
      return { bySession: { ...s.bySession, [sessionId]: next } };
    }),
  prependOlder: async (sessionId) => {
    const bridge = getBridge();
    const t = get().bySession[sessionId];
    if (!bridge || !t || get().loadingOlder[sessionId]) return;
    const oldest = t.rawEvents[0]?.seq ?? t.lastSeq + 1;
    if (oldest <= 1) return; // already at the beginning
    const fromSeq = Math.max(0, oldest - 1 - PAGE);
    set((s) => ({ loadingOlder: { ...s.loadingOlder, [sessionId]: true } }));
    try {
      const page = await bridge.readEvents(sessionId, { fromSeq, limit: PAGE });
      // ascending from fromSeq; keep strictly-older events only
      const older = page.events.filter((e) => e.seq < oldest);
      if (older.length > 0) {
        get().update(sessionId, (cur) => prependOlderEvents(cur, older));
      }
    } finally {
      set((s) => ({ loadingOlder: { ...s.loadingOlder, [sessionId]: false } }));
    }
  },
}));
