import type { FastModeState } from "@agena/protocol";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "agena.fast-mode";
const SUPPORTED_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

export function supportsFastMode(model: Model<Api> | undefined): boolean {
  return Boolean(
    model &&
      (model.provider === "openai" || model.provider === "openai-codex") &&
      (model.api === "openai-responses" ||
        model.api === "openai-codex-responses") &&
      SUPPORTED_MODELS.has(model.id),
  );
}

export type FastModeController = ReturnType<typeof createFastModeController>;

export function createFastModeController() {
  let enabled = false;
  let api: ExtensionAPI | undefined;

  const setEnabled = (next: boolean, persist = true) => {
    enabled = next;
    if (persist) api?.appendEntry(ENTRY_TYPE, { enabled });
  };

  const extension: ExtensionFactory = (pi) => {
    api = pi;

    pi.on("session_start", async (_event, ctx) => {
      const saved = ctx.sessionManager
        .getBranch()
        .toReversed()
        .find(
          (entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE,
        );
      const value = saved?.type === "custom" ? saved.data : undefined;
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { enabled?: unknown }).enabled === "boolean"
      ) {
        setEnabled((value as { enabled: boolean }).enabled, false);
      }
    });

    pi.on("before_provider_request", (event, ctx) => {
      if (!enabled || !supportsFastMode(ctx.model)) return;
      if (
        typeof event.payload !== "object" ||
        event.payload === null ||
        Array.isArray(event.payload) ||
        (event.payload as Record<string, unknown>).service_tier !== undefined
      ) {
        return;
      }
      return { ...event.payload, service_tier: "priority" };
    });

    pi.registerCommand("fast", {
      description: "Toggle OpenAI priority processing",
      handler: async (args, ctx) => {
        const command = args.trim().toLowerCase();
        if (command === "status") {
          ctx.ui.notify(`Fast mode is ${enabled ? "on" : "off"}`);
          return;
        }
        if (command && command !== "on" && command !== "off") {
          ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
          return;
        }
        setEnabled(command === "on" || (command !== "off" && !enabled));
        ctx.ui.notify(`Fast mode ${enabled ? "enabled" : "disabled"}`);
      },
    });
  };

  return {
    extension,
    setEnabled,
    state(model: Model<Api> | undefined): FastModeState {
      const available = supportsFastMode(model);
      return { enabled, available, active: enabled && available };
    },
  };
}
