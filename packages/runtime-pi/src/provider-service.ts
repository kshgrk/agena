import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialStore,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export type PiProviderSummary = {
  id: string;
  name: string;
  methods: Array<"api_key" | "oauth">;
  modelCount: number;
  configured: boolean;
  source?:
    | "stored"
    | "runtime"
    | "environment"
    | "fallback"
    | "models_json_key"
    | "models_json_command";
  label?: string;
  credentialKind?: "api_key" | "oauth";
};

export type PiProviderServiceOptions = {
  piDir: string;
  onCredentialsChanged?: () => void | Promise<void>;
};

/** Pi-native provider credential owner. Values never leave the credential store. */
export class PiProviderService {
  readonly modelRuntime: ModelRuntime;
  readonly modelRegistry: ModelRegistry;
  readonly #credentials: PiAuthStorage;
  readonly #onCredentialsChanged: () => void | Promise<void>;
  #credentialKinds = new Map<string, Credential["type"]>();

  private constructor(
    options: PiProviderServiceOptions,
    credentials: PiAuthStorage,
    modelRuntime: ModelRuntime,
  ) {
    this.#credentials = credentials;
    this.modelRuntime = modelRuntime;
    this.modelRegistry = new ModelRegistry(modelRuntime);
    this.#onCredentialsChanged = options.onCredentialsChanged ?? (() => {});
  }

  static async create(
    options: PiProviderServiceOptions,
  ): Promise<PiProviderService> {
    const credentials = await createPiAuthStorage(
      join(options.piDir, "auth.json"),
    );
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: join(options.piDir, "models.json"),
    });
    const service = new PiProviderService(options, credentials, modelRuntime);
    await service.#refreshCredentialKinds();
    return service;
  }

  list(): PiProviderSummary[] {
    const modelCounts = new Map<string, number>();
    for (const model of this.modelRuntime.getModels())
      modelCounts.set(
        model.provider,
        (modelCounts.get(model.provider) ?? 0) + 1,
      );
    const ids = new Set([
      ...modelCounts.keys(),
      ...this.modelRuntime.getProviders().map((provider) => provider.id),
      ...this.#credentialKinds.keys(),
    ]);
    return [...ids]
      .sort((a, b) => a.localeCompare(b))
      .map((id) => this.#summary(id, modelCounts.get(id) ?? 0));
  }

  status(providerId: string): PiProviderSummary {
    const models = this.modelRuntime.getModels(providerId).length;
    return this.#summary(providerId, models);
  }

  async saveApiKey(
    providerId: string,
    apiKey: string,
    env?: Record<string, string>,
  ): Promise<PiProviderSummary> {
    if (!providerId.trim()) throw new Error("provider id is required");
    if (!apiKey) throw new Error("API key is required");
    const provider = this.modelRuntime.getProvider(providerId);
    if (
      provider?.auth.oauth &&
      (!provider.auth.apiKey || OAUTH_ONLY_PROVIDER_UI.has(providerId))
    )
      throw new Error(
        `provider "${providerId}" does not support API-key login`,
      );
    await this.#credentials.modify(providerId, async () => ({
      type: "api_key",
      key: apiKey,
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    }));
    await this.#changed(providerId);
    const summary = this.status(providerId);
    if (summary.credentialKind !== "api_key" || !summary.configured)
      throw new Error(`failed to persist API key for provider "${providerId}"`);
    return summary;
  }

  async remove(providerId: string): Promise<PiProviderSummary> {
    await this.modelRuntime.logout(providerId);
    await this.#changed(providerId);
    if (this.#credentialKinds.has(providerId))
      throw new Error(
        `failed to remove credential for provider "${providerId}"`,
      );
    return this.status(providerId);
  }

  async loginOAuth(
    providerId: string,
    callbacks: OAuthLoginCallbacks,
  ): Promise<PiProviderSummary> {
    const provider = this.modelRuntime.getProvider(providerId);
    if (!provider?.auth.oauth)
      throw new Error(`provider "${providerId}" does not support OAuth`);
    await this.modelRuntime.login(
      providerId,
      "oauth",
      legacyOAuthInteraction(callbacks),
    );
    await this.#changed(providerId);
    const summary = this.status(providerId);
    if (summary.credentialKind !== "oauth" || !summary.configured)
      throw new Error(
        `failed to persist OAuth credential for provider "${providerId}"`,
      );
    return summary;
  }

  async reload(): Promise<PiProviderSummary[]> {
    this.#credentials.reload();
    await this.#refreshCredentialKinds();
    await this.modelRuntime.refresh({ allowNetwork: false });
    await this.#onCredentialsChanged();
    return this.list();
  }

  #summary(id: string, modelCount: number): PiProviderSummary {
    const provider = this.modelRuntime.getProvider(id);
    const auth = this.modelRuntime.getProviderAuthStatus(id);
    const credentialKind = this.#credentialKinds.get(id);
    return {
      id,
      name: provider?.name ?? id,
      methods: [
        ...((provider?.auth.apiKey && !OAUTH_ONLY_PROVIDER_UI.has(id)) ||
        !provider?.auth.oauth
          ? (["api_key"] as const)
          : []),
        ...(provider?.auth.oauth ? (["oauth"] as const) : []),
      ],
      modelCount,
      configured: credentialKind !== undefined || auth.configured,
      ...(credentialKind !== undefined
        ? { source: "stored" as const, credentialKind }
        : {}),
      ...(credentialKind === undefined && auth.source
        ? { source: auth.source }
        : {}),
      ...(auth.label ? { label: auth.label } : {}),
    };
  }

  async #changed(providerId: string): Promise<void> {
    await this.#refreshCredentialKinds();
    await this.modelRuntime.refresh({
      allowNetwork: false,
      providers: [providerId],
    });
    await this.#onCredentialsChanged();
  }

  async #refreshCredentialKinds(): Promise<void> {
    this.#credentialKinds = new Map(
      (await this.#credentials.list()).map((credential) => [
        credential.providerId,
        credential.type,
      ]),
    );
  }
}

