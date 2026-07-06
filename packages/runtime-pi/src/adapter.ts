// PiRuntimeAdapter — implements the core-owned RuntimeAdapter/RuntimeSession
// ports (§8.2) against @earendil-works/pi-coding-agent. The ONLY package
// importing the Pi SDK (P16).
// ponytail: M1 surface only — createSession + prompt + text-streaming events
// (§14 M1). steer/abort/setModel/compact/approvals, the tool bridge, and idle
// eviction land with M2–M4.
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type {
  CreateRuntimeSessionInput,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeInFlightSnapshot,
  RuntimeSession,
} from "@agena/core";
import type {
  ApprovalResponse,
  ModelRef,
  RuntimeInfoAck,
  ThinkingLevel,
} from "@agena/protocol";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
  type AgentSession,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { captureEnabled, createCaptureTee } from "./capture.ts";
import {
  createMapperState,
  type MapperState,
  mapPiEvent,
} from "./event-map.ts";

/** The exact-pinned Pi SDK version (§8.9), surfaced at /v1/diagnostics. */
export const PI_SDK_VERSION: string = VERSION;

/** Pi reads its config root from this env var — the plan's "PI_DIR" (§3.3). */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export interface PiRuntimeOptions {
  /** Pi state root (§3.3). Default: $AGENA_STATE_DIR/pi, else /var/lib/agena/pi. */
  piDir?: string;
  /** "provider/model-id" used when core passes no model (§9.9 runtime.pi.defaultModel). */
  defaultModel?: string;
}

/**
 * §8.3 extension containment (M1-R2): Pi must load NO filesystem extensions —
 * neither <piDir>/extensions nor <workspace>/.pi/extensions. In the installed
 * 0.80.3 API an empty additionalExtensionPaths does NOT disable discovery
 * (DefaultPackageManager.resolve() still scans both dirs); `noExtensions: true`
 * is the control that does, keeping only explicitly passed paths/factories —
 * which we pass none of in M1. Verified by test/containment.test.ts.
 */
