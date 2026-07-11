import { randomUUID } from "node:crypto";
import type {
  ProviderAuthSummary,
  ProviderOAuthInteraction,
  ProviderOAuthStatusResponse,
  RespondProviderOAuthRequest,
  StartProviderOAuthResponse,
} from "@agena/protocol";
import type { PiProviderService, PiProviderSummary } from "@agena/runtime-pi";

type LoginCallbacks = Parameters<PiProviderService["loginOAuth"]>[1];
type ProviderOwner = Pick<
  PiProviderService,
  "list" | "saveApiKey" | "remove" | "loginOAuth"
>;
type Flow = ProviderOAuthStatusResponse & {
  abort: AbortController;
  ready: () => void;
  queued: ProviderOAuthInteraction[];
  delivered: boolean;
  answers: Map<string, (value: string | undefined) => void>;
  expiry: ReturnType<typeof setTimeout>;
};

const FLOW_TTL_MS = 10 * 60 * 1000;

export class ProviderAuthService {
  readonly #providers: ProviderOwner;
  readonly #flows = new Map<string, Flow>();
  readonly #active = new Map<string, string>();

  constructor(providers: ProviderOwner) {
    this.#providers = providers;
  }

  list(): ProviderAuthSummary[] {
    return this.#providers.list().map(toSummary);
  }

