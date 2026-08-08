import { z } from "zod";

// §5.7 frame payloads — M1 subset.
export const assistantTextDeltaSchema = z.object({
  messageId: z.string().min(1),
  blockIndex: z.number().int().nonnegative(),
  delta: z.string(), // coalesce by concat
});
export type AssistantTextDelta = z.infer<typeof assistantTextDeltaSchema>;

export const toolCallOutputDeltaSchema = z.object({
  toolCallId: z.string().min(1),
  delta: z.string(),
  reset: z.boolean().optional(),
});
export type ToolCallOutputDelta = z.infer<typeof toolCallOutputDeltaSchema>;

export const sessionStatusUpdatedSchema = z.object({
  state: z.enum([
    "idle",
    "thinking",
    "generating",
    "tool_running",
    "compacting",
    "retrying",
    "custom",
  ]),
  detail: z.string().optional(),
});

export const compactionStartedSchema = z.object({
  trigger: z.enum(["user", "auto"]),
});

export const runRetryStartedSchema = z.object({
  runId: z.string().min(1),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  delayMs: z.number().int().nonnegative(),
  errorSummary: z.string(),
});

export const runRetryEndedSchema = z.object({
  runId: z.string().min(1),
  outcome: z.enum(["recovered", "exhausted"]),
});

// Frame payload registry (§5 `events/index.ts` contract).
// ponytail: remaining v1 frames land with the features that emit them (M2+)
export const frameSchemas = {
  "message.assistant.text.delta": assistantTextDeltaSchema,
  "tool.call.output.delta": toolCallOutputDeltaSchema,
  "session.status.updated": sessionStatusUpdatedSchema,
  "compaction.started": compactionStartedSchema,
  "run.retry.started": runRetryStartedSchema,
  "run.retry.ended": runRetryEndedSchema,
} as const;
export type FrameType = keyof typeof frameSchemas;

// §5.7 envelope: afterSeq = highest committed seq at emit time; frames are never
// persisted and are droppable/coalescible. `type` stays open like events (§5.10).
const frameBase = {
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  afterSeq: z.number().int().nonnegative(),
  emittedAt: z.string(),
};

export const agenaFrameSchema = z.object({
  ...frameBase,
  type: z.string().min(1),
  payload: z.unknown(),
});
export type AgenaFrame = z.infer<typeof agenaFrameSchema>;

export const knownAgenaFrameSchema = z.discriminatedUnion("type", [
  z.object({
    ...frameBase,
    type: z.literal("message.assistant.text.delta"),
    payload: assistantTextDeltaSchema,
  }),
  z.object({
    ...frameBase,
    type: z.literal("tool.call.output.delta"),
    payload: toolCallOutputDeltaSchema,
  }),
  z.object({
    ...frameBase,
    type: z.literal("session.status.updated"),
    payload: sessionStatusUpdatedSchema,
  }),
  z.object({
    ...frameBase,
    type: z.literal("compaction.started"),
    payload: compactionStartedSchema,
  }),
  z.object({
    ...frameBase,
    type: z.literal("run.retry.started"),
    payload: runRetryStartedSchema,
  }),
  z.object({
    ...frameBase,
    type: z.literal("run.retry.ended"),
    payload: runRetryEndedSchema,
  }),
]);
export type KnownAgenaFrame = z.infer<typeof knownAgenaFrameSchema>;
