import { join } from "node:path";
import type {
  OAuthLoginCallbacks,
  OAuthProviderId,
} from "@earendil-works/pi-ai/compat";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

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

/** Pi-native provider credential owner. Values never leave AuthStorage. */
export class PiProviderService {
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  readonly #onCredentialsChanged: () => void | Promise<void>;

  constructor(options: PiProviderServiceOptions) {
    this.authStorage = AuthStorage.create(join(options.piDir, "auth.json"));
    this.modelRegistry = ModelRegistry.create(
      this.authStorage,
      join(options.piDir, "models.json"),
    );
    this.#onCredentialsChanged = options.onCredentialsChanged ?? (() => {});
  }

  list(): PiProviderSummary[] {
    const modelCounts = new Map<string, number>();
    for (const model of this.modelRegistry.getAll())
      modelCounts.set(
        model.provider,
        (modelCounts.get(model.provider) ?? 0) + 1,
      );
    const oauthIds = new Set(
      this.authStorage.getOAuthProviders().map((provider) => provider.id),
    );
    const ids = new Set([
      ...modelCounts.keys(),
      ...this.authStorage.list(),
      ...oauthIds,
    ]);
    return [...ids]
      .sort((a, b) => a.localeCompare(b))
      .map((id) =>
        this.#summary(id, modelCounts.get(id) ?? 0, oauthIds.has(id)),
      );
  }

  status(providerId: string): PiProviderSummary {
    const models = this.modelRegistry
      .getAll()
      .filter((model) => model.provider === providerId).length;
    const oauth = this.authStorage
      .getOAuthProviders()
      .some((provider) => provider.id === providerId);
    return this.#summary(providerId, models, oauth);
  }

  async saveApiKey(
    providerId: string,
    apiKey: string,
    env?: Record<string, string>,
  ): Promise<PiProviderSummary> {
    if (!providerId.trim()) throw new Error("provider id is required");
    if (!apiKey) throw new Error("API key is required");
    if (!this.status(providerId).methods.includes("api_key"))
      throw new Error(
        `provider "${providerId}" does not support API-key login`,
      );
    this.authStorage.set(providerId, {
      type: "api_key",
      key: apiKey,
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
    });
    await this.#changed();
    const stored = this.authStorage.get(providerId);
    const summary = this.status(providerId);
    if (stored?.type !== "api_key" || !summary.configured)
      throw new Error(`failed to persist API key for provider "${providerId}"`);
    return summary;
  }

  async remove(providerId: string): Promise<PiProviderSummary> {
    this.authStorage.remove(providerId);
    await this.#changed();
    if (this.authStorage.get(providerId) !== undefined)
      throw new Error(
        `failed to remove credential for provider "${providerId}"`,
      );
    return this.status(providerId);
  }

  async loginOAuth(
    providerId: string,
    callbacks: OAuthLoginCallbacks,
  ): Promise<PiProviderSummary> {
    const provider = this.authStorage
      .getOAuthProviders()
      .find((candidate) => candidate.id === providerId);
    if (!provider)
      throw new Error(`provider "${providerId}" does not support OAuth`);
    await this.authStorage.login(provider.id as OAuthProviderId, callbacks);
    await this.#changed();
    const stored = this.authStorage.get(providerId);
    const summary = this.status(providerId);
    if (stored?.type !== "oauth" || !summary.configured)
      throw new Error(
        `failed to persist OAuth credential for provider "${providerId}"`,
      );
    return summary;
  }

  async reload(): Promise<PiProviderSummary[]> {
    this.authStorage.reload();
    this.modelRegistry.refresh();
    await this.#onCredentialsChanged();
    return this.list();
  }

  #summary(
    id: string,
    modelCount: number,
    oauthCapable: boolean,
  ): PiProviderSummary {
    const auth = this.modelRegistry.getProviderAuthStatus(id);
    const credential = this.authStorage.get(id);
    return {
      id,
      name: this.modelRegistry.getProviderDisplayName(id),
      methods: [
        ...(!oauthCapable || API_KEY_AND_OAUTH_PROVIDERS.has(id)
          ? (["api_key"] as const)
          : []),
        ...(oauthCapable ? (["oauth"] as const) : []),
      ],
      modelCount,
      configured: auth.configured,
      ...(auth.source ? { source: auth.source } : {}),
      ...(auth.label ? { label: auth.label } : {}),
      ...(credential ? { credentialKind: credential.type } : {}),
    };
  }

  async #changed(): Promise<void> {
    this.authStorage.reload();
    this.modelRegistry.refresh();
    await this.#onCredentialsChanged();
  }
}

// Pi 0.80.3's authoritative login policy offers both methods only for
// Anthropic. Its other built-in OAuth providers (GitHub Copilot/OpenAI Codex),
// plus extension-registered OAuth-only providers, must not advertise API keys.
const API_KEY_AND_OAUTH_PROVIDERS = new Set(["anthropic"]);
