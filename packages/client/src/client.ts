// @agena/client — typed SDK over the §5 wire contract. M1 scope: hello/welcome,
// subscribe/prompt with requestId correlation, cursor-tracked auto-reconnect.
import {
  type AgenaEvent,
  type AgenaFrame,
  type ApprovalResponse,
  COMMAND_ACK_TIMEOUT_MS,
  type CommandName,
  type CompactAck,
  type CompactTranscriptQuery,
  type CompactTranscriptResponse,
  type ContentBlock,
  type CreateDerivedSessionRequest,
  type CreatePairingResponse,
  type CreateSessionRequest,
  compactAckSchema,
  type DeleteProjectResponse,
  type DiagnosticsResponse,
  diagnosticsResponseSchema,
  type EmptyAck,
  emptyAckSchema,
  type FileEntry,
  type FileUploadResponse,
  type ImportMcpRequest,
  type ImportMcpResponse,
  type ImportSessionRequest,
  type ImportSessionResponse,
  type ImportSessionsRequest,
  type ImportSessionsResponse,
  type ImportSkillRequest,
  type ImportSkillResponse,
  type ImportsResponse,
  type InFlightSnapshot,
  type ListPluginsResponse,
  type ListProvidersResponse,
  type ListSessionsQuery,
  type McpSummary,
  type ModelRef,
  type NavigateSessionRequest,
  type NavigateSessionResponse,
  type PendingApprovalSummary,
  PING_INTERVAL_MS,
  type PluginResponse,
  PROTOCOL_VERSION,
  type ProjectResponse,
  type PromptAck,
  type ProviderAuthResponse,
  type ProviderOAuthStatusResponse,
  type PtySummary,
  promptAckSchema,
  type RespondProviderOAuthRequest,
  type RespondToApprovalAck,
  type RuntimeInfoAck,
  respondToApprovalAckSchema,
  runtimeInfoAckSchema,
  type SearchHit,
  type SearchQuery,
  type SessionStatus,
  type SessionSummary,
  type SetFastModeAck,
  type SetModelAck,
  type SetThinkingLevelAck,
  type SkillSummary,
  type SnapshotSummary,
  type StartMcpOAuthResponse,
  type StartProviderOAuthResponse,
  type SubscribeAck,
  setFastModeAckSchema,
  setModelAckSchema,
  setThinkingLevelAckSchema,
  subscribeAckSchema,
  type ThinkingLevel,
  type ToolCallDetail,
  type UserMessageAnchor,
  uploadImageResponseSchema,
  VISIBLE_BROWSER_CAPABILITY,
  type VisibleBrowserAction,
  type VisibleBrowserResult,
  type WelcomeEnvelope,
  type WireEnvelope,
  WS_PATH,
  WS_SUBPROTOCOL,
  wireEnvelopeSchema,
} from "@agena/protocol";
import { ulid } from "ulid";

export {
  type AgenaLocalConfig,
  type AgenaLocalCredentials,
  type AgenaLocalProfile,
  DEFAULT_AGENA_URL,
  defaultAgenaConfigDir,
  loadOrCreateClientId,
  type ResolvedLocalClientConfig,
  type ResolveLocalClientOptions,
  readAgenaLocalConfig,
  readAgenaLocalCredentials,
  resolveLocalClientConfig,
  writeAgenaLocalConfig,
  writeAgenaLocalCredentials,
} from "./local-config.ts";
// §9.5 PTY WS helpers shared by `agena shell` and the TUI's embedded split.
export { isTerminalPtyClose, parsePtyExit, ptyDataToBytes } from "./pty.ts";
// Client-minted ULIDs per §4.3; re-exported for the CLI's persisted clientId.
export { ulid };

// ---- errors ---------------------------------------------------------------

