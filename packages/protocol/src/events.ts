import { z } from "zod";
import {
  contentBlockSchema,
  modelRefSchema,
  usageTotalsSchema,
} from "./content.ts";

// INV-9 — provenance on every event; maps to source_kind/source_runtime/source_client_id columns.
export const eventSourceSchema = z.object({
  kind: z.enum([
    "user",
    "daemon",
    "runtime",
    "terminal",
    "filesystem",
    "importer",
  ]),
  runtime: z.literal("pi").optional(), // set when kind === "runtime"
  clientId: z.string().min(1).optional(), // set when kind === "user"
});
export type EventSource = z.infer<typeof eventSourceSchema>;

// ---- M1 durable payloads, exactly per §5.5 (every payload is v: 1) ----
// ponytail: the rest of the §5.5 catalog lands with the milestones that emit it (M2+)

export const sessionCreatedSchema = z.object({
  workspaceId: z.string().min(1),
  title: z.string().optional(),
  runtime: z.literal("pi"),
  origin: z.enum(["native", "import.claude", "import.codex", "control"]),
  rootBranchId: z.string().min(1),
});
export type SessionCreated = z.infer<typeof sessionCreatedSchema>;

export const messageUserCreatedSchema = z.object({
  messageId: z.string().min(1),
  content: z.array(contentBlockSchema),
  queued: z.enum(["steer", "followUp"]).optional(), // absent for a plain prompt
});
export type MessageUserCreated = z.infer<typeof messageUserCreatedSchema>;

export const messageAssistantStartedSchema = z.object({
  messageId: z.string().min(1),
  runId: z.string().min(1),
  turnId: z.string().min(1), // replay grouping without durable turn events
  model: modelRefSchema,
  inResponseTo: z.string().min(1), // user messageId
});
export type MessageAssistantStarted = z.infer<
  typeof messageAssistantStartedSchema
>;

export const messageAssistantCompletedSchema = z.object({
  messageId: z.string().min(1),
  content: z.array(contentBlockSchema),
  model: modelRefSchema,
  stopReason: z.enum(["end_turn", "tool_use", "max_tokens"]),
  usage: usageTotalsSchema.optional(),
});
export type MessageAssistantCompleted = z.infer<
  typeof messageAssistantCompletedSchema
>;

export const messageAssistantAbortedSchema = z.object({
  messageId: z.string().min(1),
  partialContent: z.array(contentBlockSchema),
  reason: z.enum(["user_abort", "daemon_shutdown"]),
});
export type MessageAssistantAborted = z.infer<
  typeof messageAssistantAbortedSchema
>;

export const messageAssistantFailedSchema = z.object({
  messageId: z.string().min(1),
  partialContent: z.array(contentBlockSchema),
  error: z.object({ code: z.string().min(1), message: z.string() }),
  recovered: z.boolean().optional(),
});
export type MessageAssistantFailed = z.infer<
  typeof messageAssistantFailedSchema
>;

export const messageRuntimeCreatedSchema = z.object({
  messageId: z.string().min(1),
  runtimeType: z.enum(["custom", "bash", "branch-summary"]),
  role: z.string().optional(),
  content: z.array(contentBlockSchema),
  meta: z
    .object({
      command: z.string().optional(),
      exitCode: z.number().int().nullable().optional(),
      customType: z.string().optional(),
    })
    .optional(),
});
export type MessageRuntimeCreated = z.infer<typeof messageRuntimeCreatedSchema>;

export const runStartedSchema = z.object({
  runId: z.string().min(1),
  trigger: z.enum(["prompt", "steer", "followUp"]),
  triggerMessageId: z.string().min(1),
});
export type RunStarted = z.infer<typeof runStartedSchema>;

export const runCompletedSchema = z.object({
  runId: z.string().min(1),
  usage: usageTotalsSchema.optional(),
});
export type RunCompleted = z.infer<typeof runCompletedSchema>;

export const runAbortedSchema = z.object({
  runId: z.string().min(1),
  reason: z.enum(["user_abort", "daemon_shutdown"]),
});
export type RunAborted = z.infer<typeof runAbortedSchema>;

export const runFailedSchema = z.object({
  runId: z.string().min(1),
  error: z.object({ code: z.string().min(1), message: z.string().optional() }),
  phase: z.enum(["dispatch", "runtime", "recovery"]).optional(),
  triggerMessageId: z.string().min(1).optional(),
});
export type RunFailed = z.infer<typeof runFailedSchema>;

export const toolCallStartedSchema = z.object({
  toolCallId: z.string().min(1),
  messageId: z.string().min(1),
  runId: z.string().min(1),
  turnId: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown(),
  runtimeToolCallId: z.string().min(1).optional(),
});
export type ToolCallStarted = z.infer<typeof toolCallStartedSchema>;

