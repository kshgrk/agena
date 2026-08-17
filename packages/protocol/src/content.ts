import { z } from "zod";

// §5.3 content model. Commands admit the user-input subset (text/image/file);
// durable runtime/tool payloads can carry the wider block set.
export const blobRefSchema = z.object({
  blob: z.string().regex(/^sha256:[0-9a-f]+$/),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().optional(),
  preview: z.string().optional(),
});
export type BlobRef = z.infer<typeof blobRefSchema>;

export const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type TextBlock = z.infer<typeof textBlockSchema>;

export const thinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  text: z.string(),
});

export const toolCallBlockSchema = z.object({
  type: z.literal("toolCall"),
  toolCallId: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown(),
});

export const imageBlockSchema = z.object({
  type: z.literal("image"),
  ref: blobRefSchema,
  alt: z.string().optional(),
});

export const fileBlockSchema = z.object({
  type: z.literal("file"),
  ref: blobRefSchema,
  path: z.string().optional(),
});

export const contentBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  thinkingBlockSchema,
  toolCallBlockSchema,
  imageBlockSchema,
  fileBlockSchema,
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const modelRefSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

// ponytail: the plan references UsageTotals without pinning a shape; this mirrors
// §5.5's message.assistant.completed usage — adjust when the plan defines it
export const usageTotalsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});
export type UsageTotals = z.infer<typeof usageTotalsSchema>;
