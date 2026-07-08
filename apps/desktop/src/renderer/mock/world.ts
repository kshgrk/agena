// In-memory fake daemon: per-session event logs, subscriptions, live turn state.
// Every generated event is dev-asserted against knownAgenaEventSchema (D-INV-6:
// the renderer must never see a payload the real daemon couldn't have written).
import {
  type AgenaEvent,
  type ApprovalResponse,
  type EventSource,
  type InFlightSnapshot,
  knownAgenaEventSchema,
  type ModelRef,
  type PendingApprovalSummary,
  type SessionStatus,
  type SessionSummary,
  type SubscribeAck,
  type ThinkingLevel,
} from "@agena/protocol";
import type { UiBatch } from "../../shared/bridge.ts";

// ---- ids ---------------------------------------------------------------------

// ponytail: fake ulid — fixed time prefix + monotonic counter tail, all Crockford
// base32, 26 chars. Deterministic on purpose (stable demos, no Math.random).
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let ulidCounter = 0;

export function ulid(): string {
  let n = ++ulidCounter;
  let tail = "";
  for (let i = 0; i < 13; i++) {
    tail = B32.charAt(n % 32) + tail;
    n = Math.floor(n / 32);
  }
  return `01JZM0CKAGENA${tail}`;
}

// ---- constants -----------------------------------------------------------------

export const CLIENT_ID = "desktop-mock";
export const WORKSPACE_ID = "ws_7f3a";
export const DEFAULT_MODEL: ModelRef = {
  provider: "pi",
  id: "claude-sonnet-5",
};
export const MODELS: ModelRef[] = [
  DEFAULT_MODEL,
  { provider: "pi", id: "claude-opus-5" },
  { provider: "pi", id: "claude-haiku-4-5" },
  { provider: "pi", id: "gpt-5.2-codex" },
];
export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const SRC: {
  daemon: EventSource;
  runtime: EventSource;
  terminal: EventSource;
  importer: EventSource;
  user: (clientId?: string) => EventSource;
} = {
  daemon: { kind: "daemon" },
  runtime: { kind: "runtime", runtime: "pi" },
  terminal: { kind: "terminal" },
  importer: { kind: "importer" },
  user: (clientId = CLIENT_ID) => ({ kind: "user", clientId }),
};

// ---- live turn state -------------------------------------------------------------

export type LiveTool = {
  toolCallId: string;
  name: string;
  args: unknown;
  partialOutput: string;
  done: boolean;
};

export type LiveTurn = {
  runId: string;
  turnId: string;
  messageId: string;
  model: ModelRef;
  /** Streaming text blocks by frame blockIndex (partial content on abort). */
  blocks: Array<{ type: "text" | "thinking"; text: string }>;
  tools: LiveTool[];
  aborted: boolean;
  steerText: string | null;
  followUps: Array<{ messageId: string; text: string }>;
  pendingApproval: {
    summary: PendingApprovalSummary;
    resolve: (r: ApprovalResponse) => void;
  } | null;
};

export type MockSession = {
  summary: SessionSummary;
  events: AgenaEvent[];
  live: LiveTurn | null;
  subscribed: boolean;
  onFirstSubscribe: (() => void) | null;
  runtime: { model: ModelRef; thinkingLevel: ThinkingLevel };
};

export type SessionSeed = {
  summary: SessionSummary;
  events: AgenaEvent[];
  live: LiveTurn | null;
  runtime?: { model: ModelRef; thinkingLevel: ThinkingLevel };
};

function devAssertValid(e: AgenaEvent): void {
  const parsed = knownAgenaEventSchema.safeParse(e);
  if (!parsed.success) {
    console.warn(
      `[mock] generated invalid event ${e.type} seq=${e.seq}`,
      parsed.error.issues,
    );
  }
}

// ---- world -----------------------------------------------------------------------

export class World {
  readonly sessions = new Map<string, MockSession>();
  private readonly listeners = new Set<(batch: UiBatch) => void>();

  addSession(seed: SessionSeed): void {
    for (const e of seed.events) devAssertValid(e);
    this.sessions.set(seed.summary.sessionId, {
      summary: seed.summary,
      events: seed.events,
      live: seed.live,
      subscribed: false,
      onFirstSubscribe: null,
      runtime: seed.runtime ?? {
        model: DEFAULT_MODEL,
        thinkingLevel: "medium",
      },
    });
  }

