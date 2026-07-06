import { z } from "zod";
import { commandNameSchema } from "./commands.ts";
import { agenaErrorSchema } from "./errors.ts";
import { agenaEventSchema } from "./events.ts";
import { agenaFrameSchema } from "./frames.ts";
import { wireLimitsSchema } from "./limits.ts";
import { inFlightSnapshotSchema } from "./snapshot.ts";

// §5.1 handshake. Client sends hello first; daemon replies welcome or error + close 4400.
export const helloEnvelopeSchema = z.object({
  kind: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  client: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    platform: z.string().min(1),
  }),
  // Stable ULID per installed client; becomes EventSource.clientId on user events (P3).
  clientId: z.string().min(1),
});
export type HelloEnvelope = z.infer<typeof helloEnvelopeSchema>;

export const welcomeEnvelopeSchema = z.object({
  kind: z.literal("welcome"),
  protocolVersion: z.number().int().positive(),
  daemonVersion: z.string().min(1),
  serverTime: z.string(),
  limits: wireLimitsSchema,
});
export type WelcomeEnvelope = z.infer<typeof welcomeEnvelopeSchema>;

// §5.2 — client-minted ULID requestId; exactly one terminal ack or error per cmd (P13).
export const cmdEnvelopeSchema = z.object({
  kind: z.literal("cmd"),
  requestId: z.string().min(1),
  name: commandNameSchema,
  payload: z.unknown(), // validated per-name against commandSchemas[name].payload
});
export type CmdEnvelope = z.infer<typeof cmdEnvelopeSchema>;

export const ackEnvelopeSchema = z.object({
  kind: z.literal("ack"),
  requestId: z.string().min(1),
  result: z.unknown().optional(),
});
export type AckEnvelope = z.infer<typeof ackEnvelopeSchema>;

export const errorEnvelopeSchema = z.object({
  kind: z.literal("error"),
  requestId: z.string().min(1).optional(), // absent for connection-level errors
  error: agenaErrorSchema,
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const eventEnvelopeSchema = z.object({
  kind: z.literal("event"),
  event: agenaEventSchema, // strict seq order, gap-free, per subscription
  replayed: z.boolean(), // true during replay so the TUI skips animation
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const frameEnvelopeSchema = z.object({
  kind: z.literal("frame"),
  frame: agenaFrameSchema,
});
export type FrameEnvelope = z.infer<typeof frameEnvelopeSchema>;

// End-of-replay marker (§5.8).
export const syncEnvelopeSchema = z.object({
  kind: z.literal("sync"),
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  upToSeq: z.number().int().nonnegative(),
});
export type SyncEnvelope = z.infer<typeof syncEnvelopeSchema>;

export const snapshotEnvelopeSchema = z.object({
  kind: z.literal("snapshot"),
  snapshot: inFlightSnapshotSchema,
});
export type SnapshotEnvelope = z.infer<typeof snapshotEnvelopeSchema>;

export const pingEnvelopeSchema = z.object({
  kind: z.literal("ping"),
  ts: z.string(),
});
export type PingEnvelope = z.infer<typeof pingEnvelopeSchema>;

export const pongEnvelopeSchema = z.object({
  kind: z.literal("pong"),
  ts: z.string(),
});
export type PongEnvelope = z.infer<typeof pongEnvelopeSchema>;

// §5.2 — every JSON message on the main WS is exactly one of these.
export const wireEnvelopeSchema = z.discriminatedUnion("kind", [
  helloEnvelopeSchema,
  welcomeEnvelopeSchema,
  cmdEnvelopeSchema,
  ackEnvelopeSchema,
  errorEnvelopeSchema,
  eventEnvelopeSchema,
  frameEnvelopeSchema,
  syncEnvelopeSchema,
  snapshotEnvelopeSchema,
  pingEnvelopeSchema,
  pongEnvelopeSchema,
]);
export type WireEnvelope = z.infer<typeof wireEnvelopeSchema>;