function legacyOAuthInteraction(
  callbacks: OAuthLoginCallbacks,
): AuthInteraction {
  return {
    ...(callbacks.signal ? { signal: callbacks.signal } : {}),
    prompt: (prompt) => respondToLegacyPrompt(callbacks, prompt),
    notify(event) {
      if (event.type === "auth_url")
        callbacks.onAuth({
          url: event.url,
          ...(event.instructions ? { instructions: event.instructions } : {}),
        });
      else if (event.type === "device_code") callbacks.onDeviceCode(event);
      else if (event.type === "progress") callbacks.onProgress?.(event.message);
      else callbacks.onProgress?.(event.message);
    },
  };
}

async function respondToLegacyPrompt(
  callbacks: OAuthLoginCallbacks,
  prompt: AuthPrompt,
): Promise<string> {
  if (prompt.type === "select") {
    const answer = await callbacks.onSelect({
      message: prompt.message,
      options: [...prompt.options],
    });
    if (answer === undefined) throw new Error("provider OAuth cancelled");
    return answer;
  }
  if (prompt.type === "manual_code" && callbacks.onManualCodeInput)
    return callbacks.onManualCodeInput();
  return callbacks.onPrompt({
    message: prompt.message,
    ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
  });
}

type PiAuthStorage = CredentialStore & { reload(): void };

async function createPiAuthStorage(path: string): Promise<PiAuthStorage> {
  // ponytail: Pi 0.84 made AuthStorage internal while still using it for the
  // SDK's authPath. Delete this loader when Pi exports a persistent store.
  const packageEntry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const module = (await import(
    pathToFileURL(join(dirname(packageEntry), "core/auth-storage.js")).href
  )) as {
    AuthStorage: { create(path: string): PiAuthStorage };
  };
  return module.AuthStorage.create(path);
}

// Tokens for these providers are acquired through OAuth; do not expose their
// low-level ambient-token fallback as a user-entered API-key login method.
const OAUTH_ONLY_PROVIDER_UI = new Set(["github-copilot", "openai-codex"]);