  onBatch(cb: (batch: UiBatch) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(partial: Partial<UiBatch>): void {
    const batch: UiBatch = {
      events: [],
      frames: [],
      syncs: [],
      snapshots: [],
      lostSessions: [],
      ...partial,
    };
    for (const cb of this.listeners) cb(batch);
  }

  /** Append a durable event; delivered live to subscribers of the session. */
  append(
    sessionId: string,
    type: string,
    payload: unknown,
    source: EventSource,
  ): AgenaEvent {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`mock: unknown session ${sessionId}`);
    const event: AgenaEvent = {
      sessionId,
      branchId: s.summary.rootBranchId,
      seq: s.summary.lastSeq + 1,
      v: 1,
      createdAt: new Date().toISOString(),
      source,
      type,
      payload,
    };
    devAssertValid(event);
    s.events.push(event);
    s.summary = {
      ...s.summary,
      lastSeq: event.seq,
      updatedAt: event.createdAt,
      ...(type === "session.title.changed" &&
      typeof (payload as { title?: unknown }).title === "string"
        ? { title: (payload as { title: string }).title }
        : {}),
    };
    if (s.subscribed) this.emit({ events: [{ event, replayed: false }] });
    return event;
  }

  /** Ephemeral frame; dropped for unsubscribed sessions (frames are droppable). */
  frame(sessionId: string, type: string, payload: unknown): void {
    const s = this.sessions.get(sessionId);
    if (!s?.subscribed) return;
    this.emit({
      frames: [
        {
          sessionId,
          branchId: s.summary.rootBranchId,
          afterSeq: s.summary.lastSeq,
          emittedAt: new Date().toISOString(),
          type,
          payload,
        },
      ],
    });
  }

  setStatus(sessionId: string, status: SessionStatus): void {
    const s = this.sessions.get(sessionId);
    if (s) s.summary = { ...s.summary, status };
  }

  snapshotOf(s: MockSession): InFlightSnapshot {
    const live = s.live;
    return {
      sessionId: s.summary.sessionId,
      branchId: s.summary.rootBranchId,
      afterSeq: s.summary.lastSeq,
      assistant: live
        ? {
            messageId: live.messageId,
            model: live.model,
            blocks: live.blocks.map((b) => ({ type: b.type, text: b.text })),
          }
        : null,
      toolCalls: live
        ? live.tools
            .filter((t) => !t.done)
            .map((t) => ({
              toolCallId: t.toolCallId,
              name: t.name,
              args: t.args,
              partialOutput: t.partialOutput,
            }))
        : [],
      pendingApprovals: live?.pendingApproval
        ? [live.pendingApproval.summary.payload]
        : [],
      retry: null,
      queue: {
        steerCount: live?.steerText != null ? 1 : 0,
        followUpCount: live?.followUps.length ?? 0,
      },
      status: { state: live ? "streaming" : "idle" },
    };
  }

  /**
   * Subscribe semantics per §5.4: fromSeq is EXCLUSIVE. After ~120ms, replay in
   * chunks of 40 (replayed:true) → sync → snapshot; live appends follow.
   * ponytail: live events appended inside the 120ms window would arrive before
   * the replay flush — no mock script appends that early, so not handled.
   */
  subscribe(sessionId: string, fromSeq: number): SubscribeAck | null {
    const s = this.sessions.get(sessionId);
    if (!s) {
      setTimeout(() => this.emit({ lostSessions: [sessionId] }), 60);
      return null;
    }
    s.subscribed = true;
    const replay = s.events.filter((e) => e.seq > fromSeq);
    const branchId = s.summary.rootBranchId;
    const lastSeq = s.summary.lastSeq;
    setTimeout(() => {
      for (let i = 0; i < replay.length; i += 40) {
        this.emit({
          events: replay
            .slice(i, i + 40)
            .map((event) => ({ event, replayed: true })),
        });
      }
      this.emit({ syncs: [{ sessionId, branchId, upToSeq: lastSeq }] });
      this.emit({ snapshots: [this.snapshotOf(s)] });
      const kick = s.onFirstSubscribe;
      if (kick) {
        s.onFirstSubscribe = null;
        kick();
      }
    }, 120);
    return { lastSeq, branchId, replayCount: replay.length };
  }

  pendingApprovals(): PendingApprovalSummary[] {
    const out: PendingApprovalSummary[] = [];
    for (const s of this.sessions.values()) {
      if (s.live?.pendingApproval) out.push(s.live.pendingApproval.summary);
    }
    return out;
  }
}