export const toolCallCompletedSchema = z.object({
  toolCallId: z.string().min(1),
  result: z.array(contentBlockSchema),
  durationMs: z.number().nonnegative(),
});
export type ToolCallCompleted = z.infer<typeof toolCallCompletedSchema>;

export const toolCallFailedSchema = z.object({
  toolCallId: z.string().min(1),
  error: z.object({ code: z.string().min(1), message: z.string() }),
  partialOutput: z.array(contentBlockSchema).optional(),
  durationMs: z.number().nonnegative().optional(),
});
export type ToolCallFailed = z.infer<typeof toolCallFailedSchema>;

export const toolCallAbortedSchema = z.object({
  toolCallId: z.string().min(1),
  partialOutput: z.array(contentBlockSchema),
  reason: z.enum([
    "user_abort",
    "daemon_shutdown",
    "daemon_restart",
    "runtime_error",
  ]),
});
export type ToolCallAborted = z.infer<typeof toolCallAbortedSchema>;

export const toolCallDeniedSchema = z.object({
  toolCallId: z.string().min(1),
  approvalId: z.string().min(1).optional(),
  reason: z.enum(["user_denied", "approval_expired", "policy", "hook_denied"]),
});
export type ToolCallDenied = z.infer<typeof toolCallDeniedSchema>;

export const terminalSessionStartedSchema = z.object({
  terminalId: z.string().min(1),
  shell: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TerminalSessionStarted = z.infer<
  typeof terminalSessionStartedSchema
>;

export const terminalSessionEndedSchema = z.object({
  terminalId: z.string().min(1),
  exitCode: z.number().int().nullable(),
  reason: z.enum(["exit", "killed", "daemon_restart"]),
});
export type TerminalSessionEnded = z.infer<typeof terminalSessionEndedSchema>;

// Payload registry (§5 `events/index.ts` contract): appendEvents rejects any type
// not listed here (P12).
export const durableEventSchemas = {
  "session.created": sessionCreatedSchema,
  "message.user.created": messageUserCreatedSchema,
  "message.runtime.created": messageRuntimeCreatedSchema,
  "message.assistant.started": messageAssistantStartedSchema,
  "message.assistant.completed": messageAssistantCompletedSchema,
  "message.assistant.aborted": messageAssistantAbortedSchema,
  "message.assistant.failed": messageAssistantFailedSchema,
  "run.started": runStartedSchema,
  "run.completed": runCompletedSchema,
  "run.aborted": runAbortedSchema,
  "run.failed": runFailedSchema,
  "tool.call.started": toolCallStartedSchema,
  "tool.call.completed": toolCallCompletedSchema,
  "tool.call.failed": toolCallFailedSchema,
  "tool.call.aborted": toolCallAbortedSchema,
  "tool.call.denied": toolCallDeniedSchema,
  "terminal.session.started": terminalSessionStartedSchema,
  "terminal.session.ended": terminalSessionEndedSchema,
} as const;
export type DurableEventType = keyof typeof durableEventSchemas;

// §5.3 wire shape. `type` stays open on purpose: new event types are additive (§5.10)
// and clients render unknown types as a generic row. Narrow with knownAgenaEventSchema.
const eventBase = {
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  seq: z.number().int().positive(), // per-session monotonic, assigned in the append tx
  v: z.number().int().positive(), // payload schema version for this type
  createdAt: z.string(),
  source: eventSourceSchema,
};

export const agenaEventSchema = z.object({
  ...eventBase,
  type: z.string().min(1),
  payload: z.unknown(),
});
export type AgenaEvent = z.infer<typeof agenaEventSchema>;

// Strict union over the known catalog; every latest payload is v: 1 (§5.10 — no upcast
// chains exist yet, so latest v == 1).
export const knownAgenaEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("session.created"),
    payload: sessionCreatedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("message.user.created"),
    payload: messageUserCreatedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("message.assistant.started"),
    payload: messageAssistantStartedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("message.assistant.completed"),
    payload: messageAssistantCompletedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("message.assistant.aborted"),
    payload: messageAssistantAbortedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("message.assistant.failed"),
    payload: messageAssistantFailedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("message.runtime.created"),
    payload: messageRuntimeCreatedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("run.started"),
    payload: runStartedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("run.completed"),
    payload: runCompletedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("run.aborted"),
    payload: runAbortedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("run.failed"),
    payload: runFailedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("tool.call.started"),
    payload: toolCallStartedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("tool.call.completed"),
    payload: toolCallCompletedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("tool.call.failed"),
    payload: toolCallFailedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("tool.call.aborted"),
    payload: toolCallAbortedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("tool.call.denied"),
    payload: toolCallDeniedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("terminal.session.started"),
    payload: terminalSessionStartedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("terminal.session.ended"),
    payload: terminalSessionEndedSchema,
  }),
]);
export type KnownAgenaEvent = z.infer<typeof knownAgenaEventSchema>;
