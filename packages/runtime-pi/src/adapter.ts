// PiRuntimeAdapter — implements the core-owned RuntimeAdapter/RuntimeSession
// ports (§8.2) against @earendil-works/pi-coding-agent. The ONLY package
// importing the Pi SDK (P16).
// ponytail: M1 surface only — createSession + prompt + text-streaming events
// (§14 M1). steer/abort/setModel/compact/approvals, the tool bridge, and idle
// eviction land with M2–M4.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type {
  CreateForkRuntimeSessionInput,
  CreateRuntimeSessionInput,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeInFlightSnapshot,
  RuntimeInput,
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
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  estimateTokens,
  findCutPoint,
  getAgentDir,
  type ModelRegistry,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { captureEnabled, createCaptureTee } from "./capture.ts";
import { CodexUsageReader } from "./codex-usage.ts";
import {
  createMapperState,
  type MapperState,
  mapPiEvent,
} from "./event-map.ts";
import {
  createFastModeController,
  type FastModeController,
} from "./fast-mode.ts";
import { PiPackageService } from "./package-service.ts";
import { PiProviderService } from "./provider-service.ts";
import { sessionNameExtension } from "./session-name-extension.ts";
import { createSubagentTool } from "./subagent-tool.ts";
import { createVisibleBrowserTool } from "./visible-browser-tool.ts";

/** The exact-pinned Pi SDK version (§8.9), surfaced at /v1/diagnostics. */
export const PI_SDK_VERSION: string = VERSION;

/** Pi reads its config root from this env var — the plan's "PI_DIR" (§3.3). */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

const CORE_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const OVERFLOW_COMPACTION_SUMMARY =
  "Emergency context recovery: older detailed history was omitted because it exceeded the model context window. The retained recent messages are authoritative; re-read relevant project files and verify earlier state before acting.";

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
 * is the control that does, keeping only explicitly passed paths/factories.
 * The single bundled factory is pi-session-name-compatible session naming.
 * Verified by test/containment.test.ts.
 */
export function containedResourceLoader(
  cwd: string,
  agentDir: string,
  visibleBrowser?: CreateRuntimeSessionInput["visibleBrowser"],
  packageSources: string[] = [],
  fastModeExtension?: ExtensionFactory,
): DefaultResourceLoader {
  const browser = browserExtensionSource();
  const mcp = mcpExtensionSource();
  const skillRoot = join(dirname(agentDir), "skills");
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    // Opt-in agent browser tool only (AGENA_BROWSER_TOOL=1). additionalExtensionPaths
    // still load under noExtensions:true — only filesystem auto-discovery is disabled —
    // so containment is unchanged when the tool is off (browser === null → []).
    additionalExtensionPaths: [
      ...(browser ? [browser] : []),
      mcp,
      ...packageSources,
    ],
    extensionFactories: [
      sessionNameExtension,
      ...(fastModeExtension ? [fastModeExtension] : []),
      ...(visibleBrowser ? [mcpSystemOAuthExtension(visibleBrowser)] : []),
    ],
    noExtensions: true,
    noSkills: true,
    // An explicit root remains contained under noSkills:true and lets reload()
    // discover packages imported after this runtime session was created.
    additionalSkillPaths: [skillRoot],
    noPromptTemplates: true,
    noThemes: true,
    extensionsOverride: (result) => {
      const extensions = result.extensions
        .filter((extension) => {
          const conflict = CORE_TOOL_NAMES.find((name) =>
            extension.tools.has(name),
          );
          if (!conflict) return true;
          result.errors.push({
            path: extension.path,
            error: `extension cannot override Agena core tool "${conflict}"`,
          });
          return false;
        })
        .map((extension) => {
          const browserTool = extension.tools.get("agent_browser");
          if (!browserTool) return extension;
          const tools = new Map(extension.tools);
          tools.set("agent_browser", {
            ...browserTool,
            definition: withAgentBrowserRestoreRetry(browserTool.definition),
          });
          return { ...extension, tools };
        });
      return { ...result, extensions };
    },
  });
}

/** Retry only the wrapper's safe pre-spawn restore-policy rejection. */
export function withAgentBrowserRestoreRetry(
  tool: ToolDefinition,
): ToolDefinition {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await execute(toolCallId, params, signal, onUpdate, ctx);
      if (
        !isAutoBrowserSession(params) ||
        !hasManagedRestorePolicyError(result.content)
      ) {
        return result;
      }
      return execute(
        toolCallId,
        { ...params, sessionMode: "fresh" },
        signal,
        onUpdate,
        ctx,
      );
    },
  };
}

