import type { VisibleBrowserController } from "@agena/core";
import {
  type VisibleBrowserAction,
  type VisibleBrowserResult,
  visibleBrowserActionSchema,
} from "@agena/protocol";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const visibleBrowserParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("open"),
    Type.Literal("list"),
    Type.Literal("close"),
    Type.Literal("navigate"),
    Type.Literal("read"),
    Type.Literal("screenshot"),
    Type.Literal("click"),
    Type.Literal("type"),
    Type.Literal("evaluate"),
  ]),
  url: Type.Optional(Type.String({ description: "URL for action=open" })),
  tabId: Type.Optional(
    Type.String({
      description:
        "Tab identifier returned by open/list; required for deterministic tab operations",
    }),
  ),
  kind: Type.Optional(
    Type.Union([
      Type.Literal("back"),
      Type.Literal("forward"),
      Type.Literal("reload"),
      Type.Literal("stop"),
      Type.Literal("url"),
    ]),
  ),
  includeHtml: Type.Optional(
    Type.Boolean({ description: "Include outerHTML for action=read" }),
  ),
  maxWidth: Type.Optional(
    Type.Number({ description: "Maximum screenshot width in CSS pixels" }),
  ),
  selector: Type.Optional(
    Type.String({ description: "CSS selector for click/type" }),
  ),
  x: Type.Optional(Type.Number({ description: "Viewport x coordinate" })),
  y: Type.Optional(Type.Number({ description: "Viewport y coordinate" })),
  text: Type.Optional(Type.String({ description: "Text for action=type" })),
  submit: Type.Optional(
    Type.Boolean({ description: "Submit nearest form after typing" }),
  ),
  script: Type.Optional(
    Type.String({
      description: "Page JavaScript expression for action=evaluate",
    }),
  ),
});

type VisibleBrowserParams = Static<typeof visibleBrowserParamsSchema>;

export function createVisibleBrowserTool(
  browser: VisibleBrowserController,
  sessionId: string,
) {
  return defineTool({
    name: "visible_browser",
    label: "Visible Browser",
    description:
      "Control and inspect Agena Desktop's visible tabbed browser. open creates a new tab and returns tabId; list reports open tabs; pass tabId to later actions.",
    promptSnippet:
      "Use Agena Desktop's visible browser: open URLs in new tabs, list tabs, then read, navigate, screenshot, click, type, evaluate, or close by tabId.",
    promptGuidelines: [
      "Use visible_browser after making UI changes to verify the rendered result in the visible desktop browser.",
      "Prefer read or screenshot after open/click/type so you verify the actual rendered state.",
      "Retain the tabId returned by open and pass it to every later operation on that page.",
      "Use list when you need to recover or inspect the currently open tab identifiers.",
      "This tool controls the shared in-app browser pane the user can see.",
    ],
    parameters: visibleBrowserParamsSchema,
    executionMode: "sequential",
    async execute(toolCallId, params) {
      const action = normalizeAction(params, sessionId, toolCallId);
      const result = await browser.request(action);
      return {
        content: result.screenshot
          ? [
              { type: "text", text: summarizeResult(result) },
              {
                type: "image",
                data: result.screenshot.base64,
                mimeType: result.screenshot.mimeType,
              },
            ]
          : [{ type: "text", text: summarizeResult(result) }],
        details: result,
      };
    },
  });
}

function normalizeAction(
  params: VisibleBrowserParams,
  sessionId: string,
  toolCallId: string,
): VisibleBrowserAction {
  const base = { sessionId, toolCallId, tabId: params.tabId };
  switch (params.action) {
    case "open":
      if (!params.url) throw new Error("visible_browser.open requires url");
      return visibleBrowserActionSchema.parse({
        ...base,
        action: "open",
        url: params.url,
      });
    case "list":
      return visibleBrowserActionSchema.parse({
        ...base,
        action: "list",
      });
    case "close":
      if (!params.tabId)
        throw new Error("visible_browser.close requires tabId");
      return visibleBrowserActionSchema.parse({
        ...base,
        action: "close",
        tabId: params.tabId,
      });
    case "navigate":
      if (!params.tabId || !params.kind)
        throw new Error("visible_browser.navigate requires tabId and kind");
      if (params.kind === "url" && !params.url)
        throw new Error("visible_browser.navigate kind=url requires url");
      return visibleBrowserActionSchema.parse({
        ...base,
        action: "navigate",
        tabId: params.tabId,
        kind: params.kind,
        url: params.url,
      });
    case "read":
      return visibleBrowserActionSchema.parse({
        ...base,
        action: "read",
        includeHtml: params.includeHtml,
      });
    case "screenshot":
      return visibleBrowserActionSchema.parse({
        ...base,
        action: "screenshot",
        maxWidth: params.maxWidth,
      });
    case "click":
      if (
        !params.selector &&
        (params.x === undefined || params.y === undefined)
      ) {
        throw new Error("visible_browser.click requires selector or x/y");
      }
      return visibleBrowserActionSchema.parse({
        ...base,
        action: "click",
        selector: params.selector,
        x: params.x,
        y: params.y,
      });
    case "type":
      if (params.text === undefined) {
        throw new Error("visible_browser.type requires text");
      }
      return visibleBrowserActionSchema.parse({
        ...base,
        action: "type",
        selector: params.selector,
        text: params.text,
        submit: params.submit,
      });
    case "evaluate":
      if (!params.script)
        throw new Error("visible_browser.evaluate requires script");
      return visibleBrowserActionSchema.parse({
        ...base,
        action: "evaluate",
        script: params.script,
      });
  }
}

function summarizeResult(result: VisibleBrowserResult): string {
  const payload = {
    ...(result.tabId ? { tabId: result.tabId } : {}),
    url: result.url,
    title: result.title,
    ...(result.tabs ? { tabs: result.tabs } : {}),
    ...(result.text ? { text: result.text } : {}),
    ...(result.html ? { html: result.html } : {}),
    ...(result.value !== undefined ? { value: result.value } : {}),
    ...(result.screenshot
      ? {
          screenshot: {
            mimeType: result.screenshot.mimeType,
            width: result.screenshot.width,
            height: result.screenshot.height,
          },
        }
      : {}),
  };
  return JSON.stringify(payload, null, 2);
}
