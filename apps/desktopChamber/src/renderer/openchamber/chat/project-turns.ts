import { argSummary } from "../../features/transcript/layout.ts";
import type { Block, TranscriptState } from "../../store/types.ts";
import type {
  ChamberActivity,
  ChamberHistoryEntry,
  ChamberMessage,
  ChamberTimeline,
  ChamberTurn,
  ChamberTurnEntry,
} from "./types.ts";

export const userTurnCount = (blocks: readonly Pick<Block, "kind">[]) =>
  blocks.reduce((count, block) => count + (block.kind === "user" ? 1 : 0), 0);

type ToolCategory = "read" | "search" | "edit" | "command" | "web" | "other";

const CATEGORY_COPY: Record<ToolCategory, { noun: string; active: string }> = {
  read: { noun: "read", active: "Reading" },
  search: { noun: "search", active: "Searching" },
  edit: { noun: "edit", active: "Editing" },
  command: { noun: "command", active: "Running" },
  web: { noun: "web action", active: "Browsing" },
  other: { noun: "other", active: "Using" },
};

function toolCategory(name: string): ToolCategory {
  const value = name.toLowerCase();
  if (/(read|cat)/.test(value)) return "read";
  if (/(grep|search|find|glob|list|\bls\b)/.test(value)) return "search";
  if (/(edit|write|patch)/.test(value)) return "edit";
  if (/(bash|shell|exec|terminal)/.test(value)) return "command";
  if (/(web|browser|fetch|http)/.test(value)) return "web";
  return "other";
}

export type ToolGroupSummary = {
  state: "running" | "success" | "issue";
  title: string;
  detail: string;
};

