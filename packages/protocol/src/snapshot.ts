import { z } from "zod";
import { contentBlockSchema, modelRefSchema } from "./content.ts";

export const inFlightSnapshotSchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  afterSeq: z.number().int().nonnegative(),
  assistant: z
    .object({
      messageId: z.string().min(1),
      model: modelRefSchema,
      blocks: z.array(contentBlockSchema),
    })
    .nullable(),
  toolCalls: z.array(
    z.object({
      toolCallId: z.string().min(1),
      name: z.string().min(1),
      args: z.unknown(),
      partialOutput: z.string().optional(),
    }),
  ),
  pendingApprovals: z.array(z.unknown()),
  retry: z
    .object({
      attempt: z.number().int().positive(),
      maxAttempts: z.number().int().positive(),
      nextAttemptAt: z.string(),
    })
    .nullable(),
  queue: z.object({
    steerCount: z.number().int().nonnegative(),
    followUpCount: z.number().int().nonnegative(),
  }),
  status: z.object({
    state: z.string().min(1),
    detail: z.string().optional(),
  }),
});
export type InFlightSnapshot = z.infer<typeof inFlightSnapshotSchema>;
