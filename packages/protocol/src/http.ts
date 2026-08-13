import { z } from "zod";
import {
  blobRefSchema,
  contentBlockSchema,
  modelRefSchema,
  usageTotalsSchema,
} from "./content.ts";

export const uploadImageResponseSchema = z.object({ ref: blobRefSchema });
export type UploadImageResponse = z.infer<typeof uploadImageResponseSchema>;

import { approvalResponseSchema } from "./commands.ts";
import {
  agentTaskSummarySchema,
  approvalRequestedSchema,
  eventSourceSchema,
  sessionOriginSchema,
} from "./events.ts";

export const importSkillRequestSchema = z.object({
  identity: z.string().min(1).max(2048),
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  description: z.string().min(1).max(1024),
  source: z
    .object({
      url: z.string().url(),
      path: z.string().min(1).optional(),
      revision: z.string().min(1).max(256).optional(),
    })
    .optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(512),
        contentBase64: z.string().max(14 * 1024 * 1024),
      }),
    )
    .min(1)
    .max(500),
});
export type ImportSkillRequest = z.infer<typeof importSkillRequestSchema>;
export const skillSummarySchema = z.object({
  id: z.string().min(1),
  identity: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUrl: z.string().optional(),
  sourcePath: z.string().optional(),
  sourceRevision: z.string().optional(),
  status: z.enum(["ready", "update_available", "error"]),
  importedAt: z.string(),
  updatedAt: z.string(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export const importSkillResponseSchema = z.object({
  skill: skillSummarySchema,
});
export type ImportSkillResponse = z.infer<typeof importSkillResponseSchema>;
export const listSkillsResponseSchema = z.object({
  skills: z.array(skillSummarySchema),
});
export type ListSkillsResponse = z.infer<typeof listSkillsResponseSchema>;
export const checkSkillUpdatesResponseSchema = listSkillsResponseSchema;
export type CheckSkillUpdatesResponse = ListSkillsResponse;
export const skillIdParamsSchema = z.object({ id: z.string().min(1) });
export const updateSkillResponseSchema = z.object({
  skill: skillSummarySchema,
});
export type UpdateSkillResponse = z.infer<typeof updateSkillResponseSchema>;

export const mcpTransportSchema = z.enum(["stdio", "http", "sse"]);
export const mcpAuthKindSchema = z.enum(["none", "oauth", "api_key"]);
export const mcpStatusSchema = z.enum([
  "imported",
  "needs_auth",
  "connected",
  "error",
]);
const mcpStringMapSchema = z.record(z.string(), z.string());

export const importMcpRequestSchema = z
  .object({
    identity: z.string().min(1).max(2048),
    name: z.string().min(1).max(128),
    transport: mcpTransportSchema,
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    env: mcpStringMapSchema.optional(),
    headers: mcpStringMapSchema.optional(),
    auth: z.object({
      kind: mcpAuthKindSchema,
      secretValues: mcpStringMapSchema.optional(),
    }),
  })
  .superRefine((value, ctx) => {
    if (value.transport === "stdio" && !value.command) {
      ctx.addIssue({
        code: "custom",
        path: ["command"],
        message: "command is required for stdio",
      });
    }
    if (value.transport !== "stdio" && !value.url) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "url is required for remote MCPs",
      });
    }
  });
export type ImportMcpRequest = z.infer<typeof importMcpRequestSchema>;

export const mcpSummarySchema = z.object({
  id: z.string().min(1),
  identity: z.string().min(1),
  name: z.string().min(1),
  transport: mcpTransportSchema,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  authKind: mcpAuthKindSchema,
  status: mcpStatusSchema,
  importedAt: z.string(),
  updatedAt: z.string(),
});
export type McpSummary = z.infer<typeof mcpSummarySchema>;
export const importMcpResponseSchema = z.object({ mcp: mcpSummarySchema });
export type ImportMcpResponse = z.infer<typeof importMcpResponseSchema>;
export const listMcpsResponseSchema = z.object({
  mcps: z.array(mcpSummarySchema),
});
export type ListMcpsResponse = z.infer<typeof listMcpsResponseSchema>;
export const mcpIdParamsSchema = z.object({ id: z.string().min(1) });
export const startMcpOAuthResponseSchema = z.object({
  authorizationUrl: z.string(),
});
export type StartMcpOAuthResponse = z.infer<typeof startMcpOAuthResponseSchema>;
export const completeMcpOAuthRequestSchema = z.object({
  redirectUrl: z.string().url(),
});
export type CompleteMcpOAuthRequest = z.infer<
  typeof completeMcpOAuthRequestSchema
>;
export const completeMcpOAuthResponseSchema = z.object({
  mcp: mcpSummarySchema,
});
export type CompleteMcpOAuthResponse = z.infer<
  typeof completeMcpOAuthResponseSchema