export function containedResourceLoader(
  cwd: string,
  agentDir: string,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    additionalExtensionPaths: [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
}

function parseModelRef(spec: string): ModelRef {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(`defaultModel must be "provider/model-id", got "${spec}"`);
  }
  return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

export class PiRuntimeAdapter implements RuntimeAdapter {
  readonly id = "pi" as const;
  readonly version = PI_SDK_VERSION;
  readonly piDir: string;
  #capturesDir: string;
  #defaultModel: string | undefined;
  #sessions = new Map<string, PiRuntimeSession>();

  constructor(options: PiRuntimeOptions = {}) {
    this.piDir = resolve(
      options.piDir ??
        join(process.env.AGENA_STATE_DIR ?? "/var/lib/agena", "pi"),
    );
    this.#capturesDir = join(dirname(this.piDir), "captures"); // §3.3 sibling of pi/
    this.#defaultModel = options.defaultModel;
    // §3.3/§8.3: Pi state lives under piDir, never ~/.pi or /workspace. Set the
    // redirect, then hard-fail if Pi resolves its config root anywhere else.
    process.env[PI_AGENT_DIR_ENV] = this.piDir;
    const resolved = resolve(getAgentDir());
    if (resolved !== this.piDir) {
      throw new Error(
        `PI_DIR verification failed: Pi getAgentDir() resolved to "${resolved}", expected "${this.piDir}"`,
      );
    }
  }

  async createSession(
    input: CreateRuntimeSessionInput,
  ): Promise<RuntimeSession> {
    const authStorage = AuthStorage.create(join(this.piDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(
      authStorage,
      join(this.piDir, "models.json"),
    );
    const want =
      input.model ??
      (!input.runtimeSessionRef && this.#defaultModel
        ? parseModelRef(this.#defaultModel)
        : undefined);
    const model = want ? modelRegistry.find(want.provider, want.id) : undefined;
    if (want && !model) {
      throw new Error(`unknown model "${want.provider}/${want.id}"`);
    }

    const resourceLoader = containedResourceLoader(input.cwd, this.piDir);
    await resourceLoader.reload();

    const { session, extensionsResult, modelFallbackMessage } =
      await createAgentSession({
        cwd: input.cwd,
        agentDir: this.piDir,
        authStorage,
        modelRegistry,
        resourceLoader,
        // Persistent JSONL raw layer under piDir/sessions (env redirect above).
        sessionManager: input.runtimeSessionRef
          ? SessionManager.open(input.runtimeSessionRef, undefined, input.cwd)
          : SessionManager.create(input.cwd),
        ...(!input.runtimeSessionRef ? { thinkingLevel: "off" as const } : {}),
        // ponytail: M1 streams text only — no invisible built-in tool runs;
        // the Agena tool bridge re-enables tools in M3/M4 (§8.3).
        noTools: "all",
        ...(model ? { model } : {}), // absent → Pi settings default (§8.3 fallback)
      });
    // M1: extension-failed / model-changed RuntimeEvents are M2+ — log only.
    for (const e of extensionsResult.errors) {
      console.warn(
        `[agena-runtime-pi] extension error at ${e.path}: ${e.error}`,
      );
    }
    if (modelFallbackMessage) {
      console.warn(`[agena-runtime-pi] ${modelFallbackMessage}`);
    }

    const capture = captureEnabled()
      ? createCaptureTee(input.sessionId, this.#capturesDir, PI_SDK_VERSION)
      : null;
    const runtime = new PiRuntimeSession(
      input.sessionId,
      session,
      modelRegistry,
      capture,
    );
    this.#sessions.set(input.sessionId, runtime);
    return runtime;
  }

  async dispose(): Promise<void> {
    for (const s of this.#sessions.values()) await s.dispose();
    this.#sessions.clear();
  }
}

class PiRuntimeSession implements RuntimeSession {
  readonly sessionId: string;
  readonly runtimeSessionRef: string;
  state: "idle" | "running" | "errored" | "disposed" = "idle";

  #session: AgentSession;
  #modelRegistry: ModelRegistry;
  #map: MapperState = createMapperState(randomUUID);
  #queue: RuntimeEvent[] = [];
  #wake: (() => void) | null = null;
  #error: Error | null = null;
  #consuming = false;
  #unsubscribe: () => void;
  // Mirror in-flight buffer (§8.6-lite): built from our own mapped events.
  #run: RuntimeInFlightSnapshot["run"] = null;
  #message: RuntimeInFlightSnapshot["assistantMessage"] = null;

  constructor(
    sessionId: string,
    session: AgentSession,
    modelRegistry: ModelRegistry,
    capture: ((event: unknown) => void) | null,
  ) {
    this.sessionId = sessionId;
    this.#session = session;
    this.#modelRegistry = modelRegistry;
    const ref = session.sessionFile;
    if (!ref) {
      throw new Error(
        "Pi session has no JSONL file (persistent SessionManager expected, §8.3)",
      );
    }
    this.runtimeSessionRef = ref;
    this.#unsubscribe = session.subscribe((ev) => {
      capture?.(ev); // raw tee first — sees every event pre-mapping (§8.7)
      let mapped: RuntimeEvent[];
      try {
        mapped = mapPiEvent(this.#map, ev);
      } catch (err) {
        console.warn(`[agena-runtime-pi] mapper failed on "${ev.type}":`, err);
        return;
      }
      for (const out of mapped) {
        this.#mirror(out);
        this.#queue.push(out);
      }
      if (mapped.length > 0) this.#wakeUp();
    });
  }

  events(): AsyncIterable<RuntimeEvent> {
    if (this.#consuming) {
      throw new Error(
        "events() already has a consumer (single-consumer, §8.2)",
      );
    }
    this.#consuming = true;
    return this.#iterate();
  }

  /** Resolves on Pi preflight ACCEPT, not run completion (§8.2). */
  async prompt(input: { messageId: string; text: string }): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`prompt while runtime session is ${this.state}`);
    }
    this.#map.triggerMessageId = input.messageId; // §8.5 correlation
    this.state = "running";
    try {
      await new Promise<void>((accept, rejectAccept) => {
        this.#session
          .prompt(input.text, {
            preflightResult: (ok) =>
              ok
                ? accept()
                : rejectAccept(new Error("Pi rejected the prompt (preflight)")),
          })
          .then(() => {
            // the full run finished; agent_end already flowed through the mapper
            if (this.state === "running") this.state = "idle";
          })
          .catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            rejectAccept(error); // no-op if already accepted
            this.#fail(error); // mid-run throw → session errored, events() throws (§8.6)
          });
      });
    } catch (err) {
      if (this.state === "running") this.state = "idle"; // preflight rejection: still usable
      throw err;
    }
  }

  async steer(input: { messageId: string; text: string }): Promise<void> {
    this.#map.triggerMessageId = input.messageId;
    await callPi(this.#session, "steer", input.text);
  }

  async followUp(input: { messageId: string; text: string }): Promise<void> {
    this.#map.triggerMessageId = input.messageId;
    await callPi(this.#session, "followUp", input.text);
  }

  async abort(): Promise<void> {
    await callPi(this.#session, "abort");
    if (this.state === "running") this.state = "idle";
  }

  async info(): Promise<RuntimeInfoAck> {
    return {
      ...(this.#session.model ? { model: modelRef(this.#session.model) } : {}),
      thinkingLevel: this.#session.thinkingLevel,
      availableModels: this.#modelRegistry.getAvailable().map(modelRef),
      availableThinkingLevels: this.#session.getAvailableThinkingLevels(),
      slashCommands: this.#session.promptTemplates.map((p) => ({
        name: p.name,
        ...(p.description ? { description: p.description } : {}),
      })),
    };
  }

  async setModel(model: ModelRef): Promise<void> {
    const resolved = this.#modelRegistry.find(model.provider, model.id);
    if (!resolved) {
      throw new Error(`unknown model "${model.provider}/${model.id}"`);
    }
    await callPi(this.#session, "setModel", resolved);
  }

  async setThinkingLevel(thinkingLevel: ThinkingLevel): Promise<void> {
    await callPi(this.#session, "setThinkingLevel", thinkingLevel);
  }

  async compact(): Promise<{ summary: string }> {
    const result = await callPi(this.#session, "compact");
    return {
      summary:
        typeof result === "string"
          ? result
          : "Context compacted by the runtime.",
    };
  }

  async respondToApproval(
    approvalId: string,
    response: ApprovalResponse,
  ): Promise<void> {
    await callPi(this.#session, "respondToApproval", approvalId, response);
  }

  getInFlightSnapshot(): RuntimeInFlightSnapshot | null {
    if (!this.#run) return null;
    return {
      sessionId: this.sessionId,
      run: this.#run,
      assistantMessage: this.#message,
    };
  }

  async dispose(): Promise<void> {
    if (this.state === "disposed") return;
    this.state = "disposed";
    this.#unsubscribe();
    this.#session.dispose();
    this.#wakeUp();
  }

  async *#iterate(): AsyncGenerator<RuntimeEvent> {
    while (true) {
      const ev = this.#queue.shift();
      if (ev) {
        yield ev;
        continue;
      }
      if (this.#error) throw this.#error; // core's pump frees the session
      if (this.state === "disposed") return;
      await new Promise<void>((r) => {
        this.#wake = r;
      });
    }
  }

  #wakeUp(): void {
    this.#wake?.();
    this.#wake = null;
  }

  #fail(err: Error): void {
    if (this.state === "disposed") return;
    this.state = "errored";
    this.#error = err;
    this.#wakeUp();
  }

  #mirror(ev: RuntimeEvent): void {
    switch (ev.type) {
      case "run-started":
        this.#run = {
          runId: ev.runId,
          startedAt: new Date().toISOString(),
          trigger: ev.trigger,
        };
        return;
      case "assistant-message-started":
        this.#message = {
          messageId: ev.messageId,
          model: ev.model,
          blocks: [],
        };
        return;
      case "assistant-text-delta": {
        if (!this.#message) return;
        const block = this.#message.blocks.find(
          (b) => b.index === ev.blockIndex,
        );
        if (block) block.text += ev.delta;
        else {
          this.#message.blocks.push({
            index: ev.blockIndex,
            type: "text",
            text: ev.delta,
          });
        }
        return;
      }
      case "assistant-message-completed":
      case "assistant-message-failed":
      case "assistant-message-aborted":
        this.#message = null;
        return;
      case "run-completed":
      case "run-failed":
      case "run-aborted":
        this.#run = null;
        return;
    }
  }
}

function modelRef(model: Model<Api>): ModelRef {
  return { provider: model.provider, id: model.id };
}

async function callPi(
  session: AgentSession,
  method: string,
  ...args: unknown[]
): Promise<unknown> {
  const fn = (session as unknown as Record<string, unknown>)[method];
  if (typeof fn !== "function") {
    throw new Error(`Pi runtime does not expose ${method}()`);
  }
  return await Reflect.apply(fn, session, args);
}
