import { basename } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const TITLE_PROMPT = [
  "Generate a short session title for this coding task.",
  "Return only the title.",
  "Keep the user's language.",
  "No quotes. No trailing punctuation.",
  "Keep it concise.",
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
                { role: "user", content: firstPrompt, timestamp: Date.now() },
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

          pi.setSessionName(part.text);
          syncTitle(ctx);
          return;
        } catch {
          // Match pi-session-name: title failures are silent and leave unnamed.
        }
      }
    })();
  });
}
