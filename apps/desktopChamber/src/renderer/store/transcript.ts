// Pure transcript reducers (D-INV-5): durable events finalize, frames touch
// in-flight state only, malformed known payloads become marker blocks, unknown
// types become neutral markers and never crash (D-INV-6). Ported from
// Agena's legacy renderer (battle-tested). The zustand
// container at the bottom is plumbing.
import {
  type AgenaEvent,
  type AgenaFrame,
  type CompactTranscriptEntry,
  type CompactTranscriptResponse,
  type CompactTranscriptTurn,
  type ContentBlock,
  contentBlockSchema,
  durableEventSchemas,
  type EventSource,
  type InFlightSnapshot,
  knownAgenaEventSchema,
  knownAgenaFrameSchema,
  type ToolCallDetail,
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
  type UserBlock,
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
  runtimeStatus: TranscriptState["runtimeStatus"];
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
        ...(p.editedFromMessageId
          ? { editedFromMessageId: p.editedFromMessageId }
          : {}),
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
      d.runtimeStatus = { state: "idle" };
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
    case "run.started":
      d.runtimeStatus = { state: "generating" };
      break;
    case "run.completed":
    case "run.aborted":
      d.runtimeStatus = { state: "idle" };
      break;
    case "session.created":
    case "session.title.changed":
    case "fast.mode.changed":
    case "snapshot.created":
    case "snapshot.restored":
    case "snapshot.restore_failed":
    case "snapshot.deleted":
      break;
  }
}

