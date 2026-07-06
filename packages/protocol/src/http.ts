import { z } from "zod";
import { approvalRequestedSchema } from "./events.ts";

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

export const PTY_HTTP_ROUTES = {
  createSession: {
    method: "POST",
    path: "/v1/sessions",
    request: createSessionRequestSchema,
    response: createSessionResponseSchema,
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
  diagnostics: {
    method: "GET",
    path: "/v1/diagnostics",
    response: diagnosticsResponseSchema,
  },
} as const;
