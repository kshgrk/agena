import { z } from "zod";
import { modelRefSchema, textBlockSchema } from "./content.ts";

// §5.4 command catalog.
export const commandNameSchema = z.enum([
  "subscribe",
  "prompt",
  "steer",
  "followUp",
  "abort",
  "runtimeInfo",
  "setModel",
  "setThinkingLevel",
  "respondToApproval",
  "compact",
]);
export type CommandName = z.infer<typeof commandNameSchema>;

export const subscribeCmdSchema = z.object({
  sessionId: z.string().min(1),
  // EXCLUSIVE: replay returns seq > fromSeq; fromSeq = 0 replays everything.
  fromSeq: z.number().int().nonnegative(),
  branchId: z.string().min(1).optional(),
});
export type SubscribeCmd = z.infer<typeof subscribeCmdSchema>;

// v1 restricts prompt content to {type:"text"} blocks, schema-enforced (§5.4).
export const promptCmdSchema = z.object({
  sessionId: z.string().min(1),
  content: z.array(textBlockSchema).min(1),
});
export type PromptCmd = z.infer<typeof promptCmdSchema>;

export const steerCmdSchema = promptCmdSchema;
export type SteerCmd = z.infer<typeof steerCmdSchema>;

export const followUpCmdSchema = promptCmdSchema;
export type FollowUpCmd = z.infer<typeof followUpCmdSchema>;

export const abortCmdSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.string().min(1).optional(),
});
export type AbortCmd = z.infer<typeof abortCmdSchema>;

export const runtimeInfoCmdSchema = z.object({
  sessionId: z.string().min(1),
});
export type RuntimeInfoCmd = z.infer<typeof runtimeInfoCmdSchema>;

export const setModelCmdSchema = z.object({
  sessionId: z.string().min(1),
  model: modelRefSchema,
});
export type SetModelCmd = z.infer<typeof setModelCmdSchema>;

export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const setThinkingLevelCmdSchema = z.object({
  sessionId: z.string().min(1),
  thinkingLevel: thinkingLevelSchema,
});
export type SetThinkingLevelCmd = z.infer<typeof setThinkingLevelCmdSchema>;

export const approvalResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirm"), accepted: z.boolean() }),
  z.object({ kind: z.literal("select"), optionId: z.string().min(1) }),
  z.object({ kind: z.literal("input"), text: z.string() }),
  z.object({ kind: z.literal("editor"), text: z.string() }),
  z.object({ kind: z.literal("deny") }),
]);
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;

export const respondToApprovalCmdSchema = z.object({
  sessionId: z.string().min(1),
  approvalId: z.string().min(1),
  response: approvalResponseSchema,
});
export type RespondToApprovalCmd = z.infer<typeof respondToApprovalCmdSchema>;

export const compactCmdSchema = z.object({
  sessionId: z.string().min(1),
});
export type CompactCmd = z.infer<typeof compactCmdSchema>;

// Ack results (§5.4 table).
export const subscribeAckSchema = z.object({
  lastSeq: z.number().int().nonnegative(), // daemon head seq at subscribe time
  branchId: z.string().min(1),
  replayCount: z.number().int().nonnegative(),
});
export type SubscribeAck = z.infer<typeof subscribeAckSchema>;

export const emptyAckSchema = z.object({});
export type EmptyAck = z.infer<typeof emptyAckSchema>;

export const promptAckSchema = z.object({
  messageId: z.string().min(1),
  seq: z.number().int().positive(), // seq of the message.user.created event
});
export type PromptAck = z.infer<typeof promptAckSchema>;

export const setModelAckSchema = z.object({
  model: modelRefSchema,
});
export type SetModelAck = z.infer<typeof setModelAckSchema>;

export const setThinkingLevelAckSchema = z.object({
  thinkingLevel: thinkingLevelSchema,
});
export type SetThinkingLevelAck = z.infer<typeof setThinkingLevelAckSchema>;

export const runtimeInfoAckSchema = z.object({
  model: modelRefSchema.optional(),
  thinkingLevel: thinkingLevelSchema,
  availableModels: z.array(modelRefSchema),
  availableThinkingLevels: z.array(thinkingLevelSchema),
  slashCommands: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
    }),
  ),
});
export type RuntimeInfoAck = z.infer<typeof runtimeInfoAckSchema>;

export const respondToApprovalAckSchema = z.object({
  approvalId: z.string().min(1),
});
export type RespondToApprovalAck = z.infer<typeof respondToApprovalAckSchema>;

export const compactAckSchema = z.object({
  compactionSeq: z.number().int().positive(),
});
export type CompactAck = z.infer<typeof compactAckSchema>;

// Per-command payload/ack registry — the daemon validates `cmd.payload` against
// commandSchemas[name].payload after envelope parse (invalid -> INVALID_PAYLOAD).
export const commandSchemas = {
  subscribe: { payload: subscribeCmdSchema, ack: subscribeAckSchema },
  prompt: { payload: promptCmdSchema, ack: promptAckSchema },
  steer: { payload: steerCmdSchema, ack: promptAckSchema },
  followUp: { payload: followUpCmdSchema, ack: promptAckSchema },
  abort: { payload: abortCmdSchema, ack: emptyAckSchema },
  runtimeInfo: { payload: runtimeInfoCmdSchema, ack: runtimeInfoAckSchema },
  setModel: { payload: setModelCmdSchema, ack: setModelAckSchema },
  setThinkingLevel: {
    payload: setThinkingLevelCmdSchema,
    ack: setThinkingLevelAckSchema,
  },
  respondToApproval: {
    payload: respondToApprovalCmdSchema,
    ack: respondToApprovalAckSchema,
  },
  compact: { payload: compactCmdSchema, ack: compactAckSchema },
} as const satisfies Record<
  CommandName,
  { payload: z.ZodType; ack: z.ZodType }
>;
