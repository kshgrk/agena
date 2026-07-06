import { z } from "zod";

// §5.9 single registry — M1 subset.
// ponytail: remaining v1 codes land with the commands/features that raise them (M2+)
export const ERROR_CODES = [
  "UNAUTHORIZED",
  "PROTOCOL_MISMATCH",
  "NOT_READY",
  "TIMEOUT",
  "INVALID_PAYLOAD",
  "PAYLOAD_TOO_LARGE",
  "SESSION_NOT_FOUND",
  "SESSION_BUSY",
  "ALREADY_SUBSCRIBED",
  "SUBSCRIPTION_LIMIT",
  "INTERNAL",
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

// Same shape is the HTTP error body (§5.9).
export const agenaErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  details: z.unknown().optional(),
});
export type AgenaError = z.infer<typeof agenaErrorSchema>;

// WS close codes (§5.9). Upgrade-time auth failure is a raw HTTP 401,
// never a close code; authInvalidated is reserved for future post-handshake auth.
export const WS_CLOSE_CODES = {
  normal: 1000,
  goingAway: 1001, // daemon shutdown / missed heartbeats
  protocolViolation: 4400, // repeated malformed input or version mismatch
  authInvalidated: 4401,
  handshakeTimeout: 4408, // no hello within HELLO_TIMEOUT_MS
  ptyAlreadyAttached: 4409,
  messageTooLarge: 4413, // repeated envelopes over MAX_ENVELOPE_BYTES
  slowConsumer: 4429, // backpressure disconnect
} as const;
export type WsCloseCode = (typeof WS_CLOSE_CODES)[keyof typeof WS_CLOSE_CODES];
