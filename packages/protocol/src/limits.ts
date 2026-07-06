import { z } from "zod";

// Mirrors §3.2 canonical constants — M1 subset only.
export const MAX_ENVELOPE_BYTES = 1_048_576; // 1 MiB max wire envelope
export const MAX_PROMPT_BYTES = 262_144; // 256 KiB prompt text cap
// ponytail: §3.2 never pins maxSubscriptions; replace when the plan states a value
export const MAX_SUBSCRIPTIONS = 64;

export const HELLO_TIMEOUT_MS = 10_000; // no hello within 10 s -> close 4408
export const PING_INTERVAL_MS = 15_000; // daemon ping cadence; 2 missed pongs -> close 1001
export const COMMAND_ACK_TIMEOUT_MS = 30_000; // client-side per-command timeout
export const REQUEST_DEDUPE_TTL_MS = 5 * 60_000;
export const FRAME_COALESCE_BUFFERED_BYTES = 1_048_576;
export const FRAME_DROP_BUFFERED_BYTES = 4_194_304;
export const DURABLE_BACKLOG_LIMIT_BYTES = 16_777_216;
export const SOCKET_STALL_TIMEOUT_MS = 15_000;

export const wireLimitsSchema = z.object({
  maxEnvelopeBytes: z.number().int().positive(),
  maxPromptBytes: z.number().int().positive(),
  maxSubscriptions: z.number().int().positive(),
});
export type WireLimits = z.infer<typeof wireLimitsSchema>;

export const DEFAULT_WIRE_LIMITS: WireLimits = {
  maxEnvelopeBytes: MAX_ENVELOPE_BYTES,
  maxPromptBytes: MAX_PROMPT_BYTES,
  maxSubscriptions: MAX_SUBSCRIPTIONS,
};