function isAutoBrowserSession(
  params: unknown,
): params is Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params))
    return false;
  const mode = (params as Record<string, unknown>).sessionMode;
  return mode === undefined || mode === "auto";
}

function hasManagedRestorePolicyError(
  content: ReadonlyArray<{ type: string; text?: string }>,
): boolean {
  return content.some(
    (item) =>
      item.type === "text" &&
      /managed session restore policy/i.test(item.text ?? ""),
  );
}

function mcpSystemOAuthExtension(
  browser: NonNullable<CreateRuntimeSessionInput["visibleBrowser"]>,
): ExtensionFactory {
  return (pi) => {
    pi.on("tool_result", async (event) => {
      if (event.toolName !== "mcp") return;
      const details = event.details as
        | { mode?: string; server?: string; authorizationUrl?: string }
        | undefined;
      if (
        details?.mode !== "auth-start" ||
        !details.server ||
        !details.authorizationUrl
      ) {
        return;
      }
      await browser.request({
        action: "openExternalOAuth",
        url: details.authorizationUrl,
        serverName: details.server,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `OAuth authentication completed for "${details.server}" in the system browser.`,
          },
        ],
        details: { ...details, authenticated: true },
      };
    });
  };
}

function mcpExtensionSource(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("pi-mcp-adapter/package.json"));
}

/**
 * Resolve the pi-agent-browser-native extension source when the agent browser
 * tool is enabled via AGENA_BROWSER_TOOL=1 (§ agent-browser). Returns null when
 * disabled or the package is not installed, so the daemon behaves exactly as
 * before (containment test unaffected). The package is installed only in the
 * container image (docker/Dockerfile), so require.resolve degrades gracefully
 * to a warning in local dev. AGENA_BROWSER_EXTENSION overrides the resolved
 * path. Pi's extension loader supplies the package's pi peer-deps (pi-tui,
 * typebox, …) via its jiti alias map, so no runtime-pi dependency is needed.
 */