>;

// ---- curated plugins ------------------------------------------------------

export const pluginKindSchema = z.enum([
  "integration",
  "mcp",
  "extension",
  "skill",
]);
export const pluginCategorySchema = z.enum([
  "developer_tools",
  "productivity",
  "data",
  "automation",
]);
export const pluginStatusSchema = z.enum([
  "available",
  "installed",
  "disabled",
  "needs_auth",
  "ready",
  "error",
  "update_available",
]);
export const pluginSummarySchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  description: z.string().min(1).max(1024),
  publisher: z.string().min(1).max(128),
  kind: pluginKindSchema,
  category: pluginCategorySchema,
  status: pluginStatusSchema,
  authKind: mcpAuthKindSchema,
  featured: z.boolean(),
  capabilities: z.array(z.string().min(1).max(128)),
  enabled: z.boolean(),
  version: z.string().min(1).max(128).optional(),
  homepage: z.string().url().optional(),
  resourceId: z.string().min(1).optional(),
  error: z.string().min(1).max(1024).optional(),
});
export type PluginSummary = z.infer<typeof pluginSummarySchema>;
export const listPluginsResponseSchema = z.object({
  plugins: z.array(pluginSummarySchema),
});
export type ListPluginsResponse = z.infer<typeof listPluginsResponseSchema>;
export const pluginIdParamsSchema = z.object({
  id: z.string().min(1).max(128),
});
export const pluginResponseSchema = z.object({ plugin: pluginSummarySchema });
export type PluginResponse = z.infer<typeof pluginResponseSchema>;
export const setPluginEnabledRequestSchema = z.object({ enabled: z.boolean() });
export type SetPluginEnabledRequest = z.infer<
  typeof setPluginEnabledRequestSchema
>;

// ---- model-provider authentication ----------------------------------------

export const providerAuthMethodSchema = z.enum(["api_key", "oauth"]);
export const providerAuthSourceSchema = z.enum([
  "stored",
  "runtime",
  "environment",
  "fallback",
  "models_json_key",
  "models_json_command",
]);
export const providerAuthSummarySchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  modelCount: z.number().int().nonnegative(),
  methods: z.array(providerAuthMethodSchema).min(1),
  configured: z.boolean(),
  credentialKind: providerAuthMethodSchema.optional(),
  source: providerAuthSourceSchema.optional(),
  /** Human-readable source label such as an environment-variable name; never a value. */
  label: z.string().min(1).max(256).optional(),
});
export type ProviderAuthSummary = z.infer<typeof providerAuthSummarySchema>;
export const listProvidersResponseSchema = z.object({
  providers: z.array(providerAuthSummarySchema),
});
export type ListProvidersResponse = z.infer<typeof listProvidersResponseSchema>;
export const providerIdParamsSchema = z.object({
  id: z.string().min(1).max(128),
});
export const saveProviderApiKeyRequestSchema = z.object({
  apiKey: z.string().min(1).max(65_536),
  /** Provider-scoped values (for example Cloudflare account/gateway ids). */
  env: z.record(z.string().min(1).max(128), z.string().max(4096)).optional(),
});
export type SaveProviderApiKeyRequest = z.infer<
  typeof saveProviderApiKeyRequestSchema
>;
export const providerAuthResponseSchema = z.object({
  provider: providerAuthSummarySchema,
});
export type ProviderAuthResponse = z.infer<typeof providerAuthResponseSchema>;

export const providerOAuthStateSchema = z.enum([
  "pending",
  "completed",
  "failed",
  "cancelled",
]);
const providerOAuthOptionSchema = z.object({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(512),
  description: z.string().max(1024).optional(),
});
export const providerOAuthInteractionSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("auth_url"),
      interactionId: z.string().min(1),
      url: z.string().url(),
      instructions: z.string().max(4096).optional(),
    }),
    z.object({
      kind: z.literal("device_code"),
      interactionId: z.string().min(1),
      userCode: z.string().min(1).max(512),
      verificationUri: z.string().url(),
      intervalSeconds: z.number().positive().optional(),
      expiresInSeconds: z.number().positive().optional(),
    }),
    z.object({
      kind: z.literal("progress"),
      interactionId: z.string().min(1),
      message: z.string().min(1).max(4096),
    }),
    z.object({
      kind: z.literal("prompt"),
      interactionId: z.string().min(1),
      inputKind: z.enum(["text", "secret", "select", "manual_code"]),
      message: z.string().min(1).max(4096),
      placeholder: z.string().max(1024).optional(),
      options: z.array(providerOAuthOptionSchema).optional(),
    }),
  ])
  .superRefine((value, ctx) => {
    if (
      value.kind === "prompt" &&
      value.inputKind === "select" &&
      !value.options?.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "select prompts require options",
      });
    }
  });
