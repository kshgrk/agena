import { z } from "zod";

export const VISIBLE_BROWSER_CAPABILITY = "visible_browser" as const;

const browserBaseSchema = z.object({
  sessionId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
  tabId: z.string().min(1).optional(),
});

export const visibleBrowserActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("open"),
      url: z.string().min(1),
    })
    .merge(browserBaseSchema),
  z
    .object({
      action: z.literal("openExternalOAuth"),
      url: z.string().url(),
      serverName: z.string().min(1),
    })
    .merge(browserBaseSchema),
  z.object({ action: z.literal("list") }).merge(browserBaseSchema),
  browserBaseSchema.merge(
    z.object({
      action: z.literal("close"),
      tabId: z.string().min(1),
    }),
  ),
  browserBaseSchema.merge(
    z.object({
      action: z.literal("navigate"),
      tabId: z.string().min(1),
      kind: z.enum(["back", "forward", "reload", "stop", "url"]),
      url: z.string().min(1).optional(),
    }),
  ),
  z
    .object({
      action: z.literal("read"),
      includeHtml: z.boolean().optional(),
    })
    .merge(browserBaseSchema),
  z
    .object({
      action: z.literal("screenshot"),
      maxWidth: z.number().int().positive().max(2048).optional(),
    })
    .merge(browserBaseSchema),
  z
    .object({
      action: z.literal("click"),
      selector: z.string().min(1).optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
    })
    .merge(browserBaseSchema),
  z
    .object({
      action: z.literal("type"),
      selector: z.string().min(1).optional(),
      text: z.string(),
      submit: z.boolean().optional(),
    })
    .merge(browserBaseSchema),
  z
    .object({
      action: z.literal("evaluate"),
      script: z.string().min(1),
    })
    .merge(browserBaseSchema),
]);
export type VisibleBrowserAction = z.infer<typeof visibleBrowserActionSchema>;

export const visibleBrowserScreenshotSchema = z.object({
  mimeType: z.literal("image/jpeg"),
  base64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type VisibleBrowserScreenshot = z.infer<
  typeof visibleBrowserScreenshotSchema
>;

export const visibleBrowserTabSchema = z.object({
  tabId: z.string().min(1),
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
});
export type VisibleBrowserTab = z.infer<typeof visibleBrowserTabSchema>;

export const visibleBrowserResultSchema = z.object({
  tabId: z.string().min(1).optional(),
  url: z.string(),
  title: z.string(),
  tabs: z.array(visibleBrowserTabSchema).optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  value: z.unknown().optional(),
  screenshot: visibleBrowserScreenshotSchema.optional(),
});
export type VisibleBrowserResult = z.infer<typeof visibleBrowserResultSchema>;
