import type { ContentBlock, ModelRef, UsageTotals } from "@agena/protocol";
import type { ReactNode } from "react";
import type {
  ApprovalBlock,
  Block,
  MarkerBlock,
  RuntimeBlock,
  ToolBlock,
} from "../../store/types.ts";

export type ChamberMessage = {
  id: string;
  role: "user" | "assistant";
  at: string;
  content: readonly ContentBlock[];
  sourceSeq: number;
  status?: "completed" | "aborted" | "failed";
  model?: ModelRef;
  usage?: UsageTotals;
  error?: { code: string; message: string };
  queued?: "steer" | "followUp";
};

export type ChamberActivity = {
  id: string;
  seq: number;
  at: string;
  status:
    | "running"
    | "completed"
    | "failed"
    | "aborted"
    | "denied"
    | "pending"
    | "responded"
    | "expired"
    | "cancelled"
    | "informational";
  kind: "tool" | "approval" | "runtime" | "marker";
  title: string;
  block: ToolBlock | ApprovalBlock | RuntimeBlock | MarkerBlock;
};

export type ChamberTurnEntry =
  | { kind: "assistant"; key: string; message: ChamberMessage }
  | { kind: "activity"; key: string; activity: ChamberActivity }
  | {
      kind: "tool-group";
      key: string;
      activities: readonly ChamberActivity[];
    };

export type ChamberTurn = {
  id: string;
  user: ChamberMessage;
  entries: readonly ChamberTurnEntry[];
};

export type ChamberOrphan = {
  kind: "orphan";
  key: string;
  block: Exclude<Block, { kind: "user" }>;
};

export type ChamberHistoryEntry =
  | { kind: "turn"; key: string; turn: ChamberTurn }
  | ChamberOrphan;

export type ChamberStreamingTail = {
  messageId: string;
  parts: ReadonlyArray<{ type: "text" | "thinking"; text: string }>;
  phase: "streaming" | "cooldown";
};

export type ChamberTimeline = {
  history: readonly ChamberHistoryEntry[];
  tail: ChamberStreamingTail | null;
};

export type ChatContentRenderer = (input: {
  content: readonly ContentBlock[];
  role: "user" | "assistant";
  streaming: boolean;
  message?: ChamberMessage;
}) => ReactNode;

export type ActivityRenderer = (input: {
  activity: ChamberActivity;
  expanded: boolean;
  toggleExpanded: () => void;
}) => ReactNode;
