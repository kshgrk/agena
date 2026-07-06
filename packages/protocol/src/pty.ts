import { z } from "zod";

// §9.5 dedicated PTY WS text controls. Binary frames are raw PTY bytes and are
// intentionally not represented here.
export const ptyResizeControlFrameSchema = z.object({
  type: z.literal("resize"),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type PtyResizeControlFrame = z.infer<typeof ptyResizeControlFrameSchema>;

export const ptyExitControlFrameSchema = z.object({
  type: z.literal("exit"),
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).nullable(),
});
export type PtyExitControlFrame = z.infer<typeof ptyExitControlFrameSchema>;

export const ptyClientControlFrameSchema = ptyResizeControlFrameSchema;
export type PtyClientControlFrame = z.infer<typeof ptyClientControlFrameSchema>;

export const ptyDaemonControlFrameSchema = ptyExitControlFrameSchema;
export type PtyDaemonControlFrame = z.infer<typeof ptyDaemonControlFrameSchema>;