function browserExtensionSource(): string | null {
  if (process.env.AGENA_BROWSER_TOOL !== "1") return null;
  const override = process.env.AGENA_BROWSER_EXTENSION;
  if (override) return override;
  try {
    const require = createRequire(import.meta.url);
    // Pass the package root dir: DefaultResourceLoader reads its pi.extensions
    // manifest to find the extension entry. package.json has no "exports", so
    // this subpath resolves via classic resolution (incl. global node_modules).
    return dirname(require.resolve("pi-agent-browser-native/package.json"));
  } catch (err) {
    console.warn(
      `[agena-runtime-pi] AGENA_BROWSER_TOOL=1 but pi-agent-browser-native is not resolvable; agent browser tool disabled: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
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
  readonly providers: PiProviderService;
  readonly packages: PiPackageService;
  #capturesDir: string;
  #defaultModel: string | undefined;
  #codexUsage = new CodexUsageReader();
  #sessions = new Map<string, PiRuntimeSession>();

  private constructor(
    piDir: string,
    providers: PiProviderService,
    options: PiRuntimeOptions,
  ) {
    this.piDir = piDir;
    this.#capturesDir = join(dirname(this.piDir), "captures"); // §3.3 sibling of pi/
    this.#defaultModel = options.defaultModel;
    this.providers = providers;
    this.packages = new PiPackageService({
      piDir: this.piDir,
    });
  }

  static async create(
    options: PiRuntimeOptions = {},
  ): Promise<PiRuntimeAdapter> {
    const piDir = resolve(
      options.piDir ??
        join(process.env.AGENA_STATE_DIR ?? "/var/lib/agena", "pi"),
    );
    // §3.3/§8.3: Pi state lives under piDir, never ~/.pi or /workspace. Set the
    // redirect, then hard-fail if Pi resolves its config root anywhere else.
    process.env[PI_AGENT_DIR_ENV] = piDir;
    const resolved = resolve(getAgentDir());
    if (resolved !== piDir) {
      throw new Error(
        `PI_DIR verification failed: Pi getAgentDir() resolved to "${resolved}", expected "${piDir}"`,
      );
    }
    let reload = async () => {};
    const providers = await PiProviderService.create({
      piDir,
      onCredentialsChanged: () => reload(),
    });
    const adapter = new PiRuntimeAdapter(piDir, providers, options);
    reload = () => adapter.reloadExtensions();
    return adapter;
  }

  async createSession(
    input: CreateRuntimeSessionInput,
  ): Promise<RuntimeSession> {
    const sessionManager = input.runtimeSessionRef
      ? SessionManager.open(input.runtimeSessionRef, undefined, input.cwd)
      : SessionManager.create(input.cwd);
    return this.#createSession(input, sessionManager);
  }

  async createForkSession(
    input: CreateForkRuntimeSessionInput,
  ): Promise<RuntimeSession> {
    const source = SessionManager.open(
      input.sourceRuntimeSessionRef,
      undefined,
      input.cwd,
    );
    const entryId = input.runtimeEntryId ?? source.getLeafId();
    if (!entryId) {
      throw new Error("cannot fork an empty Pi session");
    }
    const entry = source.getEntry(entryId);
    if (!entry) {
      throw new Error(`Pi runtime entry "${entryId}" was not found`);
    }

    const forkFrom = input.position === "before" ? entry.parentId : entry.id;
    const sessionManager = forkFrom
      ? SessionManager.open(
          requireForkedSession(source, forkFrom),
          undefined,
          input.cwd,
        )
      : SessionManager.create(input.cwd, source.getSessionDir(), {
          parentSession: input.sourceRuntimeSessionRef,
        });
    const runtimeSessionRef = sessionManager.getSessionFile();
    if (!runtimeSessionRef) {
      throw new Error("Pi did not create a persistent fork session");
    }
    return this.#createSession({ ...input, runtimeSessionRef }, sessionManager);
  }

  async #createSession(
    input: CreateRuntimeSessionInput,
    sessionManager: SessionManager,
  ): Promise<RuntimeSession> {
    const modelRuntime = this.providers.modelRuntime;
    const modelRegistry = this.providers.modelRegistry;
    const want =
      input.model ??
      (!input.runtimeSessionRef && this.#defaultModel
        ? parseModelRef(this.#defaultModel)
        : undefined);
    const model = want ? modelRegistry.find(want.provider, want.id) : undefined;
    if (want && !model) {
      throw new Error(`unknown model "${want.provider}/${want.id}"`);
    }

    const fastMode = createFastModeController();
    const resourceLoader = containedResourceLoader(
      input.cwd,
      this.piDir,
      input.visibleBrowser,
      this.packages.extensionSources,
      fastMode.extension,
    );
    await resourceLoader.reload();
    const extensionTools = resourceLoader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    const customTools = [
      ...(input.visibleBrowser
        ? [createVisibleBrowserTool(input.visibleBrowser, input.sessionId)]
        : []),
      ...(input.subagents
        ? [createSubagentTool(input.subagents, input.sessionId)]
        : []),
    ];

    const { session, extensionsResult, modelFallbackMessage } =
      await createAgentSession({
        cwd: input.cwd,
        agentDir: this.piDir,
        modelRuntime,
        resourceLoader,
        // Persistent JSONL raw layer under piDir/sessions (env redirect above).
        sessionManager,
        ...(!input.runtimeSessionRef ? { thinkingLevel: "off" as const } : {}),
        // Explicit allowlist: extension-registered tools are filtered unless
        // named here. agent_browser joins only when its extension actually
        // resolved (same gate the loader uses), so a missing package degrades
        // to exactly the baseline toolset.
        tools: (
          input.toolNames ?? [
            ...new Set([
              ...CORE_TOOL_NAMES,
              ...(input.visibleBrowser ? ["visible_browser"] : []),
              ...(input.subagents ? ["subagent"] : []),
              ...(browserExtensionSource() !== null ? ["agent_browser"] : []),
              "mcp",
              ...extensionTools,
            ]),
          ]
        ).filter((name) =>
          input.toolNames ? input.toolNames.includes(name) : true,
        ),
        customTools,
        ...(model ? { model } : {}), // absent → Pi settings default (§8.3 fallback)
      });
    // SDK/headless callers must bind explicitly; this emits session_start so
    // stateful extensions such as pi-mcp-adapter initialize before any prompt.
    await session.bindExtensions({
      mode: "rpc",
      onError: (error) =>
        console.warn("[agena-runtime-pi] extension error", error),
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
      modelRuntime,
      fastMode,
      this.#codexUsage,
      capture,
    );
    this.#sessions.set(input.sessionId, runtime);
    return runtime;
  }

  async reloadExtensions(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map((session) => session.reloadExtensions()),
    );
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
  #modelRuntime: ModelRuntime;
  #fastMode: FastModeController;
  #codexUsage: CodexUsageReader;

  #map: MapperState = createMapperState(randomUUID);
  #queue: RuntimeEvent[] = [];
  #wake: (() => void) | null = null;
  #error: Error | null = null;
  #reloadPending = false;
  #reloadPromise: Promise<void> = Promise.resolve();
  #consuming = false;
  #unsubscribe: () => void;
  #pendingUserMessageIds: string[] = [];
  // Mirror in-flight buffer (§8.6-lite): built from our own mapped events.
  #run: RuntimeInFlightSnapshot["run"] = null;
  #message: RuntimeInFlightSnapshot["assistantMessage"] = null;

  constructor(
    sessionId: string,
    session: AgentSession,
    modelRegistry: ModelRegistry,
    modelRuntime: ModelRuntime,
    fastMode: FastModeController,
    codexUsage: CodexUsageReader,
    capture: ((event: unknown) => void) | null,
  ) {
    this.sessionId = sessionId;
    this.#session = session;
    this.#modelRegistry = modelRegistry;
    this.#modelRuntime = modelRuntime;
    this.#fastMode = fastMode;
    this.#codexUsage = codexUsage;
    const ref = session.sessionFile;
    if (!ref) {
      throw new Error(
        "Pi session has no JSONL file (persistent SessionManager expected, §8.3)",
      );
    }
    this.runtimeSessionRef = ref;
    this.#unsubscribe = session.subscribe((ev) => {
      if (ev.type === "agent_end") this.#codexUsage.invalidate();
      capture?.(ev); // raw tee first — sees every event pre-mapping (§8.7)
      this.#captureMessageRuntimeRef(ev);
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
  async prompt(input: RuntimeInput): Promise<void> {
    await this.#reloadPromise.catch(() => {});
    if (this.state !== "idle") {
      throw new Error(`prompt while runtime session is ${this.state}`);
    }
    this.#map.triggerMessageId = input.messageId; // §8.5 correlation
    this.#pendingUserMessageIds.push(input.messageId);
    this.state = "running";
    try {
      await new Promise<void>((accept, rejectAccept) => {
        this.#session
          .prompt(input.text, {
            images: piImages(input),
            preflightResult: (ok) =>
              ok
                ? accept()
                : rejectAccept(new Error("Pi rejected the prompt (preflight)")),
          })
          .then(() => {
            // the full run finished; agent_end already flowed through the mapper
            if (this.state === "running") {
              this.state = "idle";
              void this.#applyPendingReload().catch((error) =>
                console.warn(
                  "[agena-runtime-pi] deferred reload failed",
                  error,
                ),
              );
            }
          })
          .catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            rejectAccept(error); // no-op if already accepted
            this.#fail(error); // mid-run throw → session errored, events() throws (§8.6)
          });
      });
    } catch (err) {
      this.#forgetPendingUserMessage(input.messageId);
      if (this.state === "running") this.state = "idle"; // preflight rejection: still usable
      throw err;
    }
  }

  async steer(input: RuntimeInput): Promise<void> {
    this.#map.triggerMessageId = input.messageId;
    this.#pendingUserMessageIds.push(input.messageId);
    try {
      await callPi(this.#session, "steer", input.text, piImages(input));
    } catch (error) {
      this.#forgetPendingUserMessage(input.messageId);
      throw error;
    }
  }

  async followUp(input: RuntimeInput): Promise<void> {
    this.#map.triggerMessageId = input.messageId;
    this.#pendingUserMessageIds.push(input.messageId);
    try {
      await callPi(this.#session, "followUp", input.text, piImages(input));
    } catch (error) {
      this.#forgetPendingUserMessage(input.messageId);
      throw error;
    }
  }

  async abort(): Promise<void> {
    await callPi(this.#session, "abort");
    if (this.state === "running") {
      this.state = "idle";
      void this.#applyPendingReload().catch((error) =>
        console.warn("[agena-runtime-pi] deferred reload failed", error),
      );
    }
  }

  async reloadExtensions(): Promise<void> {
    if (this.state === "disposed" || this.state === "errored") return;
    this.#reloadPending = true;
    await this.#applyPendingReload();
  }

  async #applyPendingReload(): Promise<void> {
    if (this.state !== "idle") return;
    this.#reloadPromise = this.#reloadPromise
      .catch(() => {})
      .then(async () => {
        if (!this.#reloadPending || this.state !== "idle") return;
        this.#reloadPending = false;
        try {
          await this.#session.reload();
        } catch (error) {
          this.#reloadPending = true;
          throw error;
        }
      });
    await this.#reloadPromise;
  }

  async info(): Promise<RuntimeInfoAck> {
    await this.#modelRuntime.refresh({ allowNetwork: false });
    const model = this.#session.model;
    const stats = this.#session.getSessionStats();
    const subscriptionUsage = this.#modelRuntime.isUsingSubscription(
      model?.provider ?? "",
    )
      ? await this.#codexUsage.read(this.#modelRegistry, model)
      : undefined;
    return {
      ...(model ? { model: modelRef(model) } : {}),
      thinkingLevel: this.#session.thinkingLevel,
      availableModels: this.#modelRegistry.getAvailable().map(modelRef),
      availableThinkingLevels: this.#session.getAvailableThinkingLevels(),
      fastMode: this.#fastMode.state(model),
      sessionUsage: {
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cacheReadTokens: stats.tokens.cacheRead,
        cacheWriteTokens: stats.tokens.cacheWrite,
        totalTokens: stats.tokens.total,
        costUsd: stats.cost,
      },
      ...(subscriptionUsage ? { subscriptionUsage } : {}),
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

  async setFastMode(enabled: boolean) {
    this.#fastMode.setEnabled(enabled);
    return this.#fastMode.state(this.#session.model);
  }

  async compact(): Promise<{ summary: string }> {
    return compactWithOverflowFallback(this.#session);
  }

  async navigateTree(runtimeEntryId: string): Promise<{ editorText?: string }> {
    const result = await this.#session.navigateTree(runtimeEntryId);
    if (result.cancelled) throw new Error("Pi cancelled tree navigation");
    return result.editorText === undefined
      ? {}
      : { editorText: result.editorText };
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

  #captureMessageRuntimeRef(ev: AgentSessionEvent): void {
    if (ev.type !== "message_end") return;
    const messageId =
      ev.message.role === "user"
        ? this.#pendingUserMessageIds.shift()
        : ev.message.role === "assistant"
          ? (this.#map.messageId ?? undefined)
          : undefined;
    if (!messageId) return;

    // Pi persists ordinary message entries synchronously after notifying
    // listeners. The microtask sees that exact in-memory message object, so
    // this remains identity-based rather than guessing from matching text.
    queueMicrotask(() => {
      if (this.state === "disposed") return;
      const entry = this.#session.sessionManager
        .getEntries()
        .findLast(
          (candidate) =>
            candidate.type === "message" && candidate.message === ev.message,
        );
      if (!entry) return;
      this.#queue.push({
        type: "message-runtime-ref",
        messageId,
        runtimeEntryId: entry.id,
      });
      this.#wakeUp();
    });
  }

  #forgetPendingUserMessage(messageId: string): void {
    const index = this.#pendingUserMessageIds.indexOf(messageId);
    if (index >= 0) this.#pendingUserMessageIds.splice(index, 1);
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

export async function compactWithOverflowFallback(
  session: AgentSession,
): Promise<{ summary: string }> {
  try {
    return { summary: (await session.compact()).summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/(?:exceeds?|exceeded).*context window|context window.*(?:exceeds?|exceeded)|maximum context length|too many tokens/i.test(
        message,
      )
    ) {
      throw error;
    }
    const entries = session.sessionManager.buildContextEntries();
    const cutPoint = findCutPoint(
      entries,
      0,
      entries.length,
      session.settingsManager.getCompactionSettings().keepRecentTokens,
    );
    const firstKeptEntry = entries[cutPoint.firstKeptEntryIndex];
    if (!firstKeptEntry || cutPoint.firstKeptEntryIndex === 0) throw error;
    const tokensBefore = session.sessionManager
      .buildSessionContext()
      .messages.reduce((total, item) => total + estimateTokens(item), 0);
    session.sessionManager.appendCompaction(
      OVERFLOW_COMPACTION_SUMMARY,
      firstKeptEntry.id,
      tokensBefore,
      undefined,
      true,
    );
    await session.reload();
    return { summary: OVERFLOW_COMPACTION_SUMMARY };
  }
}

function modelRef(model: Model<Api>): ModelRef {
  return { provider: model.provider, id: model.id };
}

function piImages(input: RuntimeInput) {
  return input.images.map((image) => ({
    type: "image" as const,
    data: Buffer.from(image.data).toString("base64"),
    mimeType: image.mimeType,
  }));
}

function requireForkedSession(source: SessionManager, entryId: string): string {
  const sessionFile = source.createBranchedSession(entryId);
  if (!sessionFile) throw new Error("Pi did not persist the forked session");
  return sessionFile;
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