/** Wire ErrorCodes plus client-local "CONNECTION_FAILED" / "DISCONNECTED". */
export class AgenaClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | undefined;
  constructor(
    code: string,
    message: string,
    retryable = false,
    status?: number,
  ) {
    super(message);
    this.name = "AgenaClientError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

// ---- socket ----------------------------------------------------------------

/** Structural subset of WebSocket satisfied by Node 22 / Bun natives and test fakes. */
export type WsLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type PtyWsLike = {
  binaryType?: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

type WsInit = { protocols?: string[]; headers?: Record<string, string> };
// Node 22 (undici) and Bun both accept { protocols, headers } at runtime;
// @types/node still types the second arg as string | string[].
const NativeWebSocket = WebSocket as unknown as new (
  url: string,
  init?: WsInit,
) => WsLike;

// ---- client ----------------------------------------------------------------

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export type AgenaClientOptions = {
  url: string; // daemon base URL, e.g. http://127.0.0.1:7777
  token: string;
  clientId?: string; // stable ULID per installed client (P3)
  clientName?: string;
  clientVersion?: string;
  platform?: string;
  socketAuth?: "header" | "ticket";
  createSocket?: (url: string, init: WsInit) => WsLike; // test seam
  createPtySocket?: (url: string, init: WsInit) => PtyWsLike;
  fetch?: typeof fetch;
};

export type OpenPtyOptions = {
  cols: number;
  rows: number;
  cwd?: string;
  sessionId?: string;
  command?: string;
  args?: string[];
};

export type CreateSessionOptions = Partial<CreateSessionRequest>;
export type ListSessionsOptions = ListSessionsQuery;
export type SearchOptions = Partial<Omit<SearchQuery, "q">>;
export type ListFilesOptions = { path?: string };
export type UploadFilesOptions = { path: string; format?: "tar" };
export type ReadEventsOptions = { fromSeq?: number; limit?: number };
export type ReadCompactTranscriptOptions = Partial<CompactTranscriptQuery>;
export type ReadEventsPage = {
  events: AgenaEvent[];
  nextFromSeq: number | null;
};

export type PtyAttachment = {
  ptyId: string;
  wsPath: string;
  socket: PtyWsLike;
};

type Pending = {
  requestId: string;
  name: CommandName;
  payload: unknown;
  resolve: (v: unknown) => void;
  reject: (e: AgenaClientError) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Sub = { cursor: number; live: boolean };

const BACKOFF_CAP_MS = 10_000;
const DEAD_SILENCE_MS = PING_INTERVAL_MS * 3; // 45 s without any traffic -> dead

export class AgenaClient {
  onEvent: ((e: AgenaEvent, replayed: boolean) => void) | undefined;
  onFrame: ((f: AgenaFrame) => void) | undefined;
  onSnapshot: ((snapshot: InFlightSnapshot) => void) | undefined;
  onStatus: ((state: ConnectionState, detail?: string) => void) | undefined;
  onSync: ((sessionId: string, upToSeq: number) => void) | undefined;
  onVisibleBrowserRequest:
    | ((action: VisibleBrowserAction) => Promise<VisibleBrowserResult>)
    | undefined;
  /** Daemon no longer knows the session (M1 in-memory store lost on restart, §5.8/P8). */
  onSessionLost: ((sessionId: string) => void) | undefined;

  readonly clientId: string;
  private readonly httpBase: string;
  private readonly wsUrl: string;
  private readonly token: string;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly platform: string;
  private readonly socketAuth: "header" | "ticket";
  private readonly createSocket: (url: string, init: WsInit) => WsLike;
  private readonly createPtySocket: (url: string, init: WsInit) => PtyWsLike;
  private readonly fetchImpl: typeof fetch;

  private sock: WsLike | null = null;
  private ready = false; // welcome received on the current socket
  private everConnected = false;
  private userClosed = false;
  private attempt = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly subs = new Map<string, Sub>();
  private welcomeWait: {
    resolve: (w: WelcomeEnvelope) => void;
    reject: (e: Error) => void;
  } | null = null;
  private deadTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: AgenaClientOptions) {
    const base = opts.url.replace(/\/+$/, "");
    this.httpBase = base.replace(/^ws(s?):/, "http$1:");
    this.wsUrl = this.httpBase.replace(/^http(s?):/, "ws$1:") + WS_PATH;
    this.token = opts.token;
    this.clientId = opts.clientId ?? ulid();
    this.clientName = opts.clientName ?? "agena";
    this.clientVersion = opts.clientVersion ?? "0.0.0";
    this.platform = opts.platform ?? process.platform;
    this.socketAuth = opts.socketAuth ?? "header";
    this.createSocket =
      opts.createSocket ?? ((url, init) => new NativeWebSocket(url, init));
    this.createPtySocket =
      opts.createPtySocket ??
      ((url, init) => new NativeWebSocket(url, init) as PtyWsLike);
    this.fetchImpl = (opts.fetch ?? fetch).bind(globalThis);
  }

  /** Open the WS, send hello, await welcome (incl. protocol-version check). */
  connect(): Promise<WelcomeEnvelope> {
    this.userClosed = false;
    return this.open();
  }

  async close(): Promise<void> {
    this.userClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.sock?.close(1000, "client close");
    this.sock = null;
    this.onStatus?.("closed");
  }

  /** Track the session cursor and subscribe; replay is exclusive of fromSeq. */
  async subscribe(sessionId: string, fromSeq: number): Promise<SubscribeAck> {
    this.subs.set(sessionId, { cursor: fromSeq, live: false });
    return this.sendSubscribe(sessionId, fromSeq);
  }

  async prompt(
    sessionId: string,
    content: string | ContentBlock[],
  ): Promise<PromptAck> {
    const res = await this.command("prompt", {
      sessionId,
      content:
        typeof content === "string"
          ? [{ type: "text", text: content }]
          : content,
    });
    return promptAckSchema.parse(res);
  }

  async steer(
    sessionId: string,
    content: string | ContentBlock[],
  ): Promise<PromptAck> {
    const res = await this.command("steer", {
      sessionId,
      content:
        typeof content === "string"
          ? [{ type: "text", text: content }]
          : content,
    });
    return promptAckSchema.parse(res);
  }

  async followUp(
    sessionId: string,
    content: string | ContentBlock[],
  ): Promise<PromptAck> {
    const res = await this.command("followUp", {
      sessionId,
      content:
        typeof content === "string"
          ? [{ type: "text", text: content }]
          : content,
    });
    return promptAckSchema.parse(res);
  }

  async abort(sessionId: string, reason?: string): Promise<EmptyAck> {
    const res = await this.command("abort", { sessionId, reason });
    return emptyAckSchema.parse(res);
  }

  async runtimeInfo(sessionId: string): Promise<RuntimeInfoAck> {
    const res = await this.command("runtimeInfo", { sessionId });
    return runtimeInfoAckSchema.parse(res);
  }

  async setModel(sessionId: string, model: ModelRef): Promise<SetModelAck> {
    const res = await this.command("setModel", { sessionId, model });
    return setModelAckSchema.parse(res);
  }

  async setThinkingLevel(
    sessionId: string,
    thinkingLevel: ThinkingLevel,
  ): Promise<SetThinkingLevelAck> {
    const res = await this.command("setThinkingLevel", {
      sessionId,
      thinkingLevel,
    });
    return setThinkingLevelAckSchema.parse(res);
  }

  async setFastMode(
    sessionId: string,
    enabled: boolean,
  ): Promise<SetFastModeAck> {
    const res = await this.command("setFastMode", { sessionId, enabled });
    return setFastModeAckSchema.parse(res);
  }

  async respondToApproval(
    sessionId: string,
    approvalId: string,
    response: ApprovalResponse,
  ): Promise<RespondToApprovalAck> {
    const res = await this.command("respondToApproval", {
      sessionId,
      approvalId,
      response,
    });
    return respondToApprovalAckSchema.parse(res);
  }

  async compact(sessionId: string, instructions?: string): Promise<CompactAck> {
    const res = await this.command("compact", { sessionId, instructions });
    return compactAckSchema.parse(res);
  }

  /** Send a cmd envelope; resolves on ack, rejects on error or 30 s timeout. */
  command(name: CommandName, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.sock || !this.ready) {
        reject(new AgenaClientError("DISCONNECTED", "not connected", true));
        return;
      }
      const requestId = ulid();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new AgenaClientError(
            "TIMEOUT",
            `${name}: no ack within ${COMMAND_ACK_TIMEOUT_MS} ms`,
            true,
          ),
        );
      }, COMMAND_ACK_TIMEOUT_MS);
      this.pending.set(requestId, {
        requestId,
        name,
        payload,
        resolve,
        reject,
        timer,
      });
      this.transmit(requestId, name, payload);
    });
  }

  // ---- HTTP ---------------------------------------------------------------

  /** POST /v1/sessions -> new session id. */
  async createSession(input?: string | CreateSessionOptions): Promise<string> {
    const request =
      typeof input === "string"
        ? input
          ? { title: input }
          : {}
        : (input ?? {});
    const body = await this.fetchJson("POST", "/v1/sessions", request);
    return (body as { sessionId: string }).sessionId;
  }

  /** POST /v1/sessions/:id/derived -> immutable fork or clone session id. */
  async forkSession(
    sourceSessionId: string,
    sourceMessageId: string | undefined,
    mode: "fork" | "clone",
  ): Promise<string> {
    const request: CreateDerivedSessionRequest = {
      mode,
      ...(sourceMessageId ? { sourceMessageId } : {}),
    };
    const body = await this.fetchJson(
      "POST",
      `/v1/sessions/${encodeURIComponent(sourceSessionId)}/derived`,
      request,
    );
    return (body as { sessionId: string }).sessionId;
  }

  /** Move the active Pi leaf within this session and return its editable prompt. */
  async navigateSession(
    sessionId: string,
    sourceMessageId: string,
  ): Promise<string> {
    const request: NavigateSessionRequest = { sourceMessageId };
    const body = await this.fetchJson(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/navigate`,
      request,
    );
    return (body as NavigateSessionResponse).editorText;
  }

  /** GET /v1/sessions -> session ids, newest first (ULIDs sort by time). */
  async listSessions(filters: ListSessionsOptions = {}): Promise<string[]> {
    return (await this.listSessionSummaries(filters)).map((s) => s.sessionId);
  }

  async listSessionSummaries(
    filters: ListSessionsOptions = {},
  ): Promise<SessionSummary[]> {
    const body = await this.fetchJson("GET", sessionsPath(filters));
    return (body as { sessions: SessionSummary[] }).sessions.sort((a, b) =>
      b.sessionId.localeCompare(a.sessionId),
    );
  }

  async updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
  ): Promise<void> {
    await this.fetchJson("PATCH", `/v1/sessions/${sessionId}`, { status });
  }

  async rebuild(sessionId?: string): Promise<unknown> {
    return this.fetchJson("POST", "/v1/admin/rebuild", { sessionId });
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const body = await this.fetchJson("GET", searchPath(query, opts));
    return (body as { hits: SearchHit[] }).hits;
  }

  async listApprovals(): Promise<PendingApprovalSummary[]> {
    const body = await this.fetchJson("GET", "/v1/approvals?pending=1");
    return (body as { approvals: PendingApprovalSummary[] }).approvals;
  }

  async readEvents(
    sessionId: string,
    opts: ReadEventsOptions = {},
  ): Promise<ReadEventsPage> {
    const query = new URLSearchParams();
    if (opts.fromSeq !== undefined) query.set("fromSeq", String(opts.fromSeq));
    if (opts.limit !== undefined) query.set("limit", String(opts.limit));
    const qs = query.toString();
    return this.fetchJson(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/events${qs ? `?${qs}` : ""}`,
    ) as Promise<ReadEventsPage>;
  }

  async listUserMessages(sessionId: string): Promise<UserMessageAnchor[]> {
    const body = await this.fetchJson(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/user-messages`,
    );
    return (body as { messages: UserMessageAnchor[] }).messages;
  }

  async readCompactTranscript(
    sessionId: string,
    opts: ReadCompactTranscriptOptions = {},
  ): Promise<CompactTranscriptResponse> {
    const query = new URLSearchParams();
    if (opts.limitTurns !== undefined) {
      query.set("limitTurns", String(opts.limitTurns));
    }
    if (opts.beforeMessageId) {
      query.set("beforeMessageId", opts.beforeMessageId);
    }
    if (opts.aroundMessageId) {
      query.set("aroundMessageId", opts.aroundMessageId);
    }
    const qs = query.toString();
    return this.fetchJson(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/transcript${qs ? `?${qs}` : ""}`,
    ) as Promise<CompactTranscriptResponse>;
  }

  async getToolCallDetail(
    sessionId: string,
    toolCallId: string,
  ): Promise<ToolCallDetail> {
    const body = await this.fetchJson(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/tool-calls/${encodeURIComponent(toolCallId)}`,
    );
    return (body as { toolCall: ToolCallDetail }).toolCall;
  }

  async listFiles(opts: ListFilesOptions = {}): Promise<FileEntry[]> {
    const query = new URLSearchParams();
    if (opts.path) query.set("path", opts.path);
    const qs = query.toString();
    const body = await this.fetchJson("GET", `/v1/files${qs ? `?${qs}` : ""}`);
    return (body as { entries: FileEntry[] }).entries;
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.fetchBytes("GET", filesContentPath(path));
  }

  async uploadImage(bytes: Uint8Array, mimeType: string) {
    const body = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return uploadImageResponseSchema.parse(
      await this.fetchBody("POST", "/v1/images", body, mimeType),
    ).ref;
  }

  async readBlob(hash: string): Promise<Uint8Array> {
    const digest = hash.startsWith("sha256:") ? hash.slice(7) : hash;
    return this.fetchBytes("GET", `/v1/blobs/${encodeURIComponent(digest)}`);
  }

  async archiveFiles(path: string): Promise<Uint8Array> {
    return this.fetchBytes("GET", filesArchivePath(path));
  }

  async createProject(
    name: string,
    opts: { reuseExisting?: boolean } = {},
  ): Promise<ProjectResponse> {
    return this.fetchJson("POST", "/v1/projects", {
      name,
      ...opts,
    }) as Promise<ProjectResponse>;
  }

  /** Full teardown: db rows, workspace files, pi sessions, snapshots. */
  async deleteProject(projectId: string): Promise<DeleteProjectResponse> {
    return this.fetchJson(
      "DELETE",
      `/v1/projects/${encodeURIComponent(projectId)}`,
    ) as Promise<DeleteProjectResponse>;
  }

  async importSession(
    body: ImportSessionRequest,
  ): Promise<ImportSessionResponse> {
    return this.fetchJson(
      "POST",
      "/v1/imports/session",
      body,
    ) as Promise<ImportSessionResponse>;
  }

  async importSessions(
    body: ImportSessionsRequest,
  ): Promise<ImportSessionsResponse> {
    try {
      return (await this.fetchJson(
        "POST",
        "/v1/imports/sessions",
        body,
      )) as ImportSessionsResponse;
    } catch (err) {
      if (!(err instanceof AgenaClientError) || err.status !== 404) throw err;
    }
    const sessions: ImportSessionsResponse["sessions"] = [];
    for (const input of body.sessions) {
      try {
        sessions.push({
          sourcePath: input.sourceFingerprint.sourcePath,
          result: await this.importSession(input),
        });
      } catch (err) {
        sessions.push({
          sourcePath: input.sourceFingerprint.sourcePath,
          error: err instanceof Error ? err.message : "session import failed",
        });
      }
    }
    return { sessions };
  }

  /** Returns the {@link ImportsResponse} envelope verbatim — the bridge passes it through. */
  async listImports(machineId?: string): Promise<ImportsResponse> {
    const qs = machineId ? `?machineId=${encodeURIComponent(machineId)}` : "";
    return this.fetchJson(
      "GET",
      `/v1/imports${qs}`,
    ) as Promise<ImportsResponse>;
  }

  async importMcp(body: ImportMcpRequest): Promise<ImportMcpResponse> {
    return this.fetchJson(
      "POST",
      "/v1/mcps/import",
      body,
    ) as Promise<ImportMcpResponse>;
  }

  async listMcps(): Promise<McpSummary[]> {
    const body = await this.fetchJson("GET", "/v1/mcps");
    return (body as { mcps: McpSummary[] }).mcps;
  }

  async startMcpOAuth(id: string): Promise<StartMcpOAuthResponse> {
    return this.fetchJson(
      "POST",
      `/v1/mcps/${encodeURIComponent(id)}/oauth/start`,
      {},
    ) as Promise<StartMcpOAuthResponse>;
  }

  async completeMcpOAuth(
    id: string,
    body: { redirectUrl: string },
  ): Promise<{ mcp: McpSummary }> {
    return this.fetchJson(
      "POST",
      `/v1/mcps/${encodeURIComponent(id)}/oauth/complete`,
      body,
    ) as Promise<{ mcp: McpSummary }>;
  }

  async listProviders(): Promise<ListProvidersResponse> {
    return this.fetchJson(
      "GET",
      "/v1/providers",
    ) as Promise<ListProvidersResponse>;
  }

  async listPlugins(): Promise<ListPluginsResponse> {
    return this.fetchJson("GET", "/v1/plugins") as Promise<ListPluginsResponse>;
  }

  async installPlugin(id: string): Promise<PluginResponse> {
    return this.fetchJson(
      "POST",
      `/v1/plugins/${encodeURIComponent(id)}/install`,
      {},
    ) as Promise<PluginResponse>;
  }

  async updatePlugin(id: string): Promise<PluginResponse> {
    return this.fetchJson(
      "POST",
      `/v1/plugins/${encodeURIComponent(id)}/update`,
      {},
    ) as Promise<PluginResponse>;
  }

  async setPluginEnabled(
    id: string,
    enabled: boolean,
  ): Promise<PluginResponse> {
    return this.fetchJson("PATCH", `/v1/plugins/${encodeURIComponent(id)}`, {
      enabled,
    }) as Promise<PluginResponse>;
  }

  async removePlugin(id: string): Promise<PluginResponse> {
    return this.fetchJson(
      "DELETE",
      `/v1/plugins/${encodeURIComponent(id)}`,
    ) as Promise<PluginResponse>;
  }

  async saveProviderApiKey(
    id: string,
    body: { apiKey: string; env?: Record<string, string> },
  ): Promise<ProviderAuthResponse> {
    return this.fetchJson(
      "PUT",
      `/v1/providers/${encodeURIComponent(id)}/api-key`,
      body,
    ) as Promise<ProviderAuthResponse>;
  }

  async removeProviderAuth(id: string): Promise<ProviderAuthResponse> {
    return this.fetchJson(
      "DELETE",
      `/v1/providers/${encodeURIComponent(id)}/auth`,
    ) as Promise<ProviderAuthResponse>;
  }

  async startProviderOAuth(id: string): Promise<StartProviderOAuthResponse> {
    return this.fetchJson(
      "POST",
      `/v1/providers/${encodeURIComponent(id)}/oauth/start`,
      {},
    ) as Promise<StartProviderOAuthResponse>;
  }

  async providerOAuthStatus(
    flowId: string,
  ): Promise<ProviderOAuthStatusResponse> {
    return this.fetchJson(
      "GET",
      `/v1/providers/oauth/${encodeURIComponent(flowId)}`,
    ) as Promise<ProviderOAuthStatusResponse>;
  }

  async respondProviderOAuth(
    flowId: string,
    body: RespondProviderOAuthRequest,
  ): Promise<ProviderOAuthStatusResponse> {
    return this.fetchJson(
      "POST",
      `/v1/providers/oauth/${encodeURIComponent(flowId)}/respond`,
      body,
    ) as Promise<ProviderOAuthStatusResponse>;
  }

  async importSkill(body: ImportSkillRequest): Promise<ImportSkillResponse> {
    return this.fetchJson(
      "POST",
      "/v1/skills/import",
      body,
    ) as Promise<ImportSkillResponse>;
  }

  async listSkills(): Promise<SkillSummary[]> {
    const body = await this.fetchJson("GET", "/v1/skills");
    return (body as { skills: SkillSummary[] }).skills;
  }

  async checkSkillUpdates(): Promise<SkillSummary[]> {
    const body = await this.fetchJson("POST", "/v1/skills/check-updates", {});
    return (body as { skills: SkillSummary[] }).skills;
  }

  async updateSkill(id: string): Promise<{ skill: SkillSummary }> {
    return this.fetchJson(
      "POST",
      `/v1/skills/${encodeURIComponent(id)}/update`,
      {},
    ) as Promise<{ skill: SkillSummary }>;
  }

  async uploadFiles(
    opts: UploadFilesOptions,
    body: BodyInit,
  ): Promise<FileUploadResponse> {
    return this.fetchBody(
      "POST",
      filesUploadPath(opts.path, opts.format ?? "tar"),
      body,
      "application/x-tar",
    ) as Promise<FileUploadResponse>;
  }

  async listSnapshots(): Promise<SnapshotSummary[]> {
    const body = await this.fetchJson("GET", "/v1/snapshots");
    return (body as { snapshots: SnapshotSummary[] }).snapshots;
  }

  async createSnapshot(
    input: { name?: string; sessionId?: string } = {},
  ): Promise<SnapshotSummary> {
    const body = await this.fetchJson("POST", "/v1/snapshots", input);
    return (body as { snapshot: SnapshotSummary }).snapshot;
  }

  async restoreSnapshot(
    snapshotId: string,
    input: { sessionId?: string } = {},
  ): Promise<{ snapshotId: string; safetySnapshotId: string }> {
    return this.fetchJson(
      "POST",
      `/v1/snapshots/${snapshotId}/restore`,
      input,
    ) as Promise<{ snapshotId: string; safetySnapshotId: string }>;
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    await this.fetchJson("DELETE", `/v1/snapshots/${snapshotId}`);
  }

  async diagnostics(): Promise<DiagnosticsResponse> {
    return diagnosticsResponseSchema.parse(
      await this.fetchJson("GET", "/v1/diagnostics"),
    );
  }

  async createPairing(daemonUrl: string): Promise<CreatePairingResponse> {
    return this.fetchJson("POST", "/v1/pairings", {
      daemonUrl,
    }) as Promise<CreatePairingResponse>;
  }

  async openPty(opts: OpenPtyOptions): Promise<PtyAttachment> {
    const body = await this.fetchJson("POST", "/v1/ptys", opts);
    const ptyId = stringField(body, "ptyId");
    const wsPath = stringField(body, "wsPath");
    return { ptyId, wsPath, socket: await this.connectPty(wsPath) };
  }

  async listPtys(): Promise<PtySummary[]> {
    const body = await this.fetchJson("GET", "/v1/ptys");
    return (body as { ptys: PtySummary[] }).ptys;
  }

  async killPty(ptyId: string): Promise<void> {
    await this.fetchJson("DELETE", `/v1/ptys/${encodeURIComponent(ptyId)}`);
  }

  async connectPty(wsPath: string): Promise<PtyWsLike> {
    const socket = this.createPtySocket(await this.authenticatedWsUrl(wsPath), {
      headers:
        this.socketAuth === "header"
          ? { authorization: `Bearer ${this.token}` }
          : {},
    });
    socket.binaryType = "arraybuffer";
    return socket;
  }

  private async fetchJson(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await this.fetchRaw(method, path, body);
    if (res.status === 204) return {};
    return res.json();
  }

  private async fetchBytes(method: string, path: string): Promise<Uint8Array> {
    const res = await this.fetchRaw(method, path);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async fetchBody(
    method: string,
    path: string,
    body: BodyInit,
    contentType: string,
  ): Promise<unknown> {
    const res = await this.fetchRaw(method, path, body, contentType);
    if (res.status === 204) return {};
    return res.json();
  }

  private async fetchRaw(
    method: string,
    path: string,
    body?: unknown,
    contentType = "application/json",
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.httpBase + path, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": contentType }),
        },
        ...(body === undefined
          ? {}
          : contentType === "application/json"
            ? { body: JSON.stringify(body) }
            : { body: body as BodyInit, duplex: "half" }),
      });
    } catch (err) {
      throw new AgenaClientError(
        "CONNECTION_FAILED",
        `cannot reach daemon at ${this.httpBase}: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
    if (!res.ok) {
      const fallback = res.status === 401 ? "UNAUTHORIZED" : "INTERNAL";
      const parsed = (await res.json().catch(() => null)) as {
        code?: string;
        message?: string;
        retryable?: boolean;
      } | null;
      throw new AgenaClientError(
        parsed?.code ?? fallback,
        parsed?.message ?? `${method} ${path} -> HTTP ${res.status}`,
        parsed?.retryable ?? false,
        res.status,
      );
    }
    return res;
  }

  private ptyWsUrl(wsPath: string): string {
    const url = new URL(wsPath, this.httpBase).toString();
    return url.replace(/^http(s?):/, "ws$1:");
  }

  private async authenticatedWsUrl(path: string): Promise<string> {
    const url = path === WS_PATH ? this.wsUrl : this.ptyWsUrl(path);
    if (this.socketAuth === "header") return url;
    const body = (await this.fetchJson("POST", "/v1/ws-tickets", {
      path,
    })) as { ticket: string };
    const ticketed = new URL(url);
    ticketed.searchParams.set("ticket", body.ticket);
    return ticketed.toString();
  }

  // ---- connection machinery -------------------------------------------------

  private open(): Promise<WelcomeEnvelope> {
    this.onStatus?.(
      this.everConnected ? "reconnecting" : "connecting",
      `attempt ${this.attempt + 1}`,
    );
    return this.socketAuth === "ticket"
      ? this.authenticatedWsUrl(WS_PATH).then((url) => this.openSocket(url))
      : this.openSocket(this.wsUrl);
  }

  private openSocket(socketUrl: string): Promise<WelcomeEnvelope> {
    return new Promise((resolve, reject) => {
      this.welcomeWait = { resolve, reject };
      const sock = this.createSocket(socketUrl, {
        protocols: [WS_SUBPROTOCOL],
        headers:
          this.socketAuth === "header"
            ? { authorization: `Bearer ${this.token}` }
            : {},
      });
      this.sock = sock;
      this.ready = false;
      const current = () => this.sock === sock;
      sock.onopen = () => {
        if (!current()) return;
        sock.send(
          JSON.stringify({
            kind: "hello",
            protocolVersion: PROTOCOL_VERSION,
            client: {
              name: this.clientName,
              version: this.clientVersion,
              platform: this.platform,
              ...(this.onVisibleBrowserRequest
                ? { capabilities: [VISIBLE_BROWSER_CAPABILITY] }
                : {}),
            },
            clientId: this.clientId,
          }),
        );
      };
      sock.onmessage = (ev) => {
        if (current()) this.handleMessage(String(ev.data));
      };
      sock.onerror = () => {
        if (current()) this.handleClose(1006, "socket error");
      };
      sock.onclose = (ev) => {
        if (current()) this.handleClose(ev.code, ev.reason);
      };
    });
  }

  private handleMessage(raw: string): void {
    this.bumpDeadTimer();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return; // malformed input never crashes the client (§11.7)
    }
    const parsed = wireEnvelopeSchema.safeParse(json);
    if (!parsed.success) return;
    const env: WireEnvelope = parsed.data;
    switch (env.kind) {
      case "welcome":
        this.handleWelcome(env);
        return;
      case "ack": {
        const p = this.pending.get(env.requestId);
        if (!p) return;
        this.pending.delete(env.requestId);
        clearTimeout(p.timer);
        p.resolve(env.result);
        return;
      }
      case "error": {
        const err = new AgenaClientError(
          env.error.code,
          env.error.message,
          env.error.retryable,
        );
        const p = env.requestId ? this.pending.get(env.requestId) : undefined;
        if (env.requestId && p) {
          this.pending.delete(env.requestId);
          clearTimeout(p.timer);
          p.reject(err);
        } else if (this.welcomeWait) {
          // connection-level error before welcome (e.g. PROTOCOL_MISMATCH + close 4400)
          const w = this.welcomeWait;
          this.welcomeWait = null;
          if (err.code === "PROTOCOL_MISMATCH") this.userClosed = true; // do not retry
          w.reject(err);
        }
        return;
      }
      case "event":
        this.handleEvent(env.event, env.replayed);
        return;
      case "frame":
        this.handleFrame(env.frame);
        return;
      case "sync": {
        const sub = this.subs.get(env.sessionId);
        if (sub) sub.live = true;
        this.onSync?.(env.sessionId, env.upToSeq);
        return;
      }
      case "snapshot":
        this.onSnapshot?.(env.snapshot);
        return;
      case "ping":
        this.sock?.send(JSON.stringify({ kind: "pong", ts: env.ts }));
        return;
      case "visibleBrowserRequest":
        void this.handleVisibleBrowserRequest(env.requestId, env.action);
        return;
      default: // hello/cmd/pong/... are not expected daemon->client; ignore
        return;
    }
  }

  private async handleVisibleBrowserRequest(
    requestId: string,
    action: VisibleBrowserAction,
  ): Promise<void> {
    try {
      if (!this.onVisibleBrowserRequest) {
        throw new AgenaClientError(
          "RUNTIME_UNAVAILABLE",
          "visible browser handler is not registered",
          true,
        );
      }
      const result = await this.onVisibleBrowserRequest(action);
      this.sock?.send(
        JSON.stringify({ kind: "visibleBrowserResponse", requestId, result }),
      );
    } catch (err) {
      const code = err instanceof AgenaClientError ? err.code : "INTERNAL";
      const retryable = err instanceof AgenaClientError ? err.retryable : false;
      const message = err instanceof Error ? err.message : String(err);
      this.sock?.send(
        JSON.stringify({
          kind: "visibleBrowserResponse",
          requestId,
          error: { code, message, retryable },
        }),
      );
    }
  }

  private handleWelcome(welcome: WelcomeEnvelope): void {
    // ponytail: exact-match check — both sides ship integer 1 in v1; widen to the
    // MIN_SUPPORTED range rule when a second protocol version exists (§5.1)
    if (welcome.protocolVersion !== PROTOCOL_VERSION) {
      const w = this.welcomeWait;
      this.welcomeWait = null;
      this.userClosed = true; // reconnecting cannot fix a version mismatch
      this.sock?.close(1000, "protocol mismatch");
      w?.reject(
        new AgenaClientError(
          "PROTOCOL_MISMATCH",
          `daemon speaks protocol v${welcome.protocolVersion}, this client v${PROTOCOL_VERSION} — upgrade the older side`,
        ),
      );
      return;
    }
    this.ready = true;
    this.everConnected = true;
    this.attempt = 0;
    this.onStatus?.("connected");
    const w = this.welcomeWait;
    this.welcomeWait = null;
    w?.resolve(welcome);
    const pending = [...this.pending.values()];
    const pendingSubSessions = new Set(
      pending.flatMap((p) =>
        p.name === "subscribe" ? [sessionIdFrom(p.payload)] : [],
      ),
    );
    // re-subscribe every tracked session from its cursor (§5.8)
    for (const [sessionId, sub] of this.subs) {
      sub.live = false;
      if (!pendingSubSessions.has(sessionId)) {
        this.sendSubscribe(sessionId, sub.cursor).catch(() => {});
      }
    }
    for (const p of pending) this.transmit(p.requestId, p.name, p.payload);
  }

  private handleEvent(e: AgenaEvent, replayed: boolean): void {
    const sub = this.subs.get(e.sessionId);
    if (!sub) return;
    if (e.seq <= sub.cursor) return; // duplicate — apply is idempotent by seq
    if (e.seq > sub.cursor + 1) {
      // ponytail: gap heals via full reconnect (resubscribes from cursor); switch to
      // silent unsubscribe+resubscribe when the unsubscribe command lands (M2)
      this.sock?.close(1000, "seq gap");
      return;
    }
    sub.cursor = e.seq;
    this.onEvent?.(e, replayed);
  }

  private handleFrame(f: AgenaFrame): void {
    const sub = this.subs.get(f.sessionId);
    if (!sub?.live) return; // frames before sync are discarded (§5.8)
    if (f.afterSeq < sub.cursor) return; // stale frame — events are authoritative
    // ponytail: no SDK-side 40 ms coalescing — the TUI (only M1 consumer) throttles
    // redraws itself; add the per-target coalescer when a second consumer exists
    this.onFrame?.(f);
  }

  private async sendSubscribe(
    sessionId: string,
    fromSeq: number,
  ): Promise<SubscribeAck> {
    try {
      const res = await this.command("subscribe", { sessionId, fromSeq });
      return subscribeAckSchema.parse(res);
    } catch (err) {
      if (err instanceof AgenaClientError && err.code === "SESSION_NOT_FOUND") {
        this.subs.delete(sessionId); // prune dead cursor (§11.1) and surface honesty
        this.onSessionLost?.(sessionId);
      }
      throw err;
    }
  }

  private handleClose(code: number, reason: string): void {
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.deadTimer = null;
    this.sock = null;
    this.ready = false;
    const detail = reason || `close ${code}`;
    if (this.welcomeWait) {
      const w = this.welcomeWait;
      this.welcomeWait = null;
      w.reject(
        new AgenaClientError(
          "CONNECTION_FAILED",
          `connection closed before welcome (${detail})`,
          true,
        ),
      );
    }
    for (const sub of this.subs.values()) sub.live = false;
    if (this.userClosed || !this.everConnected) {
      this.onStatus?.("closed", detail);
      return;
    }
    this.attempt += 1;
    const base = code === 1001 ? 1000 : 250; // 1001 = daemon restarting -> slower backoff
    const delay =
      base +
      Math.random() * Math.min(BACKOFF_CAP_MS, base * 2 ** (this.attempt - 1));
    this.onStatus?.(
      "reconnecting",
      code === 1001
        ? `daemon restarting — retrying (attempt ${this.attempt})`
        : `attempt ${this.attempt}`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open().catch(() => {}); // failure re-enters handleClose and backs off again
    }, delay);
  }

  private bumpDeadTimer(): void {
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.deadTimer = setTimeout(
      () => this.sock?.close(1000, "silent peer"),
      DEAD_SILENCE_MS,
    );
  }

  private transmit(
    requestId: string,
    name: CommandName,
    payload: unknown,
  ): void {
    this.sock?.send(JSON.stringify({ kind: "cmd", requestId, name, payload }));
  }
}

