import { z } from "zod";

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

export const PTY_HTTP_ROUTES = {
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
} as const;