export type ProviderOAuthInteraction = z.infer<
  typeof providerOAuthInteractionSchema
>;
export const startProviderOAuthResponseSchema = z.object({
  flowId: z.string().min(1),
  state: providerOAuthStateSchema,
  interaction: providerOAuthInteractionSchema.optional(),
});
export type StartProviderOAuthResponse = z.infer<
  typeof startProviderOAuthResponseSchema
>;
export const providerOAuthFlowParamsSchema = z.object({
  flowId: z.string().min(1),
});
export const providerOAuthStatusResponseSchema = z.object({
  flowId: z.string().min(1),
  providerId: z.string().min(1),
  state: providerOAuthStateSchema,
  interaction: providerOAuthInteractionSchema.optional(),
  error: z.string().min(1).max(4096).optional(),
});
export type ProviderOAuthStatusResponse = z.infer<
  typeof providerOAuthStatusResponseSchema
>;
export const respondProviderOAuthRequestSchema = z.discriminatedUnion(
  "action",
  [
    z.object({
      action: z.literal("respond"),
      interactionId: z.string().min(1),
      value: z.string().max(65_536),
    }),
    z.object({ action: z.literal("cancel") }),
  ],
);
export type RespondProviderOAuthRequest = z.infer<
  typeof respondProviderOAuthRequestSchema
>;

export const sessionScopeSchema = z.enum(["project", "global", "control"]);
export type SessionScope = z.infer<typeof sessionScopeSchema>;
export const sessionStatusSchema = z.enum(["active", "idle", "archived"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const createSessionRequestSchema = z
  .object({
    title: z.string().optional(),
    scope: sessionScopeSchema.default("project"),
    projectId: z.string().min(1).optional(),
    projectRoot: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    hostCwdHint: z.string().min(1).optional(),
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
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
});
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;

export const createDerivedSessionRequestSchema = z
  .object({
    sourceMessageId: z.string().min(1).optional(),
    mode: z.enum(["fork", "clone"]),
    purpose: z.literal("quick_chat").optional(),
    title: z.string().min(1).max(160).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.purpose === "quick_chat" && value.mode !== "fork") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message: "quick chat must use fork mode",
      });
    }
    if (value.purpose === "quick_chat" && value.sourceMessageId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceMessageId"],
        message: "quick chat cutoff is selected by the daemon",
      });
    }
    if (
      value.mode === "fork" &&
      value.purpose !== "quick_chat" &&
      !value.sourceMessageId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceMessageId"],
        message: "sourceMessageId is required for fork",
      });
    }
  });
export type CreateDerivedSessionRequest = z.infer<
  typeof createDerivedSessionRequestSchema
>;
export const createDerivedSessionResponseSchema = createSessionResponseSchema;
export type CreateDerivedSessionResponse = z.infer<
  typeof createDerivedSessionResponseSchema
>;

export const navigateSessionRequestSchema = z.object({
  sourceMessageId: z.string().min(1),
});
export type NavigateSessionRequest = z.infer<
  typeof navigateSessionRequestSchema
>;

export const navigateSessionResponseSchema = z.object({
  editorText: z.string(),
});
export type NavigateSessionResponse = z.infer<
  typeof navigateSessionResponseSchema
>;

