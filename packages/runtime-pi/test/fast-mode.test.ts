import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import {
  createFastModeController,
  supportsFastMode,
} from "../src/fast-mode.ts";

const model = (provider: string, id: string, api: string) =>
  ({ provider, id, api }) as Model<Api>;

describe("fast mode", () => {
  it("only enables the supported OpenAI priority models", () => {
    expect(
      supportsFastMode(
        model("openai-codex", "gpt-5.6-sol", "openai-codex-responses"),
      ),
    ).toBe(true);
    expect(
      supportsFastMode(model("anthropic", "claude-opus-4", "anthropic")),
    ).toBe(false);
  });

  it("persists state and injects the priority service tier", async () => {
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    const appendEntry = vi.fn();
    const controller = createFastModeController();
    controller.extension({
      on: (name: string, handler: (event: never, ctx: never) => unknown) => {
        handlers.set(name, handler);
      },
      registerCommand: vi.fn(),
      appendEntry,
    } as never);
    controller.setEnabled(true);
    expect(appendEntry).toHaveBeenCalledWith("agena.fast-mode", {
      enabled: true,
    });
    const result = handlers.get("before_provider_request")?.(
      { payload: { model: "gpt-5.6-sol" } } as never,
      {
        model: model("openai-codex", "gpt-5.6-sol", "openai-codex-responses"),
      } as never,
    );
    expect(result).toMatchObject({ service_tier: "priority" });
  });
});
