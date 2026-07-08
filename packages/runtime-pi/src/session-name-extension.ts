import { basename } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const TITLE_PROMPT = [
  "You are a session title generator for an AI coding workspace.",
  "Your only job is to name the session from the user's first message.",
  "Do not answer the user's request.",
  "Do not ask follow-up questions.",
  "Do not mention missing files, attachments, links, access, or context.",
  "Return only a compact noun phrase, 2-6 words, maximum 60 characters.",
  "Keep the user's language.",
  "Use Title Case when natural. No quotes. No trailing punctuation.",
  "",
  "Examples:",
  "User: what themes are present in this portfolio",
  "Title: Portfolio Theme Analysis",
  "User: fix the flaky auth test",
  "Title: Fix Flaky Auth Test",
  "User: create a snake game in react",
  "Title: React Snake Game",
  "User: why is docker compose not reading .env",
  "Title: Docker Compose Env Debugging",
].join("\n");

function formatTitle(
  ctx: ExtensionContext,
  sessionName: string,
  isRunning: boolean,
) {
  const prefix = isRunning ? "." : "*";
  return `${prefix} ${sessionName} - ${basename(ctx.cwd)}`;
}

// Adapted from pi-session-name@0.1.2. The published package imports the old
// @mariozechner/* namespace; keep the same extension behavior on Agena's pinned
// @earendil-works/* Pi SDK without adding a stale runtime dependency.
export function sessionNameExtension(pi: ExtensionAPI) {
  let firstPrompt: string | null = null;
  let started = false;
  let isRunning = false;

  function syncTitle(ctx: ExtensionContext) {
    const sessionName = pi.getSessionName();
    if (!sessionName) return;
    ctx.ui.setTitle(formatTitle(ctx, sessionName, isRunning));
  }

  pi.on("agent_start", async (_event, ctx) => {
    isRunning = true;
    syncTitle(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    isRunning = false;
    syncTitle(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (pi.getSessionName()) return;

    firstPrompt ??= event.text.trim();
    if (started || !firstPrompt) return;
    started = true;

    void (async () => {
      if (!ctx.model) return;

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok) return;

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await completeSimple(
            ctx.model,
            {
              systemPrompt: TITLE_PROMPT,
              messages: [
                {
                  role: "user",
                  content: `First user message:\n${firstPrompt}\n\nReturn the session title only.`,
                  timestamp: Date.now(),
                },
              ],
            },
            {
              maxTokens: 24,
              ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
              headers: {
                ...(ctx.model.headers ?? {}),
                ...(auth.headers ?? {}),
              },
            },
          );
          const part = response.content
            .toReversed()
            .find((p) => p.type === "text");
          if (!part) return;

          pi.setSessionName(titleFromResponse(part.text, firstPrompt));
          syncTitle(ctx);
          return;
        } catch {
          // Match pi-session-name: title failures are silent and leave unnamed.
        }
      }
    })();
  });
}

export function titleFromResponse(raw: string, firstPrompt: string): string {
  const title = cleanTitle(raw);
  if (title && !looksLikeAssistantReply(title)) return title;
  return fallbackTitle(firstPrompt);
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/^["'`]+|["'`.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

function looksLikeAssistantReply(title: string): boolean {
  const lower = title.toLowerCase();
  return (
    title.includes("?") ||
    /^(i\b|i'm\b|i don'?t\b|i can\b|i can'?t\b|sorry\b|could you\b|please\b|there (is|are)\b|it seems\b|based on\b)/.test(
      lower,
    ) ||
    lower.includes("please share") ||
    lower.includes("attached or linked") ||
    lower.includes("don't see")
  );
}

function fallbackTitle(prompt: string): string {
  const cleaned = cleanTitle(prompt).replace(/[^\w\s-]/g, " ");
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 8);
  const title = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
    .slice(0, 60)
    .trim();
  return title || "New Session";
}