  async saveApiKey(
    id: string,
    apiKey: string,
    env?: Record<string, string>,
  ): Promise<ProviderAuthSummary> {
    return toSummary(await this.#providers.saveApiKey(id, apiKey, env));
  }

  async remove(id: string): Promise<ProviderAuthSummary> {
    return toSummary(await this.#providers.remove(id));
  }

  async startOAuth(id: string): Promise<StartProviderOAuthResponse> {
    const active = this.#active.get(id);
    if (active && this.#flows.get(active)?.state === "pending")
      throw new Error(`provider "${id}" already has an active OAuth flow`);
    const flowId = randomUUID();
    let markReady!: () => void;
    const firstState = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const flow: Flow = {
      flowId,
      providerId: id,
      state: "pending",
      abort: new AbortController(),
      ready: markReady,
      queued: [],
      delivered: false,
      answers: new Map(),
      expiry: setTimeout(() => this.#timeout(flowId), FLOW_TTL_MS),
    };
    flow.expiry.unref?.();
    this.#flows.set(flowId, flow);
    this.#active.set(id, flowId);
    void this.#run(flow);
    await firstState;
    const result = publicStart(flow);
    flow.delivered = true;
    return result;
  }

  status(flowId: string): ProviderOAuthStatusResponse | null {
    const flow = this.#flows.get(flowId);
    if (!flow) return null;
    this.#advance(flow);
    const result = publicStatus(flow);
    flow.delivered = true;
    return result;
  }

  respond(flowId: string, input: RespondProviderOAuthRequest): void {
    const flow = this.#flows.get(flowId);
    if (!flow) throw new Error("provider OAuth flow not found");
    if (input.action === "cancel") {
      flow.state = "cancelled";
      this.#stop(flow);
      flow.ready();
      this.#retain(flow);
      return;
    }
    if (
      flow.state !== "pending" ||
      !flow.interaction ||
      flow.interaction.interactionId !== input.interactionId ||
      (flow.interaction.kind === "prompt" &&
        !flow.answers.has(input.interactionId))
    ) {
      throw new Error("provider OAuth interaction is no longer active");
    }
    const answer = flow.answers.get(input.interactionId);
    if (answer) {
      flow.answers.delete(input.interactionId);
      answer(input.value);
    }
    flow.interaction = flow.queued.shift();
    flow.delivered = false;
  }

  async #run(flow: Flow): Promise<void> {
    try {
      const callbacks: LoginCallbacks = {
        signal: flow.abort.signal,
        onAuth: (info) =>
          this.#publish(flow, {
            kind: "auth_url",
            interactionId: randomUUID(),
            url: info.url,
            ...(info.instructions ? { instructions: info.instructions } : {}),
          }),
        onDeviceCode: (info) =>
          this.#publish(flow, {
            kind: "device_code",
            interactionId: randomUUID(),
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            ...(info.intervalSeconds
              ? { intervalSeconds: info.intervalSeconds }
              : {}),
            ...(info.expiresInSeconds
              ? { expiresInSeconds: info.expiresInSeconds }
              : {}),
          }),
        onProgress: (message) =>
          this.#publish(flow, {
            kind: "progress",
            interactionId: randomUUID(),
            message,
          }),
        onPrompt: (prompt) =>
          this.#ask(flow, {
            kind: "prompt",
            interactionId: randomUUID(),
            inputKind: "text",
            message: prompt.message,
            ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
          }),
        onManualCodeInput: () =>
          this.#ask(flow, {
            kind: "prompt",
            interactionId: randomUUID(),
            inputKind: "manual_code",
            message: "Enter the authorization code",
          }),
        onSelect: async (prompt) =>
          this.#ask(flow, {
            kind: "prompt",
            interactionId: randomUUID(),
            inputKind: "select",
            message: prompt.message,
            options: prompt.options,
          }),
      };
      await this.#providers.loginOAuth(flow.providerId, callbacks);
      if (flow.state === "pending") flow.state = "completed";
    } catch (error) {
      if (flow.state !== "cancelled") {
        flow.state = "failed";
        flow.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      flow.answers.clear();
      flow.queued.length = 0;
      flow.interaction = undefined;
      flow.ready();
      this.#retain(flow);
    }
  }

  #publish(flow: Flow, interaction: ProviderOAuthInteraction): void {
    if (flow.state !== "pending") return;
    if (flow.interaction) flow.queued.push(interaction);
    else {
      flow.interaction = interaction;
      flow.delivered = false;
    }
    flow.ready();
  }

  #ask(flow: Flow, interaction: ProviderOAuthInteraction): Promise<string> {
    this.#publish(flow, interaction);
    return new Promise<string>((resolve, reject) => {
      flow.answers.set(interaction.interactionId, (value) =>
        value === undefined
          ? reject(new Error("provider OAuth cancelled"))
          : resolve(value),
      );
    });
  }

  #advance(flow: Flow): void {
    if (!flow.delivered || flow.queued.length === 0) return;
    if (flow.interaction && flow.answers.has(flow.interaction.interactionId))
      return;
    flow.interaction = flow.queued.shift();
    flow.delivered = false;
  }

  #timeout(flowId: string): void {
    const flow = this.#flows.get(flowId);
    if (flow?.state !== "pending") return;
    flow.state = "failed";
    flow.error = "provider OAuth flow expired";
    this.#stop(flow);
    flow.ready();
    this.#flows.delete(flowId);
  }

  #stop(flow: Flow): void {
    flow.abort.abort();
    for (const answer of flow.answers.values()) answer(undefined);
    flow.answers.clear();
    flow.queued.length = 0;
    flow.interaction = undefined;
    if (this.#active.get(flow.providerId) === flow.flowId)
      this.#active.delete(flow.providerId);
  }

  #retain(flow: Flow): void {
    clearTimeout(flow.expiry);
    if (this.#active.get(flow.providerId) === flow.flowId)
      this.#active.delete(flow.providerId);
    flow.expiry = setTimeout(
      () => this.#flows.delete(flow.flowId),
      FLOW_TTL_MS,
    );
    flow.expiry.unref?.();
  }
}

function toSummary(provider: PiProviderSummary): ProviderAuthSummary {
  return provider;
}

function publicStart(flow: Flow): StartProviderOAuthResponse {
  return {
    flowId: flow.flowId,
    state: flow.state,
    ...(flow.interaction ? { interaction: flow.interaction } : {}),
  };
}

function publicStatus(flow: Flow): ProviderOAuthStatusResponse {
  return {
    ...publicStart(flow),
    providerId: flow.providerId,
    ...(flow.error ? { error: flow.error } : {}),
  };
}