/** Pi keeps edited alternatives in one tree; the main view follows its active path. */
export function activeBranchBlocks(
  events: readonly RawEventRow[],
  blocks: readonly Block[],
): readonly Block[] {
  const users = events
    .filter((event) => event.type === "message.user.created")
    .map((event) => {
      const payload = event.payload as {
        messageId?: unknown;
        editedFromMessageId?: unknown;
      };
      return {
        seq: event.seq,
        messageId:
          typeof payload.messageId === "string" ? payload.messageId : "",
        editedFromMessageId:
          typeof payload.editedFromMessageId === "string"
            ? payload.editedFromMessageId
            : undefined,
      };
    })
    .filter((user) => user.messageId.length > 0);
  if (users.length < 2 || !users.some((user) => user.editedFromMessageId)) {
    return blocks;
  }

  const byId = new Map(users.map((user) => [user.messageId, user]));
  const previous = new Map<string, string | undefined>();
  for (let index = 0; index < users.length; index += 1) {
    previous.set(users[index]?.messageId ?? "", users[index - 1]?.messageId);
  }
  const activeIds = new Set<string>();
  let current = users.at(-1);
  while (current && !activeIds.has(current.messageId)) {
    activeIds.add(current.messageId);
    const parentId = current.editedFromMessageId
      ? previous.get(current.editedFromMessageId)
      : previous.get(current.messageId);
    current = parentId ? byId.get(parentId) : undefined;
  }
  const assistantUsers = new Map<string, string>();
  const toolUsers = new Map<string, string>();
  const approvalUsers = new Map<string, string>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.type === "message.assistant.started") {
      if (
        typeof payload.messageId === "string" &&
        typeof payload.inResponseTo === "string"
      ) {
        assistantUsers.set(payload.messageId, payload.inResponseTo);
      }
    } else if (event.type === "tool.call.started") {
      if (
        typeof payload.toolCallId === "string" &&
        typeof payload.messageId === "string"
      ) {
        const userId = assistantUsers.get(payload.messageId);
        if (userId) toolUsers.set(payload.toolCallId, userId);
      }
    } else if (event.type === "approval.requested") {
      if (
        typeof payload.approvalId === "string" &&
        typeof payload.toolCallId === "string"
      ) {
        const userId = toolUsers.get(payload.toolCallId);
        if (userId) approvalUsers.set(payload.approvalId, userId);
      }
    }
  }

  const isActive = (messageId: string | undefined) =>
    messageId !== undefined && activeIds.has(messageId);
  return blocks.filter((block) => {
    switch (block.kind) {
      case "user":
        return activeIds.has(block.messageId);
      case "assistant":
        return isActive(assistantUsers.get(block.messageId));
      case "tool":
        return isActive(toolUsers.get(block.toolCallId));
      case "approval":
        return isActive(approvalUsers.get(block.approvalId));
      default:
        return true;
    }
  });
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
    runtimeStatus: state.runtimeStatus,
  };
  reduceEvent(d, event);
  return {
    ...state,
    branchId: state.branchId ?? event.branchId,
    blocks: d.blocks,
    toolIndex: d.toolIndex,
    approvalIndex: d.approvalIndex,
    inFlight: d.inFlight,
    runtimeStatus: d.runtimeStatus,
    rawEvents: [...state.rawEvents, rawRow(event)],
    lastSeq: event.seq,
    ...(event.type === "message.user.created" && !state.hasNewerHistory
      ? {
          lastHistoryMessageId:
            typeof (event.payload as { messageId?: unknown }).messageId ===
            "string"
              ? (event.payload as { messageId: string }).messageId
              : state.lastHistoryMessageId,
        }
      : {}),
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
  switch (f.type) {
    case "message.assistant.text.delta": {
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
    case "tool.call.output.delta": {
      const p = f.payload;
      const i = state.toolIndex[p.toolCallId];
      if (i === undefined) return state;
      const b = state.blocks[i];
      if (b?.kind !== "tool") return state;
      const blocks = [...state.blocks];
      blocks[i] = {
        ...b,
        liveOutput: p.reset ? p.delta : b.liveOutput + p.delta,
      };
      return { ...state, blocks };
    }
    case "session.status.updated":
      return {
        ...state,
        runtimeStatus: {
          state: f.payload.state,
          ...(f.payload.detail !== undefined
            ? { detail: f.payload.detail }
            : {}),
        },
      };
    case "compaction.started":
    case "run.retry.started":
    case "run.retry.ended":
      return state;
  }
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
    runtimeStatus: null,
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
const REVEAL_PAGE = 1_000;
const COMPACT_TURNS = 10;
const compactWindowCache = new Map<string, CompactTranscriptResponse>();

export function clearTranscriptWindowCache(): void {
  compactWindowCache.clear();
}

function cacheCompactWindow(response: CompactTranscriptResponse): void {
  for (const turn of response.turns) {
    const key = `${response.sessionId}:${turn.user.messageId}`;
    compactWindowCache.delete(key);
    compactWindowCache.set(key, response);
  }
  while (compactWindowCache.size > 100) {
    const oldest = compactWindowCache.keys().next().value;
    if (typeof oldest !== "string") break;
    compactWindowCache.delete(oldest);
  }
}

function blockKey(block: Block): string {
  switch (block.kind) {
    case "user":
    case "assistant":
    case "runtime":
      return `${block.kind}:${block.messageId}`;
    case "tool":
      return `tool:${block.toolCallId}`;
    case "approval":
      return `approval:${block.approvalId}`;
    case "marker":
      return `marker:${block.seq}:${block.markerKind}`;
  }
}

function compactEntryBlock(entry: CompactTranscriptEntry): Block {
  const base = { seq: entry.seq, at: entry.at, source: entry.source };
  switch (entry.kind) {
    case "assistant":
      return {
        ...base,
        kind: "assistant",
        messageId: entry.messageId,
        content: entry.content,
        status: entry.status,
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.stopReason ? { stopReason: entry.stopReason } : {}),
        ...(entry.usage ? { usage: entry.usage } : {}),
        ...(entry.abortReason ? { abortReason: entry.abortReason } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      };
    case "runtime": {
      const meta = entry.meta
        ? {
            ...(entry.meta.command !== undefined
              ? { command: entry.meta.command }
              : {}),
            ...(entry.meta.exitCode !== undefined
              ? { exitCode: entry.meta.exitCode }
              : {}),
            ...(entry.meta.customType !== undefined
              ? { customType: entry.meta.customType }
              : {}),
          }
        : undefined;
      return {
        ...base,
        kind: "runtime",
        messageId: entry.messageId,
        runtimeType: entry.runtimeType,
        content: entry.content,
        ...(meta ? { meta } : {}),
      };
    }
    case "tool":
      return {
        ...base,
        kind: "tool",
        toolCallId: entry.toolCallId,
        name: entry.name,
        args: entry.argsPreview,
        status: entry.status,
        liveOutput: "",
        ...(entry.durationMs !== undefined
          ? { durationMs: entry.durationMs }
          : {}),
        ...(entry.media && entry.media.length > 0
          ? { result: entry.media }
          : {}),
        ...(entry.error ? { error: entry.error } : {}),
        ...(entry.abortReason ? { abortReason: entry.abortReason } : {}),
        ...(entry.deniedReason ? { deniedReason: entry.deniedReason } : {}),
        ...(entry.approvalId ? { approvalId: entry.approvalId } : {}),
        hasDetails: entry.hasDetails,
        detailsState: entry.hasDetails ? "summary" : "loaded",
      };
    case "approval":
      return {
        ...base,
        kind: "approval",
        approvalId: entry.approvalId,
        request: entry.request,
        state: entry.state,
        ...(entry.response ? { response: entry.response } : {}),
        ...(entry.respondedBy ? { respondedBy: entry.respondedBy } : {}),
        ...(entry.cancelReason ? { cancelReason: entry.cancelReason } : {}),
      };
    case "marker":
      return {
        ...base,
        kind: "marker",
        markerKind: entry.markerKind,
        text: entry.text,
      };
  }
}

function compactUserBlock(turn: CompactTranscriptTurn): UserBlock {
  const user = turn.user;
  return {
    seq: user.seq,
    at: user.at,
    source: user.source,
    kind: "user",
    messageId: user.messageId,
    content: user.content,
    ...(user.queued ? { queued: user.queued } : {}),
    ...(user.editedFromMessageId
      ? { editedFromMessageId: user.editedFromMessageId }
      : {}),
  };
}

export function compactTurnBlocks(
  turns: readonly CompactTranscriptTurn[],
): Block[] {
  return turns.flatMap((turn) => [
    compactUserBlock(turn),
    ...turn.entries.map(compactEntryBlock),
  ]);
}

function rebuildBlockIndexes(blocks: readonly Block[]) {
  const toolIndex: Record<string, number> = {};
  const approvalIndex: Record<string, number> = {};
  blocks.forEach((block, index) => {
    if (block.kind === "tool") toolIndex[block.toolCallId] = index;
    if (block.kind === "approval") approvalIndex[block.approvalId] = index;
  });
  return { toolIndex, approvalIndex };
}

export function mergeCompactTranscript(
  state: TranscriptState,
  response: CompactTranscriptResponse,
  mode: "replace" | "prepend",
): TranscriptState {
  const incoming = compactTurnBlocks(response.turns);
  const incomingKeys = new Set(incoming.map(blockKey));
  const blocks =
    mode === "prepend"
      ? [
          ...incoming,
          ...state.blocks.filter((block) => !incomingKeys.has(blockKey(block))),
        ]
      : incoming;
  const indexes = rebuildBlockIndexes(blocks);
  return {
    ...state,
    branchId: response.branchId,
    blocks,
    rawEvents: mode === "replace" ? [] : state.rawEvents,
    ...indexes,
    lastSeq: Math.max(state.lastSeq, response.upToSeq),
    historyInitialized: true,
    hasOlderHistory: response.hasOlder,
    hasNewerHistory:
      mode === "prepend" ? state.hasNewerHistory : response.hasNewer,
    firstHistoryMessageId:
      response.turns[0]?.user.messageId ?? state.firstHistoryMessageId,
    lastHistoryMessageId:
      mode === "prepend"
        ? state.lastHistoryMessageId
        : (response.turns.at(-1)?.user.messageId ?? null),
  };
}

function contentBlocks(value: unknown): ContentBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blocks: ContentBlock[] = [];
  for (const item of value) {
    const parsed = contentBlockSchema.safeParse(item);
    if (!parsed.success) return undefined;
    blocks.push(parsed.data);
  }
  return blocks;
}

export function applyToolCallDetail(
  state: TranscriptState,
  detail: ToolCallDetail,
): TranscriptState {
  const index = state.toolIndex[detail.toolCallId];
  const current = index === undefined ? undefined : state.blocks[index];
  if (index === undefined || current?.kind !== "tool") return state;
  const result = contentBlocks(detail.result);
  const blocks = [...state.blocks];
  blocks[index] = {
    ...current,
    args: detail.args,
    ...(result ? { result } : {}),
    detailsState: "loaded",
  };
  return { ...state, blocks };
}

/** True until the transcript contains the daemon's newest history page. */
export function needsRecentHistory(
  transcript: TranscriptState | undefined,
): boolean {
  if (transcript?.historyInitialized) return false;
  if (!transcript?.live || transcript.lastSeq === 0) return false;
  const oldestLoaded = transcript.rawEvents[0]?.seq;
  const newestPageStart = Math.max(1, transcript.lastSeq - PAGE + 1);
  return oldestLoaded === undefined || oldestLoaded > newestPageStart;
}

export type TranscriptsStore = {
  bySession: Readonly<Record<string, TranscriptState>>;
  loadingOlder: Readonly<Record<string, boolean>>;
  loadingPrompt: Readonly<Record<string, string | null>>;
  /** ingest-internal: apply a reducer to one session's transcript. */
  update: (
    sessionId: string,
    fn: (t: TranscriptState) => TranscriptState,
  ) => void;
  /** Load the newest page before the first subscription to avoid full replay. */
  primeRecent: (sessionId: string, headSeq: number) => Promise<number>;
  /** Backward-page older events for a session via the bridge. */
  prependOlder: (sessionId: string) => Promise<void>;
  /** Load contiguous older history until targetSeq is available. */
  revealSeq: (sessionId: string, targetSeq: number) => Promise<void>;
  /** Load a bounded turn window directly, without replaying intervening rows. */
  revealMessage: (sessionId: string, messageId: string) => Promise<void>;
  loadLatest: (sessionId: string) => Promise<void>;
  loadToolDetails: (sessionId: string, toolCallId: string) => Promise<void>;
};

export const transcriptsInitial = {
  bySession: {},
  loadingOlder: {},
  loadingPrompt: {},
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
  primeRecent: async (sessionId, headSeq) => {
    const existing = get().bySession[sessionId]?.lastSeq ?? 0;
    const bridge = getBridge();
    if (existing > 0 || headSeq <= 0 || !bridge) return existing;
    const page = await bridge.readCompactTranscript(sessionId, {
      limitTurns: COMPACT_TURNS,
    });
    cacheCompactWindow(page);
    get().update(sessionId, (current) =>
      mergeCompactTranscript(current, page, "replace"),
    );
    return page.upToSeq;
  },
  prependOlder: async (sessionId) => {
    const bridge = getBridge();
    const t = get().bySession[sessionId];
    if (!bridge || !t || get().loadingOlder[sessionId]) return;
    if (t.historyInitialized) {
      if (!t.hasOlderHistory || !t.firstHistoryMessageId) return;
      set((s) => ({ loadingOlder: { ...s.loadingOlder, [sessionId]: true } }));
      try {
        const page = await bridge.readCompactTranscript(sessionId, {
          limitTurns: COMPACT_TURNS,
          beforeMessageId: t.firstHistoryMessageId,
        });
        cacheCompactWindow(page);
        get().update(sessionId, (current) =>
          mergeCompactTranscript(current, page, "prepend"),
        );
      } finally {
        set((s) => ({
          loadingOlder: { ...s.loadingOlder, [sessionId]: false },
        }));
      }
      return;
    }
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
  revealSeq: async (sessionId, targetSeq) => {
    const bridge = getBridge();
    if (!bridge) return;
    if (get().loadingOlder[sessionId]) {
      await new Promise<void>((resolve) => {
        const unsubscribe = useTranscripts.subscribe((state) => {
          if (!state.loadingOlder[sessionId]) {
            unsubscribe();
            resolve();
          }
        });
      });
      return get().revealSeq(sessionId, targetSeq);
    }
    set((s) => ({ loadingOlder: { ...s.loadingOlder, [sessionId]: true } }));
    try {
      while (true) {
        const transcript = get().bySession[sessionId];
        if (!transcript) return;
        const oldest = transcript.rawEvents[0]?.seq ?? transcript.lastSeq + 1;
        if (oldest <= targetSeq || oldest <= 1) return;
        const fromSeq = Math.max(0, oldest - 1 - REVEAL_PAGE);
        const page = await bridge.readEvents(sessionId, {
          fromSeq,
          limit: REVEAL_PAGE,
        });
        const older = page.events.filter((event) => event.seq < oldest);
        if (older.length === 0) return;
        get().update(sessionId, (current) =>
          prependOlderEvents(current, older),
        );
      }
    } finally {
      set((s) => ({ loadingOlder: { ...s.loadingOlder, [sessionId]: false } }));
    }
  },
  revealMessage: async (sessionId, messageId) => {
    const bridge = getBridge();
    if (!bridge) return;
    const current = get().bySession[sessionId];
    if (
      current?.blocks.some(
        (block) => block.kind === "user" && block.messageId === messageId,
      )
    )
      return;
    set((state) => ({
      loadingPrompt: { ...state.loadingPrompt, [sessionId]: messageId },
    }));
    try {
      const key = `${sessionId}:${messageId}`;
      const page =
        compactWindowCache.get(key) ??
        (await bridge.readCompactTranscript(sessionId, {
          limitTurns: COMPACT_TURNS,
          aroundMessageId: messageId,
        }));
      cacheCompactWindow(page);
      get().update(sessionId, (transcript) =>
        mergeCompactTranscript(transcript, page, "replace"),
      );
    } finally {
      set((state) => ({
        loadingPrompt: { ...state.loadingPrompt, [sessionId]: null },
      }));
    }
  },
  loadLatest: async (sessionId) => {
    const bridge = getBridge();
    if (!bridge) return;
    const page = await bridge.readCompactTranscript(sessionId, {
      limitTurns: COMPACT_TURNS,
    });
    cacheCompactWindow(page);
    get().update(sessionId, (transcript) =>
      mergeCompactTranscript(transcript, page, "replace"),
    );
  },
  loadToolDetails: async (sessionId, toolCallId) => {
    const bridge = getBridge();
    const transcript = get().bySession[sessionId];
    const index = transcript?.toolIndex[toolCallId];
    const block = index === undefined ? undefined : transcript?.blocks[index];
    if (
      !bridge ||
      block?.kind !== "tool" ||
      block.detailsState === "loading" ||
      block.detailsState === "loaded"
    )
      return;
    get().update(sessionId, (state) => {
      const next = [...state.blocks];
      const tool = next[state.toolIndex[toolCallId] ?? -1];
      if (tool?.kind !== "tool") return state;
      next[state.toolIndex[toolCallId] ?? -1] = {
        ...tool,
        detailsState: "loading",
      };
      return { ...state, blocks: next };
    });
    try {
      const detail = await bridge.getToolCallDetail(sessionId, toolCallId);
      get().update(sessionId, (state) => applyToolCallDetail(state, detail));
    } catch (error) {
      get().update(sessionId, (state) => {
        const next = [...state.blocks];
        const tool = next[state.toolIndex[toolCallId] ?? -1];
        if (tool?.kind !== "tool") return state;
        next[state.toolIndex[toolCallId] ?? -1] = {
          ...tool,
          detailsState: "error",
          error: tool.error ?? {
            code: "DETAIL_LOAD_FAILED",
            message: error instanceof Error ? error.message : "Failed to load",
          },
        };
        return { ...state, blocks: next };
      });
    }
  },
}));