function sessionIdFrom(payload: unknown): string {
  return payload && typeof payload === "object"
    ? String((payload as { sessionId?: unknown }).sessionId ?? "")
    : "";
}

function stringField(body: unknown, key: string): string {
  const value =
    body && typeof body === "object"
      ? (body as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new AgenaClientError(
      "INVALID_PAYLOAD",
      `POST /v1/ptys response missing ${key}`,
    );
  }
  return value;
}

function sessionsPath(filters: ListSessionsOptions): string {
  const query = new URLSearchParams();
  if (filters.projectId) query.set("projectId", filters.projectId);
  if (filters.scope) query.set("scope", filters.scope);
  if (filters.status) query.set("status", filters.status);
  if (filters.allProjects) query.set("allProjects", "1");
  if (filters.includeArchived) query.set("includeArchived", "1");
  const qs = query.toString();
  return qs ? `/v1/sessions?${qs}` : "/v1/sessions";
}

function searchPath(q: string, opts: SearchOptions): string {
  const query = new URLSearchParams({ q });
  if (opts.projectId) query.set("projectId", opts.projectId);
  if (opts.sessionId) query.set("sessionId", opts.sessionId);
  if (opts.allProjects) query.set("allProjects", "1");
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  return `/v1/search?${query}`;
}

function filesContentPath(path: string): string {
  const query = new URLSearchParams({ path });
  return `/v1/files/content?${query}`;
}

function filesArchivePath(path: string): string {
  const query = new URLSearchParams({ path });
  return `/v1/files/archive?${query}`;
}

function filesUploadPath(path: string, format: "tar"): string {
  const query = new URLSearchParams({ path, format });
  return `/v1/files/upload?${query}`;
}
