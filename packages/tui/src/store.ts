// Pure transcript reducer (§11.3): durable events finalize, frames update the
// in-flight tail only. No pi-tui imports — rendering stays a thin layer on top.
import {
  type AgenaEvent,
  type AgenaFrame,
  type ContentBlock,
  durableEventSchemas,
  type InFlightSnapshot,
  knownAgenaEventSchema,
  knownAgenaFrameSchema,
} from "@agena/protocol";

export type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string; toolCallId?: string }
  | { kind: "marker"; text: string };

export type TranscriptState = {
  blocks: readonly Block[];
  /** Exactly one in-progress assistant tail, fed by text-delta frames. */
  inFlight: { messageId: string; text: string } | null;
};

export const initialState: TranscriptState = { blocks: [], inFlight: null };

export function addMarker(s: TranscriptState, text: string): TranscriptState {
  return { ...s, blocks: [...s.blocks, { kind: "marker", text }] };
}

/** Durable events append/finalize blocks and clear the matching in-flight tail. */
export function applyEvent(s: TranscriptState, e: AgenaEvent): TranscriptState {
  const parsed = knownAgenaEventSchema.safeParse(e);
  if (!parsed.success) {
    // known type with a bad payload -> inline error row, never a crash (§11.7)
    if (e.type in durableEventSchemas) {
      return addMarker(s, `malformed event ${e.type} (seq ${e.seq})`);
    }
    return s; // unknown (future) event types are ignored in M1
  }
  const ev = parsed.data;
  switch (ev.type) {
    case "message.user.created":
      return {
        ...s,
        blocks: [
          ...s.blocks,
          { kind: "user", text: joinText(ev.payload.content) },
        ],
      };
    case "message.assistant.started":
      return { ...s, inFlight: { messageId: ev.payload.messageId, text: "" } };
    case "message.assistant.completed": {
      // authoritative content replaces whatever the delta buffer accumulated (P12)
      const blocks = [
        ...s.blocks,
        { kind: "assistant" as const, text: joinText(ev.payload.content) },
      ];
      const inFlight =
        s.inFlight?.messageId === ev.payload.messageId ? null : s.inFlight;
      return { blocks, inFlight };
    }
    case "message.assistant.aborted": {
      const blocks = [
        ...s.blocks,
        {
          kind: "assistant" as const,
          text: joinText(ev.payload.partialContent),
        },
      ];
      const inFlight =
        s.inFlight?.messageId === ev.payload.messageId ? null : s.inFlight;
      return { blocks, inFlight };
    }
    case "message.assistant.failed": {
      const text = joinText(ev.payload.partialContent);
      const blocks = [
        ...s.blocks,
        {
          kind: "assistant" as const,
          text: text || `[failed: ${ev.payload.error.code}]`,
        },
      ];
      const inFlight =
        s.inFlight?.messageId === ev.payload.messageId ? null : s.inFlight;
      return { blocks, inFlight };
    }
    case "tool.call.started":
      return {
        ...s,
        blocks: [
          ...s.blocks,
          {
            kind: "tool",
            toolCallId: ev.payload.toolCallId,
            text: `tool ${ev.payload.name} started`,
          },
        ],
      };
    case "tool.call.completed":
      return updateToolBlock(
        s,
        ev.payload.toolCallId,
        `tool completed\n${joinText(ev.payload.result)}`,
      );
    case "tool.call.failed": {
      const text = ev.payload.partialOutput
        ? joinText(ev.payload.partialOutput)
        : ev.payload.error.message;
      return updateToolBlock(
        s,
        ev.payload.toolCallId,
        `tool failed: ${ev.payload.error.code}\n${text}`,
      );
    }
    default:
      return s; // session.created / run.* have no transcript row in M1
  }
}

/** Frames touch inFlight ONLY; stale or mistargeted deltas are dropped. */
export function applyFrame(s: TranscriptState, f: AgenaFrame): TranscriptState {
  const parsed = knownAgenaFrameSchema.safeParse(f);
  if (!parsed.success) return s;
  if (parsed.data.type === "tool.call.output.delta") {
    return updateToolBlockOutput(
      s,
      parsed.data.payload.toolCallId,
      parsed.data.payload.delta,
      parsed.data.payload.reset === true,
    );
  }
  if (parsed.data.type !== "message.assistant.text.delta") return s;
  if (!s.inFlight) return s;
  const p = parsed.data.payload;
  if (s.inFlight.messageId !== p.messageId) return s;
  return { ...s, inFlight: { ...s.inFlight, text: s.inFlight.text + p.delta } };
}

export function applySnapshot(
  s: TranscriptState,
  snapshot: InFlightSnapshot,
): TranscriptState {
  if (!snapshot.assistant) return { ...s, inFlight: null };
  return {
    ...s,
    inFlight: {
      messageId: snapshot.assistant.messageId,
      text: joinText(snapshot.assistant.blocks),
    },
  };
}

function joinText(content: ContentBlock[]): string {
  return content
    .map((b) => (b.type === "text" || b.type === "thinking" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

function updateToolBlock(
  s: TranscriptState,
  toolCallId: string,
  text: string,
): TranscriptState {
  const idx = [...s.blocks]
    .reverse()
    .findIndex((b) => b.kind === "tool" && b.toolCallId === toolCallId);
  if (idx === -1)
    return { ...s, blocks: [...s.blocks, { kind: "tool", toolCallId, text }] };
  const real = s.blocks.length - 1 - idx;
  return {
    ...s,
    blocks: s.blocks.map((b, i) =>
      i === real && b.kind === "tool" ? { ...b, text } : b,
    ),
  };
}

function updateToolBlockOutput(
  s: TranscriptState,
  toolCallId: string,
  delta: string,
  reset: boolean,
): TranscriptState {
  const block = [...s.blocks]
    .reverse()
    .find((b) => b.kind === "tool" && b.toolCallId === toolCallId);
  if (!block) return s;
  const [head = "", ...tail] = block.text.split("\n");
  const output = reset ? delta : `${tail.join("\n")}${delta}`;
  return updateToolBlock(s, toolCallId, output ? `${head}\n${output}` : head);
}
