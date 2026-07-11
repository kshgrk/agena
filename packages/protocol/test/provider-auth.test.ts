import { describe, expect, it } from "vitest";
import {
  listProvidersResponseSchema,
  PTY_HTTP_ROUTES,
  providerAuthResponseSchema,
  providerOAuthStatusResponseSchema,
  respondProviderOAuthRequestSchema,
  saveProviderApiKeyRequestSchema,
  startProviderOAuthResponseSchema,
} from "../src/index.ts";

describe("provider authentication HTTP contract", () => {
  const provider = {
    id: "anthropic",
    name: "Anthropic",
    modelCount: 12,
    methods: ["api_key", "oauth"],
    configured: true,
    credentialKind: "oauth",
    source: "stored",
    label: "OAuth",
  };

  it("reports capability and credential presence without secret values", () => {
    expect(
      listProvidersResponseSchema.parse({ providers: [provider] }),
    ).toEqual({ providers: [provider] });
    expect(
      providerAuthResponseSchema.parse({
        provider: { ...provider, apiKey: "must-not-cross-the-wire" },
      }),
    ).toEqual({ provider });
    expect(
      saveProviderApiKeyRequestSchema.parse({ apiKey: "sk-test" }),
    ).toEqual({ apiKey: "sk-test" });
    expect(
      saveProviderApiKeyRequestSchema.safeParse({ apiKey: "" }).success,
    ).toBe(false);
  });

  it("represents every pinned Pi OAuth callback without credential fields", () => {
    const interactions = [
      {
        kind: "auth_url",
        interactionId: "1",
        url: "https://example.com/oauth",
        instructions: "Open the page",
      },
      {
        kind: "device_code",
        interactionId: "2",
        userCode: "ABCD-EFGH",
        verificationUri: "https://example.com/device",
        intervalSeconds: 5,
        expiresInSeconds: 600,
      },
      { kind: "progress", interactionId: "3", message: "Waiting" },
      {
        kind: "prompt",
        interactionId: "4",
        inputKind: "secret",
        message: "Paste a one-time code",
        placeholder: "code",
      },
      {
        kind: "prompt",
        interactionId: "5",
        inputKind: "select",
        message: "Choose an account",
        options: [{ id: "work", label: "Work", description: "Team account" }],
      },
      {
        kind: "prompt",
        interactionId: "6",
        inputKind: "manual_code",
        message: "Paste the redirect code",
      },
    ] as const;
    for (const interaction of interactions) {
      expect(
        startProviderOAuthResponseSchema.parse({
          flowId: "flow-1",
          state: "pending",
          interaction,
        }).interaction,
      ).toEqual(interaction);
    }
    expect(
      startProviderOAuthResponseSchema.safeParse({
        flowId: "flow-1",
        state: "pending",
        interaction: {
          kind: "prompt",
          interactionId: "missing-options",
          inputKind: "select",
          message: "Choose",
        },
      }).success,
    ).toBe(false);
    expect(
      providerOAuthStatusResponseSchema.parse({
        flowId: "flow-1",
        providerId: "anthropic",
        state: "completed",
      }),
    ).toEqual({
      flowId: "flow-1",
      providerId: "anthropic",
      state: "completed",
    });
  });

  it("accepts interaction responses or cancellation and catalogs every route", () => {
    expect(
      respondProviderOAuthRequestSchema.parse({
        action: "respond",
        interactionId: "prompt-1",
        value: "selected-account",
      }),
    ).toEqual({
      action: "respond",
      interactionId: "prompt-1",
      value: "selected-account",
    });
    expect(
      respondProviderOAuthRequestSchema.parse({ action: "cancel" }),
    ).toEqual({ action: "cancel" });
    expect(PTY_HTTP_ROUTES.listProviders.path).toBe("/v1/providers");
    expect(PTY_HTTP_ROUTES.saveProviderApiKey.method).toBe("PUT");
    expect(PTY_HTTP_ROUTES.removeProviderAuth.path).toBe(
      "/v1/providers/:id/auth",
    );
    expect(PTY_HTTP_ROUTES.removeProviderAuth.response).toBe(
      providerAuthResponseSchema,
    );
    expect(PTY_HTTP_ROUTES.startProviderOAuth.path).toBe(
      "/v1/providers/:id/oauth/start",
    );
    expect(PTY_HTTP_ROUTES.providerOAuthStatus.path).toBe(
      "/v1/providers/oauth/:flowId",
    );
    expect(PTY_HTTP_ROUTES.respondProviderOAuth.path).toBe(
      "/v1/providers/oauth/:flowId/respond",
    );
  });
});