/** Compact, deterministic turn summary; full tool bodies stay lazy. */
export function summarizeToolActivities(
  activities: readonly ChamberActivity[],
): ToolGroupSummary {
  const tools = activities.filter((activity) => activity.block.kind === "tool");
  const issues = tools.filter((activity) =>
    ["failed", "aborted", "denied"].includes(activity.status),
  );
  const running = tools.filter((activity) => activity.status === "running");
  const focus = issues.at(-1) ?? running.at(-1);
  if (focus?.block.kind === "tool") {
    const category = CATEGORY_COPY[toolCategory(focus.block.name)];
    const subject = argSummary(focus.block.args);
    const action = `${category.active}${subject ? ` ${subject}` : ""}`;
    if (issues.length > 0) {
      return {
        state: "issue",
        title: `Stopped at “${subject || focus.block.name}” · ${issues.length} issue${issues.length === 1 ? "" : "s"}`,
        detail:
          focus.block.error?.message ??
          focus.block.deniedReason?.replace(/_/g, " ") ??
          focus.block.abortReason?.replace(/_/g, " ") ??
          "Stopped",
      };
    }
    return {
      state: "running",
      title: `Working · ${tools.length} action${tools.length === 1 ? "" : "s"}`,
      detail: action,
    };
  }

  const counts = new Map<ToolCategory, number>();
  for (const activity of tools) {
    if (activity.block.kind !== "tool") continue;
    const category = toolCategory(activity.block.name);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const detail = [...counts]
    .map(([category, count]) => {
      const noun = CATEGORY_COPY[category].noun;
      return `${count} ${noun}${count === 1 || noun === "other" ? "" : "s"}`;
    })
    .join(" · ");
  return {
    state: "success",
    title: `Done · ${tools.length} action${tools.length === 1 ? "" : "s"}`,
    detail,
  };
}

export function needsMoreTurnHistory(
  blocks: readonly Pick<Block, "kind">[],
  target: number,
  oldestSeq: number | undefined,
): boolean {
  return (
    oldestSeq !== undefined && oldestSeq > 1 && userTurnCount(blocks) < target
  );
}

/**
 * A cold history page can begin in the middle of a long agent turn. Only show
 * complete turns once their user boundary is loaded; preserve genuinely
 * userless histories after pagination reaches the beginning.
 */
export function completeTurnBlocks(
  blocks: readonly Block[],
  hasEarlierEvents: boolean,
): readonly Block[] {
  const firstUser = blocks.findIndex((block) => block.kind === "user");
  if (firstUser >= 0) return firstUser === 0 ? blocks : blocks.slice(firstUser);
  return hasEarlierEvents ? [] : blocks;
}

function messageOf(
  block: Extract<Block, { kind: "user" | "assistant" }>,
): ChamberMessage {
  if (block.kind === "user") {
    return {
      id: block.messageId,
      role: "user",
      at: block.at,
      content: block.content,
      sourceSeq: block.seq,
      ...(block.queued ? { queued: block.queued } : {}),
    };
  }
  return {
    id: block.messageId,
    role: "assistant",
    at: block.at,
    content: block.content,
    sourceSeq: block.seq,
    status: block.status,
    ...(block.model ? { model: block.model } : {}),
    ...(block.usage ? { usage: block.usage } : {}),
    ...(block.error ? { error: block.error } : {}),
  };
}

function activityOf(
  block: Extract<Block, { kind: "tool" | "approval" | "runtime" | "marker" }>,
): ChamberActivity {
  switch (block.kind) {
    case "tool":
      return {
        id: block.toolCallId,
        seq: block.seq,
        at: block.at,
        kind: "tool",
        status: block.status,
        title: block.name,
        block,
      };
    case "approval":
      return {
        id: block.approvalId,
        seq: block.seq,
        at: block.at,
        kind: "approval",
        status: block.state,
        title: block.request.title ?? "Approval requested",
        block,
      };
    case "runtime":
      return {
        id: block.messageId,
        seq: block.seq,
        at: block.at,
        kind: "runtime",
        status: "informational",
        title: block.runtimeType,
        block,
      };
    case "marker":
      return {
        id: `marker-${block.seq}`,
        seq: block.seq,
        at: block.at,
        kind: "marker",
        status: "informational",
        title: block.text,
        block,
      };
  }
  throw new Error("unreachable activity kind");
}

function appendActivity(
  entries: ChamberTurnEntry[],
  activity: ChamberActivity,
): void {
  if (
    activity.kind !== "tool" ||
    (activity.block.kind === "tool" && activity.block.name === "subagent")
  ) {
    entries.push({
      kind: "activity",
      key: `activity:${activity.id}:${activity.seq}`,
      activity,
    });
    return;
  }

  const previous = entries.at(-1);
  if (previous?.kind === "tool-group") {
    previous.activities = [...previous.activities, activity];
    return;
  }
  entries.push({
    kind: "tool-group",
    key: `tool-group:${activity.id}`,
    activities: [activity],
  });
}

/**
 * Projects Agena's durable event blocks into OpenChamber-style user turns.
 * Source sequence is authoritative: timestamps are deliberately never sorted.
 */
export function projectTurns(
  blocks: readonly Block[],
  inFlight: TranscriptState["inFlight"],
): ChamberTimeline {
  const history: ChamberHistoryEntry[] = [];
  let turn: { user: ChamberMessage; entries: ChamberTurnEntry[] } | null = null;

  const flush = () => {
    if (!turn) return;
    const complete: ChamberTurn = {
      id: turn.user.id,
      user: turn.user,
      entries: turn.entries,
    };
    history.push({ kind: "turn", key: `turn:${complete.id}`, turn: complete });
    turn = null;
  };

  for (const block of blocks) {
    if (block.kind === "user") {
      flush();
      turn = { user: messageOf(block), entries: [] };
      continue;
    }

    if (!turn) {
      history.push({ kind: "orphan", key: `orphan:${block.seq}`, block });
      continue;
    }

    if (block.kind === "assistant") {
      const visible =
        block.status !== "completed" ||
        block.content.some((part) => part.type !== "toolCall");
      if (!visible) continue;
      turn.entries.push({
        kind: "assistant",
        key: `message:${block.messageId}`,
        message: messageOf(block),
      });
      continue;
    }

    appendActivity(turn.entries, activityOf(block));
  }
  flush();

  return {
    history,
    tail: inFlight
      ? {
          messageId: inFlight.messageId,
          parts: inFlight.blocks,
          phase: "streaming",
        }
      : null,
  };
}
