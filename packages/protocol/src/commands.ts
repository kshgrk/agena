import { z } from "zod";
import { textBlockSchema } from "./content.ts";

// §5.4 command catalog — M1 subset.
// ponytail: unsubscribe/steer/followUp/abort/setModel/setThinkingLevel/
// respondToApproval/compact land M2–M4 with their features
export const commandNameSchema = z.enum(["subscribe", "prompt"]);
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

// Ack results (§5.4 table).
export const subscribeAckSchema = z.object({
  lastSeq: z.number().int().nonnegative(), // daemon head seq at subscribe time
  branchId: z.string().min(1),
  replayCount: z.number().int().nonnegative(),
});
export type SubscribeAck = z.infer<typeof subscribeAckSchema>;

export const promptAckSchema = z.object({
  messageId: z.string().min(1),
  seq: z.number().int().positive(), // seq of the message.user.created event
});
export type PromptAck = z.infer<typeof promptAckSchema>;

// Per-command payload/ack registry — the daemon validates `cmd.payload` against
// commandSchemas[name].payload after envelope parse (invalid -> INVALID_PAYLOAD).
export const commandSchemas = {
  subscribe: { payload: subscribeCmdSchema, ack: subscribeAckSchema },
  prompt: { payload: promptCmdSchema, ack: promptAckSchema },
} as const satisfies Record<
  CommandName,
  { payload: z.ZodType; ack: z.ZodType }
>;
