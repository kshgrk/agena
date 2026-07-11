import type { PiProviderService, PiProviderSummary } from "@agena/runtime-pi";
import { afterEach, expect, test, vi } from "vitest";
import { ProviderAuthService } from "../src/provider-auth-service.ts";

const summary: PiProviderSummary = {
  id: "anthropic",
  name: "Anthropic",
  methods: ["api_key", "oauth"],
  modelCount: 2,
  configured: false,
};

afterEach(() => vi.useRealTimers());

test("keeps provider credentials behind secret-free summaries", async () => {
  let saved = "";
  const owner = {
    list: () => [summary],
    async saveApiKey(_id: string, key: string) {
      saved = key;
      return { ...summary, configured: true };
    },
    async remove() {
      saved = "";
      return summary;
    },
    async loginOAuth() {
      return summary;
    },
  } as unknown as PiProviderService;
  const service = new ProviderAuthService(owner);

  expect(service.list()).toEqual([summary]);
  expect(await service.saveApiKey("anthropic", "secret-key")).toMatchObject({
    configured: true,
  });
  expect(saved).toBe("secret-key");
  expect(JSON.stringify(service.list())).not.toContain("secret-key");
  await service.remove("anthropic");
  expect(saved).toBe("");
});

test("bridges Pi prompt callbacks through a resumable OAuth flow", async () => {
  let received = "";
  const owner = {
    list: () => [summary],
    async saveApiKey() {
      return summary;
    },
    async remove() {
      return summary;
    },
    async loginOAuth(
      _id: string,
      callbacks: Parameters<PiProviderService["loginOAuth"]>[1],
    ) {
      received = await callbacks.onPrompt({ message: "Paste code" });
      return { ...summary, configured: true, credentialKind: "oauth" as const };
    },
  } as unknown as PiProviderService;
  const service = new ProviderAuthService(owner);
  const started = await service.startOAuth("anthropic");

  expect(started).toMatchObject({
    state: "pending",
    interaction: { kind: "prompt", message: "Paste code" },
  });
  service.respond(started.flowId, {
    action: "respond",
    interactionId: started.interaction?.interactionId ?? "",
    value: "oauth-code",
  });
  await expect
    .poll(() => service.status(started.flowId)?.state)
    .toBe("completed");
  expect(received).toBe("oauth-code");
});

test("does not let a synchronous manual-code prompt overwrite the auth URL", async () => {
  const owner = {
    list: () => [summary],
    async saveApiKey() {
      return summary;
    },
    async remove() {
      return summary;
    },
    async loginOAuth(
      _id: string,
      callbacks: Parameters<PiProviderService["loginOAuth"]>[1],
    ) {
      callbacks.onAuth({ url: "https://login.example/authorize" });
      await callbacks.onManualCodeInput?.();
      return summary;
    },
  } as unknown as PiProviderService;
  const service = new ProviderAuthService(owner);
  const started = await service.startOAuth("anthropic");

  expect(started.interaction).toMatchObject({
    kind: "auth_url",
    url: "https://login.example/authorize",
  });
  const next = service.status(started.flowId);
  expect(next?.interaction).toMatchObject({
    kind: "prompt",
    inputKind: "manual_code",
  });
  service.respond(started.flowId, {
    action: "respond",
    interactionId: next?.interaction?.interactionId ?? "",
    value: "code",
  });
  await expect
    .poll(() => service.status(started.flowId)?.state)
    .toBe("completed");
});

test("rejects concurrent flows and expires an abandoned prompt", async () => {
  vi.useFakeTimers();
  let aborted = false;
  const owner = {
    list: () => [summary],
    async saveApiKey() {
      return summary;
    },
    async remove() {
      return summary;
    },
    async loginOAuth(
      _id: string,
      callbacks: Parameters<PiProviderService["loginOAuth"]>[1],
    ) {
      callbacks.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      await callbacks.onPrompt({ message: "Wait forever" });
      return summary;
    },
  } as unknown as PiProviderService;
  const service = new ProviderAuthService(owner);
  const started = await service.startOAuth("anthropic");

  await expect(service.startOAuth("anthropic")).rejects.toThrow(
    "already has an active OAuth flow",
  );
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
  expect(aborted).toBe(true);
  expect(service.status(started.flowId)).toBeNull();
});

test("clears an answered prompt and rejects a duplicate response", async () => {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const owner = {
    list: () => [summary],
    async saveApiKey() {
      return summary;
    },
    async remove() {
      return summary;
    },
    async loginOAuth(
      _id: string,
      callbacks: Parameters<PiProviderService["loginOAuth"]>[1],
    ) {
      await callbacks.onPrompt({ message: "Code" });
      await finished;
      return summary;
    },
  } as unknown as PiProviderService;
  const service = new ProviderAuthService(owner);
  const started = await service.startOAuth("anthropic");
  const interactionId = started.interaction?.interactionId ?? "";

  service.respond(started.flowId, {
    action: "respond",
    interactionId,
    value: "once",
  });
  expect(service.status(started.flowId)?.interaction).toBeUndefined();
  expect(() =>
    service.respond(started.flowId, {
      action: "respond",
      interactionId,
      value: "twice",
    }),
  ).toThrow("no longer active");
  finish();
});