const queryBooleanSchema = z
  .union([z.boolean(), z.enum(["true", "1", "false", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

export const listSessionsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  scope: sessionScopeSchema.optional(),
  status: sessionStatusSchema.optional(),
  allProjects: queryBooleanSchema.optional(),
  includeArchived: queryBooleanSchema.optional(),
});
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;

export const searchQuerySchema = z.object({
  q: z.string().min(1),
  projectId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  allProjects: queryBooleanSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchHitSchema = z.object({
  sessionId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  snippet: z.string(),
  rank: z.number(),
  seq: z.number().int().nonnegative().optional(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchResponseSchema = z.object({
  hits: z.array(searchHitSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const userMessageAnchorSchema = z.object({
  messageId: z.string().min(1),
  seq: z.number().int().positive(),
  preview: z.string(),
  createdAt: z.string(),
});
export type UserMessageAnchor = z.infer<typeof userMessageAnchorSchema>;

export const userMessageAnchorsResponseSchema = z.object({
  messages: z.array(userMessageAnchorSchema),
});
export type UserMessageAnchorsResponse = z.infer<
  typeof userMessageAnchorsResponseSchema
>;

const compactTranscriptBaseSchema = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  source: eventSourceSchema,
});

export const compactTranscriptUserSchema = compactTranscriptBaseSchema.extend({
  kind: z.literal("user"),
  messageId: z.string().min(1),
  content: z.array(contentBlockSchema),
  queued: z.enum(["steer", "followUp"]).optional(),
  editedFromMessageId: z.string().min(1).optional(),
});
export type CompactTranscriptUser = z.infer<typeof compactTranscriptUserSchema>;

export const compactTranscriptEntrySchema = z.discriminatedUnion("kind", [
  compactTranscriptBaseSchema.extend({
    kind: z.literal("assistant"),
    messageId: z.string().min(1),
    content: z.array(contentBlockSchema),
    model: modelRefSchema.optional(),
    status: z.enum(["completed", "aborted", "failed"]),
    stopReason: z.enum(["end_turn", "tool_use", "max_tokens"]).optional(),
    usage: usageTotalsSchema.optional(),
    abortReason: z.enum(["user_abort", "daemon_shutdown"]).optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  compactTranscriptBaseSchema.extend({
    kind: z.literal("runtime"),
    messageId: z.string().min(1),
    runtimeType: z.enum(["custom", "bash", "branch-summary"]),
    content: z.array(contentBlockSchema),
    meta: z
      .object({
        command: z.string().optional(),
        exitCode: z.number().int().nullable().optional(),
        customType: z.string().optional(),
      })
      .optional(),
  }),
  compactTranscriptBaseSchema.extend({
    kind: z.literal("tool"),
    toolCallId: z.string().min(1),
    messageId: z.string().min(1),
    name: z.string().min(1),
    argsPreview: z.string(),
    status: z.enum(["running", "completed", "failed", "aborted", "denied"]),
    durationMs: z.number().nonnegative().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    abortReason: z.string().optional(),
    deniedReason: z.string().optional(),
    approvalId: z.string().min(1).optional(),
    hasDetails: z.boolean(),
  }),
  compactTranscriptBaseSchema.extend({
    kind: z.literal("approval"),
    approvalId: z.string().min(1),
    request: approvalRequestedSchema,
    state: z.enum(["pending", "responded", "expired", "cancelled"]),
    response: approvalResponseSchema.optional(),
    respondedBy: z.string().optional(),
    cancelReason: z.string().optional(),
  }),
  compactTranscriptBaseSchema.extend({
    kind: z.literal("marker"),
    markerKind: z.enum([
      "model",
      "thinking",
      "compaction",
      "compaction-failed",
      "terminal-start",
      "terminal-end",
      "run-failed",
    ]),
    text: z.string(),
  }),
]);
export type CompactTranscriptEntry = z.infer<
  typeof compactTranscriptEntrySchema
>;

export const compactTranscriptTurnSchema = z.object({
  user: compactTranscriptUserSchema,
  entries: z.array(compactTranscriptEntrySchema),
});
export type CompactTranscriptTurn = z.infer<typeof compactTranscriptTurnSchema>;

export const compactTranscriptQuerySchema = z
  .object({
    limitTurns: z.coerce.number().int().positive().max(50).default(10),
    beforeMessageId: z.string().min(1).optional(),
    aroundMessageId: z.string().min(1).optional(),
  })
  .refine((query) => !(query.beforeMessageId && query.aroundMessageId), {
    message: "beforeMessageId and aroundMessageId are mutually exclusive",
  });
export type CompactTranscriptQuery = z.infer<
  typeof compactTranscriptQuerySchema
>;

export const compactTranscriptResponseSchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  upToSeq: z.number().int().nonnegative(),
  turns: z.array(compactTranscriptTurnSchema),
  hasOlder: z.boolean(),
  hasNewer: z.boolean(),
});
export type CompactTranscriptResponse = z.infer<
  typeof compactTranscriptResponseSchema
>;

export const toolCallDetailSchema = z.object({
  toolCallId: z.string().min(1),
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  name: z.string().min(1),
  args: z.unknown(),
  result: z.unknown().optional(),
  status: z.enum(["running", "ok", "error", "aborted", "denied"]),
  startedSeq: z.number().int().positive(),
  endedSeq: z.number().int().positive().optional(),
  createdAt: z.string(),
});
export type ToolCallDetail = z.infer<typeof toolCallDetailSchema>;

export const toolCallDetailResponseSchema = z.object({
  toolCall: toolCallDetailSchema,
});
export type ToolCallDetailResponse = z.infer<
  typeof toolCallDetailResponseSchema
>;

export const sessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().optional(),
  rootBranchId: z.string().min(1),
  lastSeq: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  scope: sessionScopeSchema,
  status: sessionStatusSchema,
  projectId: z.string().min(1).optional(),
  projectRoot: z.string().min(1).optional(),
  cwd: z.string().min(1),
  hostCwdHint: z.string().min(1).optional(),
  origin: sessionOriginSchema.optional(),
  purpose: z.literal("quick_chat").optional(),
  sessionKind: z.enum(["primary", "subagent"]).optional(),
  parentSessionId: z.string().min(1).optional(),
  parentTaskId: z.string().min(1).optional(),
  derivedFrom: z
    .object({
      parentSessionId: z.string().min(1),
      sourceMessageId: z.string().min(1).optional(),
      mode: z.enum(["fork", "clone"]),
    })
    .optional(),
  subagent: agentTaskSummarySchema
    .pick({
      taskId: true,
      role: true,
      status: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
    })
    .optional(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const listSessionsResponseSchema = z.object({
  sessions: z.array(sessionSummarySchema),
});
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;

export const sessionIdParamsSchema = z.object({
  id: z.string().min(1),
});
export type SessionIdParams = z.infer<typeof sessionIdParamsSchema>;

export const updateSessionStatusRequestSchema = z.object({
  status: sessionStatusSchema,
});
export type UpdateSessionStatusRequest = z.infer<
  typeof updateSessionStatusRequestSchema
>;

export const createPtyRequestSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  cwd: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
});
export type CreatePtyRequest = z.infer<typeof createPtyRequestSchema>;

export const createPtyResponseSchema = z.object({
  ptyId: z.string().min(1),
  wsPath: z.string().min(1),
});
export type CreatePtyResponse = z.infer<typeof createPtyResponseSchema>;

export const ptyIdParamsSchema = z.object({
  id: z.string().min(1),
});
export type PtyIdParams = z.infer<typeof ptyIdParamsSchema>;

export const ptySummarySchema = z.object({
  ptyId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  cwd: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  attached: z.boolean(),
  createdAt: z.string(),
  lastAttachedAt: z.string().nullable(),
});
export type PtySummary = z.infer<typeof ptySummarySchema>;

export const listPtysResponseSchema = z.object({
  ptys: z.array(ptySummarySchema),
});
export type ListPtysResponse = z.infer<typeof listPtysResponseSchema>;

const websocketPathSchema = z
  .string()
  .refine(
    (path) =>
      path === "/v1/ws" ||
      /^\/v1\/ptys\/[^/?#]+\/ws$/.test(path) ||
      /^\/v1\/tunnels\/\d+\/ws$/.test(path),
    "must be an exact Agena WebSocket path",
  );

export const createWsTicketRequestSchema = z.object({
  path: websocketPathSchema,
});
export type CreateWsTicketRequest = z.infer<typeof createWsTicketRequestSchema>;
export const createWsTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  expiresAt: z.string(),
});
export type CreateWsTicketResponse = z.infer<
  typeof createWsTicketResponseSchema
>;

export const createPairingRequestSchema = z.object({
  daemonUrl: z.string().url(),
});
export type CreatePairingRequest = z.infer<typeof createPairingRequestSchema>;
export const createPairingResponseSchema = z.object({
  pairingUri: z.string().url(),
  expiresAt: z.string(),
});
export type CreatePairingResponse = z.infer<typeof createPairingResponseSchema>;

export const redeemPairingRequestSchema = z.object({
  clientId: z.string().min(1),
  deviceName: z.string().min(1).max(128),
  platform: z.enum(["ios", "android"]),
});
export type RedeemPairingRequest = z.infer<typeof redeemPairingRequestSchema>;
export const redeemPairingResponseSchema = z.object({
  daemonUrl: z.string().url(),
  token: z.string().min(1),
});
export type RedeemPairingResponse = z.infer<typeof redeemPairingResponseSchema>;

export const pendingApprovalSummarySchema = z.object({
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  seq: z.number().int().positive(),
  approvalId: z.string().min(1),
  requestedAt: z.string(),
  payload: approvalRequestedSchema,
});
export type PendingApprovalSummary = z.infer<
  typeof pendingApprovalSummarySchema
>;

export const listApprovalsQuerySchema = z.object({
  pending: queryBooleanSchema.optional(),
});
export type ListApprovalsQuery = z.infer<typeof listApprovalsQuerySchema>;

export const listApprovalsResponseSchema = z.object({
  approvals: z.array(pendingApprovalSummarySchema),
});
export type ListApprovalsResponse = z.infer<typeof listApprovalsResponseSchema>;

export const createSnapshotRequestSchema = z.object({
  name: z.string().optional(),
  sessionId: z.string().min(1).optional(),
});
export type CreateSnapshotRequest = z.infer<typeof createSnapshotRequestSchema>;

export const snapshotSummarySchema = z.object({
  snapshotId: z.string().min(1),
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  name: z.string().optional(),
  kind: z.enum(["manual", "auto", "pre_tool", "pre_restore"]),
  storagePath: z.string().min(1),
  sha256: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  status: z.enum(["available", "deleted"]),
  createdAt: z.string(),
});
export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>;

export const listSnapshotsResponseSchema = z.object({
  snapshots: z.array(snapshotSummarySchema),
});
export type ListSnapshotsResponse = z.infer<typeof listSnapshotsResponseSchema>;

export const createSnapshotResponseSchema = z.object({
  snapshot: snapshotSummarySchema,
});
export type CreateSnapshotResponse = z.infer<
  typeof createSnapshotResponseSchema
>;

export const snapshotIdParamsSchema = z.object({
  id: z.string().min(1),
});
export type SnapshotIdParams = z.infer<typeof snapshotIdParamsSchema>;

export const restoreSnapshotRequestSchema = z.object({
  sessionId: z.string().min(1).optional(),
});
export type RestoreSnapshotRequest = z.infer<
  typeof restoreSnapshotRequestSchema
>;

export const restoreSnapshotResponseSchema = z.object({
  snapshotId: z.string().min(1),
  safetySnapshotId: z.string().min(1),
});
export type RestoreSnapshotResponse = z.infer<
  typeof restoreSnapshotResponseSchema
>;

export const listFilesQuerySchema = z.object({
  path: z.string().min(1).default("."),
  depth: z.coerce.number().int().positive().max(1).default(1),
  cursor: z.string().optional(),
});
export type ListFilesQuery = z.infer<typeof listFilesQuerySchema>;

export const fileEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["file", "dir", "symlink", "other"]),
  size: z.number().int().nonnegative(),
  mtime: z.string(),
  mode: z.number().int().nonnegative(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const listFilesResponseSchema = z.object({
  entries: z.array(fileEntrySchema),
  nextCursor: z.string().nullable(),
});
export type ListFilesResponse = z.infer<typeof listFilesResponseSchema>;

export const fileContentQuerySchema = z.object({
  path: z.string().min(1),
});
export type FileContentQuery = z.infer<typeof fileContentQuerySchema>;

export const fileArchiveQuerySchema = z.object({
  path: z.string().min(1),
});
export type FileArchiveQuery = z.infer<typeof fileArchiveQuerySchema>;

export const createProjectRequestSchema = z.object({
  name: z.string().min(1),
  /** Import recovery may reuse a project directory created by an interrupted run. */
  reuseExisting: z.boolean().optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const projectResponseSchema = z.object({
  name: z.string().min(1),
  projectId: z.string().min(1),
  projectRoot: z.string().min(1),
  cwd: z.string().min(1),
});
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const projectIdParamsSchema = z.object({
  id: z.string().min(1),
});
export type ProjectIdParams = z.infer<typeof projectIdParamsSchema>;

/** Full teardown: rows, workspace files, pi sessions, snapshots (R2 follows the db). */
export const deleteProjectResponseSchema = z.object({
  projectId: z.string().min(1),
  deletedSessions: z.number().int().min(0),
});
export type DeleteProjectResponse = z.infer<typeof deleteProjectResponseSchema>;

export const fileUploadQuerySchema = z.object({
  path: z.string().min(1),
  format: z.literal("tar"),
});
export type FileUploadQuery = z.infer<typeof fileUploadQuerySchema>;

export const fileUploadResponseSchema = z.object({
  path: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
});
export type FileUploadResponse = z.infer<typeof fileUploadResponseSchema>;

export const discoveryEntrySchema = z.object({
  kind: z.enum(["tool", "skill", "hook"]),
  name: z.string().min(1),
  file: z.string().min(1),
  status: z.enum(["ok", "invalid", "collision"]),
  reason: z.string().optional(),
});
export type DiscoveryEntry = z.infer<typeof discoveryEntrySchema>;

export const diagnosticsResponseSchema = z.object({
  daemon: z.object({
    version: z.string(),
    uptimeMs: z.number().int().nonnegative(),
  }),
  protocol: z.object({
    version: z.number().int().positive(),
  }),
  workspace: z.object({
    path: z.string().min(1),
  }),
  discovery: z.object({
    entries: z.array(discoveryEntrySchema),
  }),
});
export type DiagnosticsResponse = z.infer<typeof diagnosticsResponseSchema>;

// ---- session import (settings_import_plan.md §6) ----------------------------

export const importHarnessSchema = z.enum(["claude", "codex", "pi"]);
export type Harness = z.infer<typeof importHarnessSchema>;

export const sourceFingerprintSchema = z.object({
  harness: importHarnessSchema,
  machineId: z.string().min(1),
  sourcePath: z.string().min(1),
  sourceSessionId: z.string().min(1),
  mtimeMs: z.number().nonnegative(),
  size: z.number().int().nonnegative(),
});
export type SourceFingerprint = z.infer<typeof sourceFingerprintSchema>;

export const importSessionRequestSchema = z.object({
  projectId: z.string().min(1),
  projectRoot: z.string().min(1),
  title: z.string().optional(),
  sourceFingerprint: sourceFingerprintSchema,
  /** Present only for a historically recorded child agent. */
  subagent: z
    .object({
      parentSourceSessionId: z.string().min(1),
      agentId: z.string().min(1),
      role: z.string().min(1),
      task: z.string().min(1),
      execution: z.enum(["foreground", "background"]),
      model: modelRefSchema,
    })
    .optional(),
  /** pi v3 JSONL, converted client-side. ≤ ~13 MB per session — plain JSON body. */
  piSession: z.string().min(1),
});
export type ImportSessionRequest = z.infer<typeof importSessionRequestSchema>;

// Keep a batch bounded: the desktop submits independent batches sequentially so
// imported parent sessions exist before their child-agent sessions.
export const importSessionsRequestSchema = z.object({
  sessions: z.array(importSessionRequestSchema).min(1).max(32),
});
export type ImportSessionsRequest = z.infer<typeof importSessionsRequestSchema>;

export const importSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  seededEvents: z.number().int().nonnegative(),
  /** True when the ledger already had (machineId, harness, sourceSessionId). */
  alreadyImported: z.boolean(),
});
export type ImportSessionResponse = z.infer<typeof importSessionResponseSchema>;

export const importSessionsResponseSchema = z.object({
  sessions: z.array(
    z.object({
      sourcePath: z.string().min(1),
      result: importSessionResponseSchema.optional(),
      error: z.string().min(1).optional(),
    }),
  ),
});
export type ImportSessionsResponse = z.infer<
  typeof importSessionsResponseSchema
>;

export const listImportsQuerySchema = z.object({
  machineId: z.string().min(1).optional(),
});
export type ListImportsQuery = z.infer<typeof listImportsQuerySchema>;

// Mirrors the daemon `imports` ledger table row.
export const importLedgerEntrySchema = z.object({
  id: z.string().min(1),
  /** Absent for project-only (harness "files") imports. */
  sessionId: z.string().min(1).optional(),
  projectId: z.string().min(1),
  machineId: z.string().min(1),
  harness: z.enum(["claude", "codex", "pi", "files"]),
  sourcePath: z.string().min(1),
  sourceSessionId: z.string().min(1).optional(),
  sourceMtimeMs: z.number().optional(),
  sourceSize: z.number().int().optional(),
  importedAt: z.string(),
});
export type ImportLedgerEntry = z.infer<typeof importLedgerEntrySchema>;

export const importsResponseSchema = z.object({
  imports: z.array(importLedgerEntrySchema),
  capabilities: z
    .object({
      session: z.boolean(),
      batch: z.boolean(),
    })
    .optional(),
});
export type ImportsResponse = z.infer<typeof importsResponseSchema>;

export function tunnelWsPath(port: number): string {
  return `/v1/tunnels/${port}/ws`;
}

export const PTY_HTTP_ROUTES = {
  createPairing: {
    method: "POST",
    path: "/v1/pairings",
    request: createPairingRequestSchema,
    response: createPairingResponseSchema,
  },
  redeemPairing: {
    method: "POST",
    path: "/v1/pairings/redeem",
    request: redeemPairingRequestSchema,
    response: redeemPairingResponseSchema,
  },
  createWsTicket: {
    method: "POST",
    path: "/v1/ws-tickets",
    request: createWsTicketRequestSchema,
    response: createWsTicketResponseSchema,
  },
  createSession: {
    method: "POST",
    path: "/v1/sessions",
    request: createSessionRequestSchema,
    response: createSessionResponseSchema,
  },
  createDerivedSession: {
    method: "POST",
    path: "/v1/sessions/:id/derived",
    params: sessionIdParamsSchema,
    request: createDerivedSessionRequestSchema,
    response: createDerivedSessionResponseSchema,
  },
  navigateSession: {
    method: "POST",
    path: "/v1/sessions/:id/navigate",
    params: sessionIdParamsSchema,
    request: navigateSessionRequestSchema,
    response: navigateSessionResponseSchema,
  },
  listSessions: {
    method: "GET",
    path: "/v1/sessions",
    query: listSessionsQuerySchema,
    response: listSessionsResponseSchema,
  },
  search: {
    method: "GET",
    path: "/v1/search",
    query: searchQuerySchema,
    response: searchResponseSchema,
  },
  listUserMessages: {
    method: "GET",
    path: "/v1/sessions/:id/user-messages",
    params: sessionIdParamsSchema,
    response: userMessageAnchorsResponseSchema,
  },
  updateSessionStatus: {
    method: "PATCH",
    path: "/v1/sessions/:id",
    params: sessionIdParamsSchema,
    request: updateSessionStatusRequestSchema,
  },
  createPty: {
    method: "POST",
    path: "/v1/ptys",
    request: createPtyRequestSchema,
    response: createPtyResponseSchema,
  },
  listPtys: {
    method: "GET",
    path: "/v1/ptys",
    response: listPtysResponseSchema,
  },
  deletePty: {
    method: "DELETE",
    path: "/v1/ptys/:id",
    params: ptyIdParamsSchema,
  },
  attachPty: {
    method: "GET",
    path: "/v1/ptys/:id/ws",
    params: ptyIdParamsSchema,
  },
  listApprovals: {
    method: "GET",
    path: "/v1/approvals",
    query: listApprovalsQuerySchema,
    response: listApprovalsResponseSchema,
  },
  listSnapshots: {
    method: "GET",
    path: "/v1/snapshots",
    response: listSnapshotsResponseSchema,
  },
  createSnapshot: {
    method: "POST",
    path: "/v1/snapshots",
    request: createSnapshotRequestSchema,
    response: createSnapshotResponseSchema,
  },
  restoreSnapshot: {
    method: "POST",
    path: "/v1/snapshots/:id/restore",
    params: snapshotIdParamsSchema,
    request: restoreSnapshotRequestSchema,
    response: restoreSnapshotResponseSchema,
  },
  deleteSnapshot: {
    method: "DELETE",
    path: "/v1/snapshots/:id",
    params: snapshotIdParamsSchema,
  },
  listFiles: {
    method: "GET",
    path: "/v1/files",
    query: listFilesQuerySchema,
    response: listFilesResponseSchema,
  },
  readFile: {
    method: "GET",
    path: "/v1/files/content",
    query: fileContentQuerySchema,
  },
  archiveFiles: {
    method: "GET",
    path: "/v1/files/archive",
    query: fileArchiveQuerySchema,
  },
  createProject: {
    method: "POST",
    path: "/v1/projects",
    request: createProjectRequestSchema,
    response: projectResponseSchema,
  },
  deleteProject: {
    method: "DELETE",
    path: "/v1/projects/:id",
    params: projectIdParamsSchema,
    response: deleteProjectResponseSchema,
  },
  uploadFiles: {
    method: "POST",
    path: "/v1/files/upload",
    query: fileUploadQuerySchema,
    response: fileUploadResponseSchema,
  },
  importSession: {
    method: "POST",
    path: "/v1/imports/session",
    request: importSessionRequestSchema,
    response: importSessionResponseSchema,
  },
  importSessions: {
    method: "POST",
    path: "/v1/imports/sessions",
    request: importSessionsRequestSchema,
    response: importSessionsResponseSchema,
  },
  listImports: {
    method: "GET",
    path: "/v1/imports",
    query: listImportsQuerySchema,
    response: importsResponseSchema,
  },
  listProviders: {
    method: "GET",
    path: "/v1/providers",
    response: listProvidersResponseSchema,
  },
  saveProviderApiKey: {
    method: "PUT",
    path: "/v1/providers/:id/api-key",
    params: providerIdParamsSchema,
    request: saveProviderApiKeyRequestSchema,
    response: providerAuthResponseSchema,
  },
  removeProviderAuth: {
    method: "DELETE",
    path: "/v1/providers/:id/auth",
    params: providerIdParamsSchema,
    response: providerAuthResponseSchema,
  },
  startProviderOAuth: {
    method: "POST",
    path: "/v1/providers/:id/oauth/start",
    params: providerIdParamsSchema,
    response: startProviderOAuthResponseSchema,
  },
  providerOAuthStatus: {
    method: "GET",
    path: "/v1/providers/oauth/:flowId",
    params: providerOAuthFlowParamsSchema,
    response: providerOAuthStatusResponseSchema,
  },
  respondProviderOAuth: {
    method: "POST",
    path: "/v1/providers/oauth/:flowId/respond",
    params: providerOAuthFlowParamsSchema,
    request: respondProviderOAuthRequestSchema,
    response: providerOAuthStatusResponseSchema,
  },
  listPlugins: {
    method: "GET",
    path: "/v1/plugins",
    response: listPluginsResponseSchema,
  },
  installPlugin: {
    method: "POST",
    path: "/v1/plugins/:id/install",
    params: pluginIdParamsSchema,
    response: pluginResponseSchema,
  },
  updatePlugin: {
    method: "POST",
    path: "/v1/plugins/:id/update",
    params: pluginIdParamsSchema,
    response: pluginResponseSchema,
  },
  setPluginEnabled: {
    method: "PATCH",
    path: "/v1/plugins/:id",
    params: pluginIdParamsSchema,
    request: setPluginEnabledRequestSchema,
    response: pluginResponseSchema,
  },
  removePlugin: {
    method: "DELETE",
    path: "/v1/plugins/:id",
    params: pluginIdParamsSchema,
    response: pluginResponseSchema,
  },
  diagnostics: {
    method: "GET",
    path: "/v1/diagnostics",
    response: diagnosticsResponseSchema,
  },
} as const;
