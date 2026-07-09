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
    Type.Literal("read"),
    Type.Literal("screenshot"),
    Type.Literal("click"),
    Type.Literal("type"),
    Type.Literal("evaluate"),
  ]),
  url: Type.Optional(Type.String({ description: "URL for action=open" })),
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
      "Control and inspect Agena Desktop's visible in-app browser pane. Use it for rendered UI verification when the desktop client is connected.",
    promptSnippet:
      "Use Agena Desktop's visible browser: open URLs, read rendered text/HTML, take screenshots, click, type, or evaluate page JavaScript.",
    promptGuidelines: [
      "Use visible_browser after making UI changes to verify the rendered result in the visible desktop browser.",
      "Prefer read or screenshot after open/click/type so you verify the actual rendered state.",
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
  const base = { sessionId, toolCallId };
  switch (params.action) {
    case "open":
      if (!params.url) throw new Error("visible_browser.open requires url");
      return visibleBrowserActionSchema.parse({
        ...base,
        action: "open",
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
    url: result.url,
    title: result.title,
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
