import { z } from "zod";
import { approvalResponseSchema } from "./commands.ts";
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

export const sessionOriginSchema = z.enum([
  "native",
  "import.claude",
  "import.codex",
  "control",
]);
export type SessionOrigin = z.infer<typeof sessionOriginSchema>;

// ---- M1 durable payloads, exactly per §5.5 (every payload is v: 1) ----
// ponytail: the rest of the §5.5 catalog lands with the milestones that emit it (M2+)

export const sessionCreatedSchema = z
  .object({
    workspaceId: z.string().min(1),
    title: z.string().optional(),
    runtime: z.literal("pi"),
    origin: sessionOriginSchema,
    scope: z.enum(["project", "global", "control"]),
    projectId: z.string().min(1).optional(),
    projectRoot: z.string().min(1).optional(),
    cwd: z.string().min(1),
    hostCwdHint: z.string().min(1).optional(),
    rootBranchId: z.string().min(1),
    purpose: z.literal("quick_chat").optional(),
    derivedFrom: z
      .object({
        parentSessionId: z.string().min(1),
        sourceMessageId: z.string().min(1).optional(),
        mode: z.enum(["fork", "clone"]),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scope !== "project") return;
    for (const key of ["projectId", "projectRoot"] as const) {
      if (!value[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required for project sessions`,
        });
      }
    }
  });
export type SessionCreated = z.infer<typeof sessionCreatedSchema>;

export const sessionTitleChangedSchema = z.object({
  title: z.string().min(1).max(80),
});
export type SessionTitleChanged = z.infer<typeof sessionTitleChangedSchema>;

export const messageUserCreatedSchema = z.object({
  messageId: z.string().min(1),
  content: z.array(contentBlockSchema),
  queued: z.enum(["steer", "followUp"]).optional(), // absent for a plain prompt
  editedFromMessageId: z.string().min(1).optional(),
});
export type MessageUserCreated = z.infer<typeof messageUserCreatedSchema>;

export const messageRuntimeRefSchema = z.object({
  messageId: z.string().min(1),
  runtimeEntryId: z.string().min(1),
});
export type MessageRuntimeRef = z.infer<typeof messageRuntimeRefSchema>;

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

export const agentTaskCreatedSchema = z.object({
  taskId: z.string().min(1),
  parentSessionId: z.string().min(1),
  childSessionId: z.string().min(1),
  parentRunId: z.string().min(1),
  parentMessageId: z.string().min(1),
  parentToolCallId: z.string().min(1),
  role: z.string().min(1),
  task: z.string().min(1),
  execution: z.enum(["foreground", "background"]),
  context: z.enum(["fresh", "fork"]),
  workspaceMode: z.enum([
    "shared_readonly",
    "shared_serial_writer",
    "isolated_worktree",
  ]),
  requestedModel: modelRefSchema.optional(),
  resolvedModel: modelRefSchema,
  retryOfTaskId: z.string().min(1).optional(),
});
export type AgentTaskCreated = z.infer<typeof agentTaskCreatedSchema>;

export const agentTaskStartedSchema = z.object({
  taskId: z.string().min(1),
  startedAt: z.string().min(1),
});
export type AgentTaskStarted = z.infer<typeof agentTaskStartedSchema>;

export const agentTaskCompletedSchema = z.object({
  taskId: z.string().min(1),
  resultMessageId: z.string().min(1),
  summary: z.array(contentBlockSchema),
  usage: usageTotalsSchema.optional(),
});
export type AgentTaskCompleted = z.infer<typeof agentTaskCompletedSchema>;

export const agentTaskFailedSchema = z.object({
  taskId: z.string().min(1),
  error: z.object({ code: z.string().min(1), message: z.string() }),
  summary: z.array(contentBlockSchema).optional(),
});
export type AgentTaskFailed = z.infer<typeof agentTaskFailedSchema>;

export const agentTaskCancelledSchema = z.object({
  taskId: z.string().min(1),
  reason: z.enum([
    "user",
    "parent_aborted",
    "daemon_shutdown",
    "daemon_restart",
  ]),
});
export type AgentTaskCancelled = z.infer<typeof agentTaskCancelledSchema>;

export const agentTaskMessageSentSchema = z.object({
  taskId: z.string().min(1),
  direction: z.enum(["parent_to_child", "child_to_parent"]),
  messageId: z.string().min(1),
});
export type AgentTaskMessageSent = z.infer<typeof agentTaskMessageSentSchema>;

export const agentTaskSummarySchema = agentTaskCreatedSchema.extend({
  status: z.enum(["created", "running", "completed", "failed", "cancelled"]),
  summary: z.array(contentBlockSchema).optional(),
  error: z.object({ code: z.string().min(1), message: z.string() }).optional(),
  usage: usageTotalsSchema.optional(),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).optional(),
  finishedAt: z.string().min(1).optional(),
});
export type AgentTaskSummary = z.infer<typeof agentTaskSummarySchema>;

export const gitBaselineRecordedSchema = z.object({
  worktreeId: z.string().min(1),
  worktreeRoot: z.string().min(1),
  cwd: z.string().min(1),
  head: z.string().min(1).optional(),
  headRef: z.string().min(1).optional(),
  detached: z.boolean(),
  unborn: z.boolean(),
});
export type GitBaselineRecorded = z.infer<typeof gitBaselineRecordedSchema>;

export const gitHeadObservedSchema = z.object({
  worktreeId: z.string().min(1),
  worktreeRoot: z.string().min(1),
  previousHead: z.string().min(1).optional(),
  head: z.string().min(1).optional(),
  previousRef: z.string().min(1).optional(),
  headRef: z.string().min(1).optional(),
  reason: z.enum([
    "tool_completed",
    "turn_completed",
    "session_resume",
    "manual_refresh",
  ]),
});
export type GitHeadObserved = z.infer<typeof gitHeadObservedSchema>;

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

export const modelChangedSchema = z.object({
  from: modelRefSchema.optional(),
  to: modelRefSchema,
  reason: z.enum(["user_selected", "fallback", "auto"]),
});
export type ModelChanged = z.infer<typeof modelChangedSchema>;

export const thinkingLevelChangedSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type ThinkingLevelChanged = z.infer<typeof thinkingLevelChangedSchema>;

export const fastModeChangedSchema = z.object({
  enabled: z.boolean(),
});
export type FastModeChanged = z.infer<typeof fastModeChangedSchema>;

export const compactionCreatedSchema = z.object({
  compactionId: z.string().min(1),
  summary: z.array(contentBlockSchema),
  replacesUpToSeq: z.number().int().nonnegative(),
  tokensBefore: z.number().int().nonnegative().optional(),
  tokensAfter: z.number().int().nonnegative().optional(),
  trigger: z.enum(["user", "auto"]),
});
export type CompactionCreated = z.infer<typeof compactionCreatedSchema>;

export const compactionFailedSchema = z.object({
  compactionId: z.string().min(1),
  error: z.object({ code: z.string().min(1), message: z.string() }),
});
export type CompactionFailed = z.infer<typeof compactionFailedSchema>;

export const approvalSubjectSchema = z.object({
  toolName: z.string().min(1).optional(),
  args: z.unknown().optional(),
  cwd: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
});
export type ApprovalSubject = z.infer<typeof approvalSubjectSchema>;

export const approvalRequestedSchema = z.object({
  approvalId: z.string().min(1),
  kind: z.enum(["confirm", "select", "input", "editor"]),
  title: z.string().optional(),
  message: z.string(),
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .optional(),
  defaultValue: z.string().optional(),
  subject: approvalSubjectSchema.optional(),
  toolCallId: z.string().min(1).optional(),
  expiresAt: z.string().optional(),
});
export type ApprovalRequested = z.infer<typeof approvalRequestedSchema>;

export const approvalRespondedSchema = z.object({
  approvalId: z.string().min(1),
  response: approvalResponseSchema,
  respondedBy: z.string().min(1),
});
export type ApprovalResponded = z.infer<typeof approvalRespondedSchema>;

export const approvalExpiredSchema = z.object({
  approvalId: z.string().min(1),
});
export type ApprovalExpired = z.infer<typeof approvalExpiredSchema>;

export const approvalCancelledSchema = z.object({
  approvalId: z.string().min(1),
  reason: z.enum([
    "turn_aborted",
    "daemon_shutdown",
    "daemon_restart",
    "runtime_cancelled",
  ]),
});
export type ApprovalCancelled = z.infer<typeof approvalCancelledSchema>;

export const snapshotCreatedSchema = z.object({
  snapshotId: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().optional(),
  kind: z.enum(["manual", "auto", "pre_tool", "pre_restore"]),
  storage: z.object({
    backend: z.literal("tar"),
    path: z.string().min(1),
    sha256: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  }),
  fileCount: z.number().int().nonnegative().optional(),
  triggeredBySessionId: z.string().min(1).optional(),
});
export type SnapshotCreated = z.infer<typeof snapshotCreatedSchema>;

export const snapshotRestoredSchema = z.object({
  snapshotId: z.string().min(1),
  safetySnapshotId: z.string().min(1),
  triggeredBySessionId: z.string().min(1).optional(),
});
export type SnapshotRestored = z.infer<typeof snapshotRestoredSchema>;

export const snapshotRestoreFailedSchema = z.object({
  snapshotId: z.string().min(1),
  safetySnapshotId: z.string().min(1).optional(),
  error: z.object({ code: z.string().min(1), message: z.string() }),
});
export type SnapshotRestoreFailed = z.infer<typeof snapshotRestoreFailedSchema>;

export const snapshotDeletedSchema = z.object({
  snapshotId: z.string().min(1),
});
export type SnapshotDeleted = z.infer<typeof snapshotDeletedSchema>;

// Payload registry (§5 `events/index.ts` contract): appendEvents rejects any type
// not listed here (P12).
export const durableEventSchemas = {
  "session.created": sessionCreatedSchema,
  "session.title.changed": sessionTitleChangedSchema,
  "message.user.created": messageUserCreatedSchema,
  "message.runtime.ref": messageRuntimeRefSchema,
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
  "agent.task.created": agentTaskCreatedSchema,
  "agent.task.started": agentTaskStartedSchema,
  "agent.task.completed": agentTaskCompletedSchema,
  "agent.task.failed": agentTaskFailedSchema,
  "agent.task.cancelled": agentTaskCancelledSchema,
  "agent.task.message.sent": agentTaskMessageSentSchema,
  "git.baseline.recorded": gitBaselineRecordedSchema,
  "git.head.observed": gitHeadObservedSchema,
  "terminal.session.started": terminalSessionStartedSchema,
  "terminal.session.ended": terminalSessionEndedSchema,
  "model.changed": modelChangedSchema,
  "thinking.level.changed": thinkingLevelChangedSchema,
  "fast.mode.changed": fastModeChangedSchema,
  "compaction.created": compactionCreatedSchema,
  "compaction.failed": compactionFailedSchema,
  "approval.requested": approvalRequestedSchema,
  "approval.responded": approvalRespondedSchema,
  "approval.expired": approvalExpiredSchema,
  "approval.cancelled": approvalCancelledSchema,
  "snapshot.created": snapshotCreatedSchema,
  "snapshot.restored": snapshotRestoredSchema,
  "snapshot.restore_failed": snapshotRestoreFailedSchema,
  "snapshot.deleted": snapshotDeletedSchema,
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
    type: z.literal("session.title.changed"),
    payload: sessionTitleChangedSchema,
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
    type: z.literal("message.runtime.ref"),
    payload: messageRuntimeRefSchema,
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
    type: z.literal("agent.task.created"),
    payload: agentTaskCreatedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("agent.task.started"),
    payload: agentTaskStartedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("agent.task.completed"),
    payload: agentTaskCompletedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("agent.task.failed"),
    payload: agentTaskFailedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("agent.task.cancelled"),
    payload: agentTaskCancelledSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("agent.task.message.sent"),
    payload: agentTaskMessageSentSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("git.baseline.recorded"),
    payload: gitBaselineRecordedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("git.head.observed"),
    payload: gitHeadObservedSchema,
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
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("model.changed"),
    payload: modelChangedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("thinking.level.changed"),
    payload: thinkingLevelChangedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("fast.mode.changed"),
    payload: fastModeChangedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("compaction.created"),
    payload: compactionCreatedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("compaction.failed"),
    payload: compactionFailedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("approval.requested"),
    payload: approvalRequestedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("approval.responded"),
    payload: approvalRespondedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("approval.expired"),
    payload: approvalExpiredSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("approval.cancelled"),
    payload: approvalCancelledSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("snapshot.created"),
    payload: snapshotCreatedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("snapshot.restored"),
    payload: snapshotRestoredSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("snapshot.restore_failed"),
    payload: snapshotRestoreFailedSchema,
  }),
  z.object({
    ...eventBase,
    v: z.literal(1),
    type: z.literal("snapshot.deleted"),
    payload: snapshotDeletedSchema,
  }),
]);
export type KnownAgenaEvent = z.infer<typeof knownAgenaEventSchema>;
