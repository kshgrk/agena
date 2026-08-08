// The mock AgenaBridge: a fully scripted fake daemon so `pnpm dev` runs the
// renderer standalone in a browser. Implements every method of the contract.
import type {
  AgenaEvent,
  ApprovalResponse,
  CompactAck,
  CreatePtyRequest,
  CreateSessionRequest,
  DiagnosticsResponse,
  EmptyAck,
  FileEntry,
  ImportLedgerEntry,
  ListSessionsQuery,
  ModelRef,
  PendingApprovalSummary,
  PluginSummary,
  PromptAck,
  ProviderAuthSummary,
  ProviderOAuthStatusResponse,
  PtySummary,
  RespondToApprovalAck,
  RuntimeInfoAck,
  SearchHit,
  SessionStatus,
  SessionSummary,
  SetFastModeAck,
  SetModelAck,
  SetThinkingLevelAck,
  SnapshotSummary,
  SubscribeAck,
  ThinkingLevel,
  UserMessageAnchor,
} from "@agena/protocol";
import {
  type AgenaBridge,
  type BridgeConnectionState,
  type BridgeError,
  type BrowserBounds,
  type BrowserNavAction,
  type BrowserOpenOptions,
  type BrowserState,
  type ConnectedInfo,
  EMPTY_PERSISTED,
  type HostFolderFile,
  type ImportedMcp,
  type ImportedSkill,
  type ImportPlan,
  type ImportRunResult,
  type McpImportRunResult,
  type OpenedProject,
  type PersistedState,
  type ProfileSummary,
  type ProjectGroup,
  type PtyHandle,
  type ReadEventsPage,
  type SkillImportRunResult,
  type UiBatch,
} from "../../shared/bridge.ts";
import {
  abortTurn,
  attachPortsScript,
  runScriptedTurn,
} from "./agent-script.ts";
import { openFakePty } from "./fake-pty.ts";
import {
  addWorkspaceFolder,
  listDir,
  readFixtureFile,
} from "./fixtures/files.ts";
import { buildFixtureSessions, PROJECT } from "./fixtures/sessions.ts";
import {
  CLIENT_ID,
  MODELS,
  SRC,
  THINKING_LEVELS,
  ulid,
  WORKSPACE_ID,
  World,
} from "./world.ts";

const PERSIST_KEY = "agena.desktop.persisted";
const DAEMON_URL = "http://127.0.0.1:7777";

const mockPlugins: PluginSummary[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Repositories, pull requests, issues, and Git operations.",
    publisher: "Agena",
    kind: "integration",
    category: "developer_tools",
    status: "available",
    authKind: "oauth",
    featured: true,
    capabilities: ["Repositories", "Pull requests", "Git"],
    enabled: false,
  },
  {
    id: "mcp-playwright",
    name: "Playwright MCP",
    description: "Automate and inspect websites in a browser.",
    publisher: "Microsoft",
    kind: "mcp",
    category: "automation",
    status: "ready",
    authKind: "none",
    featured: true,
    capabilities: ["Browser automation"],
    enabled: true,
  },
];

function updateMockPlugin(
  id: string,
  patch: Partial<PluginSummary>,
): PluginSummary {
  const plugin = mockPlugins.find((item) => item.id === id);
  if (!plugin) throw bridgeError("NOT_FOUND", `plugin ${id} not found`);
  Object.assign(plugin, patch);
  return { ...plugin };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function bridgeError(
  code: string,
  message: string,
  retryable = false,
): BridgeError {
  return { code, message, retryable };
}

function fakeSha256(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 64; i++) {
    h = Math.imul(h ^ i, 0x01000193) >>> 0;
    out += (h % 16).toString(16);
  }
  return out;
}

// Fixture scan (settings_import_plan.md §1): two projects, mixed harnesses;
// openwork is partially imported so the ledger badges have something to show.
const IMPORT_PROJECTS: ProjectGroup[] = [
  {
    cwd: "/Users/dev/Desktop/Rough/zonko/luf",
    exists: true,
    codebaseBytes: 48_234_496,
    byHarness: {
      codex: { count: 99, bytes: 31_457_280 },
      claude: { count: 68, bytes: 20_971_520 },
      pi: { count: 12, bytes: 2_097_152 },
    },
  },
  {
    cwd: "/Users/dev/Desktop/Rough/openwork",
    exists: true,
    codebaseBytes: 72_704,
    byHarness: {
      codex: { count: 0, bytes: 0 },
      claude: { count: 3, bytes: 1_258_291 },
      pi: { count: 0, bytes: 0 },
    },
  },
];

function eventText(
  e: AgenaEvent,
): { text: string; messageId: string | null } | null {
  if (
    e.type !== "message.user.created" &&
    e.type !== "message.assistant.completed"
  ) {
    return null;
  }
  const p = e.payload as { messageId?: string; content?: unknown };
  const content = Array.isArray(p.content) ? p.content : [];
  const text = content
    .filter(
      (b): b is { type: "text"; text: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("\n");
  return text ? { text, messageId: p.messageId ?? null } : null;
}

export function createMockBridge(): AgenaBridge {
  const imageBlobs = new Map<string, Uint8Array>();
  const world = new World();
  const { seeds, ids } = buildFixtureSessions();
  for (const seed of seeds) world.addSession(seed);
  attachPortsScript(world, ids.ports);

  const bootAt = Date.now();
  let connected = false;
  const statusListeners = new Set<
    (state: BridgeConnectionState, detail?: string) => void
  >();
  const emitStatus = (state: BridgeConnectionState, detail?: string): void => {
    for (const cb of statusListeners) {
      if (detail === undefined) cb(state);
      else cb(state, detail);
    }
  };

  // ---- fake embedded browser (no real WebContentsView in a bare browser) ----
  const browserListeners = new Set<(state: BrowserState) => void>();
  let browserState: BrowserState = {
    tabs: [],
    activeTabId: null,
    url: null,
    title: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  const emitBrowser = (patch: Partial<BrowserState>): void => {
    browserState = { ...browserState, ...patch };
    for (const cb of browserListeners) cb(browserState);
  };
  const fakeLoad = (url: string, newTab = false): string => {
    let host = url;
    try {
      host = new URL(url).host || url;
    } catch {
      // keep the raw string as the title
    }
    const tabId =
      !newTab && browserState.activeTabId
        ? browserState.activeTabId
        : crypto.randomUUID();
    const tab = {
      tabId,
      url,
      title: host,
      loading: true,
      canGoBack: true,
      canGoForward: false,
    };
    emitBrowser({
      tabs: [...browserState.tabs.filter((item) => item.tabId !== tabId), tab],
      activeTabId: tabId,
      url,
      title: host,
      loading: true,
      canGoBack: true,
    });
    setTimeout(() => {
      const tabs = browserState.tabs.map((item) =>
        item.tabId === tabId ? { ...item, loading: false } : item,
      );
      emitBrowser({ tabs, loading: false, title: host });
    }, 200);
    return url;
  };

  const requireConnected = (): void => {
    if (!connected) {
      throw bridgeError("DISCONNECTED", "mock bridge is not connected", true);
    }
  };
  const getSession = (sessionId: string) => {
    const s = world.sessions.get(sessionId);
    if (!s) {
      throw bridgeError(
        "SESSION_NOT_FOUND",
        `unknown session ${sessionId}`,
        false,
      );
    }
    return s;
  };

  // openwork already has files + 2 of its 3 claude sessions in the ledger
  // ("1 new since import"); claude source paths embed the dash-encoded cwd,
  // which is the anchor the Settings UI joins on.
  const openworkEnc = "-Users-dev-Desktop-Rough-openwork";
  const importLedger: ImportLedgerEntry[] = [
    {
      id: ulid(),
      projectId: "prj_openwork",
      machineId: CLIENT_ID,
      harness: "files",
      sourcePath: "/Users/dev/Desktop/Rough/openwork",
      importedAt: "2026-07-09T08:00:00.000Z",
    },
    ...[0, 1].map(
      (i): ImportLedgerEntry => ({
        id: ulid(),
        sessionId: ulid(),
        projectId: "prj_openwork",
        machineId: CLIENT_ID,
        harness: "claude",
        sourcePath: `/Users/dev/.claude/projects/${openworkEnc}/session-${i}.jsonl`,
        sourceSessionId: ulid(),
        importedAt: "2026-07-09T08:00:01.000Z",
      }),
    ),
  ];
  const discoveredMcps = [
    {
      id: "harbor-local",
      identity: "remote:https://mcp.tryharbor.ai/mcp",
      name: "harbor-mcp",
      transport: "http" as const,
      target: "https://mcp.tryharbor.ai/mcp",
      authKind: "oauth" as const,
      authStatus: "needs_authorization" as const,
    },
    {
      id: "filesystem-local",
      identity: 'stdio:["npx","-y","@modelcontextprotocol/server-filesystem"]',
      name: "filesystem",
      transport: "stdio" as const,
      target: "npx -y @modelcontextprotocol/server-filesystem",
      authKind: "none" as const,
      authStatus: "ready" as const,
    },
  ];
  const importedMcps: ImportedMcp[] = [];
  const discoveredSkills = [
    {
      id: "frontend-local",
      identity: "local-skill:frontend",
      contentHash: "sha256-frontend-v2",
      name: "frontend-design",
      description: "Build distinctive production interfaces.",
      fileCount: 3,
    },
    {
      id: "cloudflare-local",
      identity: "local-skill:cloudflare",
      contentHash: "sha256-cloudflare",
      name: "cloudflare",
      fileCount: 1,
    },
  ];
  const importedSkills: ImportedSkill[] = [
    {
      id: "skill_frontend",
      identity: "local-skill:frontend",
      contentHash: "sha256-frontend-v1",
      name: "frontend-design",
      status: "ready",
    },
  ];

  const snapshots: SnapshotSummary[] = [
    {
      snapshotId: ulid(),
      workspaceId: WORKSPACE_ID,
      sessionId: ids.auth,
      name: "before auth fix",
      kind: "manual",
      storagePath: "/var/agena/snapshots/before-auth-fix.tar",
      sha256: fakeSha256("before-auth-fix"),
      sizeBytes: 1_482_752,
      status: "available",
      createdAt: "2026-07-06T09:10:12.000Z",
    },
    {
      snapshotId: ulid(),
      workspaceId: WORKSPACE_ID,
      kind: "auto",
      storagePath: "/var/agena/snapshots/auto-nightly.tar",
      sha256: fakeSha256("auto-nightly"),
      sizeBytes: 1_490_944,
      status: "available",
      createdAt: "2026-07-07T02:00:00.000Z",
    },
  ];

  return {
    // ---- lifecycle -----------------------------------------------------------
    async listProfiles(): Promise<ProfileSummary[]> {
      return [{ name: "local", url: DAEMON_URL, isDefault: true }];
    },

    async connect(profileName?: string): Promise<ConnectedInfo> {
      emitStatus("connecting");
      await sleep(350);
      connected = true;
      emitStatus("connected");
      return {
        profile: profileName ?? "local",
        url: DAEMON_URL,
        daemonVersion: "0.3.0-mock",
        protocolVersion: 1,
        clientId: CLIENT_ID,
      };
    },

    async disconnect(): Promise<void> {
      connected = false;
      emitStatus("closed");
    },

    // ---- WS commands -----------------------------------------------------------
    async subscribe(sessionId: string, fromSeq: number): Promise<SubscribeAck> {
      requireConnected();
      const ack = world.subscribe(sessionId, fromSeq);
      if (!ack) {
        throw bridgeError(
          "SESSION_NOT_FOUND",
          `unknown session ${sessionId}`,
          false,
        );
      }
      return ack;
    },

    async prompt(sessionId: string, text: string): Promise<PromptAck> {
      requireConnected();
      const s = getSession(sessionId);
      if (s.live) {
        throw bridgeError("SESSION_BUSY", "a turn is already active", false);
      }
      const messageId = ulid();
      const ev = world.append(
        sessionId,
        "message.user.created",
        { messageId, content: [{ type: "text", text }] },
        SRC.user(),
      );
      runScriptedTurn(world, sessionId, messageId, text, "prompt");
      return { messageId, seq: ev.seq };
    },

    async steer(sessionId: string, text: string): Promise<PromptAck> {
      requireConnected();
      const s = getSession(sessionId);
      if (!s.live) {
        throw bridgeError("TURN_NOT_ACTIVE", "no active turn to steer", false);
      }
      const messageId = ulid();
      const ev = world.append(
        sessionId,
        "message.user.created",
        { messageId, content: [{ type: "text", text }], queued: "steer" },
        SRC.user(),
      );
      s.live.steerText = text;
      return { messageId, seq: ev.seq };
    },

    async followUp(sessionId: string, text: string): Promise<PromptAck> {
      requireConnected();
      const s = getSession(sessionId);
      if (!s.live) {
        throw bridgeError(
          "TURN_NOT_ACTIVE",
          "no active turn to follow up",
          false,
        );
      }
      const messageId = ulid();
      const ev = world.append(
        sessionId,
        "message.user.created",
        { messageId, content: [{ type: "text", text }], queued: "followUp" },
        SRC.user(),
      );
      s.live.followUps.push({ messageId, text });
      return { messageId, seq: ev.seq };
    },

    async abort(sessionId: string): Promise<EmptyAck> {
      requireConnected();
      getSession(sessionId);
      abortTurn(world, sessionId);
      return {};
    },

    async respondToApproval(
      sessionId: string,
      approvalId: string,
      response: ApprovalResponse,
    ): Promise<RespondToApprovalAck> {
      requireConnected();
      const s = getSession(sessionId);
      const pending = s.live?.pendingApproval;
      if (!pending || pending.summary.approvalId !== approvalId) {
        throw bridgeError(
          "APPROVAL_NOT_PENDING",
          `approval ${approvalId} is not pending`,
          false,
        );
      }
      world.append(
        sessionId,
        "approval.responded",
        { approvalId, response, respondedBy: CLIENT_ID },
        SRC.daemon,
      );
      pending.resolve(response);
      return { approvalId };
    },

    async runtimeInfo(sessionId: string): Promise<RuntimeInfoAck> {
      requireConnected();
      const s = getSession(sessionId);
      return {
        model: s.runtime.model,
        thinkingLevel: s.runtime.thinkingLevel,
        availableModels: MODELS,
        availableThinkingLevels: THINKING_LEVELS,
        fastMode: {
          enabled: s.runtime.fastMode,
          available: true,
          active: s.runtime.fastMode,
        },
        sessionUsage: {
          inputTokens: 6_310,
          outputTokens: 420,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 6_730,
          costUsd: 0.03,
        },
        slashCommands: [],
      };
    },

    async setModel(sessionId: string, model: ModelRef): Promise<SetModelAck> {
      requireConnected();
      const s = getSession(sessionId);
      const from = s.runtime.model;
      s.runtime.model = model;
      world.append(
        sessionId,
        "model.changed",
        { from, to: model, reason: "user_selected" },
        SRC.daemon,
      );
      return { model };
    },

    async setThinkingLevel(
      sessionId: string,
      thinkingLevel: ThinkingLevel,
    ): Promise<SetThinkingLevelAck> {
      requireConnected();
      const s = getSession(sessionId);
      const from = s.runtime.thinkingLevel;
      s.runtime.thinkingLevel = thinkingLevel;
      world.append(
        sessionId,
        "thinking.level.changed",
        { from, to: thinkingLevel },
        SRC.daemon,
      );
      return { thinkingLevel };
    },

    async setFastMode(
      sessionId: string,
      enabled: boolean,
    ): Promise<SetFastModeAck> {
      requireConnected();
      const s = getSession(sessionId);
      s.runtime.fastMode = enabled;
      world.append(sessionId, "fast.mode.changed", { enabled }, SRC.daemon);
      return { enabled, available: true, active: enabled };
    },

    async compact(sessionId: string): Promise<CompactAck> {
      requireConnected();
      const s = getSession(sessionId);
      await sleep(800);
      const replacesUpToSeq = s.summary.lastSeq;
      const ev = world.append(
        sessionId,
        "compaction.created",
        {
          compactionId: ulid(),
          summary: [
            {
              type: "text",
              text: `Compacted the conversation: ${replacesUpToSeq} earlier events summarized.`,
            },
          ],
          replacesUpToSeq,
          tokensBefore: 51_200,
          tokensAfter: 6_400,
          trigger: "user",
        },
        SRC.daemon,
      );
      return { compactionSeq: ev.seq };
    },

    // ---- HTTP -------------------------------------------------------------------
    async createSession(
      input?: Partial<CreateSessionRequest>,
    ): Promise<string> {
      requireConnected();
      const scope = input?.scope ?? "project";
      const sessionId = ulid();
      const rootBranchId = ulid();
      const now = new Date().toISOString();
      const project =
        scope === "project"
          ? {
              projectId: input?.projectId ?? PROJECT.projectId,
              projectRoot: input?.projectRoot ?? PROJECT.projectRoot,
            }
          : {};
      const cwd =
        input?.cwd ??
        (scope === "project"
          ? (input?.projectRoot ?? PROJECT.projectRoot)
          : "/workspace");
      const summary: SessionSummary = {
        sessionId,
        workspaceId: WORKSPACE_ID,
        ...(input?.title ? { title: input.title } : {}),
        rootBranchId,
        lastSeq: 0,
        createdAt: now,
        updatedAt: now,
        scope,
        status: "idle",
        ...project,
        cwd,
      };
      world.addSession({ summary, events: [], live: null });
      world.append(
        sessionId,
        "session.created",
        {
          workspaceId: WORKSPACE_ID,
          ...(input?.title ? { title: input.title } : {}),
          runtime: "pi",
          origin: "native",
          scope,
          ...project,
          cwd,
          rootBranchId,
        },
        SRC.daemon,
      );
      return sessionId;
    },

    async forkSession(sourceSessionId, sourceMessageId, mode) {
      requireConnected();
      const source = getSession(sourceSessionId);
      if (mode === "fork" && !sourceMessageId) {
        throw bridgeError(
          "INVALID_PAYLOAD",
          "a fork needs a source message",
          false,
        );
      }
      const sessionId = ulid();
      const rootBranchId = ulid();
      const now = new Date().toISOString();
      const summary: SessionSummary = {
        ...source.summary,
        sessionId,
        rootBranchId,
        lastSeq: 0,
        createdAt: now,
        updatedAt: now,
        status: "idle",
        parentSessionId: sourceSessionId,
        sessionKind: "primary",
      };
      world.addSession({
        summary,
        events: [],
        live: null,
        runtime: source.runtime,
      });
      world.append(
        sessionId,
        "session.created",
        {
          workspaceId: WORKSPACE_ID,
          runtime: "pi",
          origin: "native",
          scope: source.summary.scope,
          ...(source.summary.projectId
            ? { projectId: source.summary.projectId }
            : {}),
          ...(source.summary.projectRoot
            ? { projectRoot: source.summary.projectRoot }
            : {}),
          cwd: source.summary.cwd,
          rootBranchId,
          derivedFrom: {
            parentSessionId: sourceSessionId,
            ...(sourceMessageId ? { sourceMessageId } : {}),
            mode,
          },
        },
        SRC.daemon,
      );
      return { sessionId };
    },

    async navigateSession(sessionId, sourceMessageId) {
      requireConnected();
      const source = getSession(sessionId);
      const event = source.events.find(
        (candidate) =>
          candidate.type === "message.user.created" &&
          (candidate.payload as { messageId?: unknown }).messageId ===
            sourceMessageId,
      );
      if (!event) {
        throw bridgeError(
          "INVALID_PAYLOAD",
          "message is not in this session",
          false,
        );
      }
      return eventText(event)?.text ?? "";
    },

    async createProject(name: string): Promise<OpenedProject> {
      requireConnected();
      const clean = name.replace(/[^A-Za-z0-9._-]+/g, "-") || "project";
      addWorkspaceFolder(clean, []);
      const projectRoot = clean;
      return {
        name: clean,
        projectId: `prj_${clean.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        projectRoot,
        cwd: projectRoot,
        fileCount: 0,
      };
    },

    async deleteProject(
      projectId: string,
    ): Promise<{ projectId: string; deletedSessions: number }> {
      requireConnected();
      const ids = [...world.sessions.values()]
        .filter((s) => s.summary.projectId === projectId)
        .map((s) => s.summary.sessionId);
      for (const id of ids) world.sessions.delete(id);
      return { projectId, deletedSessions: ids.length };
    },

    async openProjectFolder(): Promise<OpenedProject | null> {
      requireConnected();
      // Pick: Finder via the dev shell, prompt in a plain browser. Copy: the
      // real bridge tars the folder to POST /v1/files/upload; the mock ingests
      // the captured files into its fake /workspace.
      let name: string;
      let files: HostFolderFile[];
      if (window.agenaShell) {
        const picked = await window.agenaShell.pickFolder();
        if (!picked) return null;
        const folder = await window.agenaShell.readFolder(picked);
        name =
          folder?.name ??
          picked.replace(/\/+$/, "").split("/").pop() ??
          "project";
        files = folder?.files ?? [];
      } else {
        const path = window.prompt(
          "Mock picker — enter a project folder path:",
          "/Users/you/dev/new-project",
        );
        if (!path?.trim()) return null;
        name = path.trim().replace(/\/+$/, "").split("/").pop() ?? "project";
        files = [
          {
            path: "README.md",
            size: 64,
            text: `# ${name}\n\nPlaceholder — picked in the browser mock; the Electron shell copies real files.\n`,
          },
        ];
      }
      name = name.replace(/[^A-Za-z0-9._-]+/g, "-");
      // fake the tar-upload latency, scaled by size
      await new Promise((r) =>
        setTimeout(r, 300 + Math.min(files.length * 3, 1200)),
      );
      addWorkspaceFolder(name, files);
      const projectRoot = name;
      return {
        name,
        projectId: `prj_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        projectRoot,
        cwd: projectRoot,
        fileCount: files.length,
      };
    },
    async openWorkspaceFile(): Promise<void> {},

    async listSessionSummaries(
      filters?: ListSessionsQuery,
    ): Promise<SessionSummary[]> {
      requireConnected();
      let rows = [...world.sessions.values()].map((s) => s.summary);
      if (filters?.projectId) {
        rows = rows.filter((r) => r.projectId === filters.projectId);
      }
      if (filters?.scope) rows = rows.filter((r) => r.scope === filters.scope);
      if (filters?.status)
        rows = rows.filter((r) => r.status === filters.status);
      if (!filters?.includeArchived) {
        rows = rows.filter((r) => r.status !== "archived");
      }
      return rows;
    },

    async updateSessionStatus(
      sessionId: string,
      status: SessionStatus,
    ): Promise<void> {
      requireConnected();
      getSession(sessionId);
      world.setStatus(sessionId, status);
    },

    async readEvents(
      sessionId: string,
      opts?: { fromSeq?: number; limit?: number },
    ): Promise<ReadEventsPage> {
      requireConnected();
      const s = getSession(sessionId);
      const fromSeq = opts?.fromSeq ?? 0;
      const limit = opts?.limit ?? 200;
      const remaining = s.events.filter((e) => e.seq > fromSeq);
      const events = remaining.slice(0, limit);
      const last = events[events.length - 1];
      return {
        events,
        nextFromSeq: last && remaining.length > events.length ? last.seq : null,
      };
    },

    async listUserMessages(sessionId: string): Promise<UserMessageAnchor[]> {
      requireConnected();
      return getSession(sessionId).events.flatMap((event) => {
        if (event.type !== "message.user.created") return [];
        return [
          {
            messageId: String(
              (event.payload as { messageId?: unknown }).messageId ?? event.seq,
            ),
            seq: event.seq,
            preview: eventText(event)?.text.slice(0, 320) ?? "",
            createdAt: event.createdAt,
          },
        ];
      });
    },

    async search(
      query: string,
      opts?: { sessionId?: string; allProjects?: boolean; limit?: number },
    ): Promise<SearchHit[]> {
      requireConnected();
      const q = query.toLowerCase();
      const limit = opts?.limit ?? 20;
      const hits: SearchHit[] = [];
      for (const s of world.sessions.values()) {
        if (opts?.sessionId && s.summary.sessionId !== opts.sessionId) continue;
        for (const e of s.events) {
          const row = eventText(e);
          if (!row) continue;
          const at = row.text.toLowerCase().indexOf(q);
          if (at < 0) continue;
          const start = Math.max(0, at - 40);
          const end = Math.min(row.text.length, at + q.length + 60);
          const snippet =
            (start > 0 ? "…" : "") +
            row.text.slice(start, end).replaceAll("\n", " ") +
            (end < row.text.length ? "…" : "");
          hits.push({
            sessionId: s.summary.sessionId,
            ...(row.messageId ? { messageId: row.messageId } : {}),
            snippet,
            rank: 1 / (1 + hits.length),
            seq: e.seq,
          });
          if (hits.length >= limit) return hits;
        }
      }
      return hits;
    },

    async listApprovals(): Promise<PendingApprovalSummary[]> {
      requireConnected();
      return world.pendingApprovals();
    },

    async listFiles(opts?: { path?: string }): Promise<FileEntry[]> {
      requireConnected();
      const entries = listDir(opts?.path ?? ".");
      if (!entries) {
        throw bridgeError(
          "NOT_FOUND",
          `no such directory: ${opts?.path ?? "."}`,
          false,
        );
      }
      return entries;
    },

    async readFile(path: string): Promise<Uint8Array> {
      requireConnected();
      const content = readFixtureFile(path);
      if (content === null) {
        throw bridgeError("NOT_FOUND", `no such file: ${path}`, false);
      }
      return new TextEncoder().encode(content);
    },
    async uploadImage(bytes: Uint8Array, mimeType: string) {
      const source = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", source)),
      )
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const blob = `sha256:${digest}`;
      imageBlobs.set(blob, bytes.slice());
      return { blob, sizeBytes: bytes.byteLength, mimeType };
    },
    async readBlob(hash: string) {
      const bytes = imageBlobs.get(hash);
      if (!bytes) throw new Error("mock image blob not found");
      return bytes.slice();
    },

    async listSnapshots(): Promise<SnapshotSummary[]> {
      requireConnected();
      return [...snapshots];
    },

    async createSnapshot(input?: {
      name?: string;
      sessionId?: string;
    }): Promise<SnapshotSummary> {
      requireConnected();
      const snapshotId = ulid();
      const snapshot: SnapshotSummary = {
        snapshotId,
        workspaceId: WORKSPACE_ID,
        ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input?.name ? { name: input.name } : {}),
        kind: "manual",
        storagePath: `/var/agena/snapshots/${snapshotId}.tar`,
        sha256: fakeSha256(snapshotId),
        sizeBytes: 1_500_000 + snapshots.length * 4096,
        status: "available",
        createdAt: new Date().toISOString(),
      };
      snapshots.push(snapshot);
      return snapshot;
    },

    async restoreSnapshot(
      snapshotId: string,
      input?: { sessionId?: string },
    ): Promise<{ snapshotId: string; safetySnapshotId: string }> {
      requireConnected();
      const target = snapshots.find(
        (s) => s.snapshotId === snapshotId && s.status === "available",
      );
      if (!target) {
        throw bridgeError(
          "NOT_FOUND",
          `no such snapshot: ${snapshotId}`,
          false,
        );
      }
      await sleep(900);
      const safetySnapshotId = ulid();
      snapshots.push({
        snapshotId: safetySnapshotId,
        workspaceId: WORKSPACE_ID,
        name: "pre-restore safety",
        kind: "pre_restore",
        storagePath: `/var/agena/snapshots/${safetySnapshotId}.tar`,
        sha256: fakeSha256(safetySnapshotId),
        sizeBytes: target.sizeBytes,
        status: "available",
        createdAt: new Date().toISOString(),
      });
      world.append(
        ids.auth,
        "snapshot.restored",
        {
          snapshotId,
          safetySnapshotId,
          ...(input?.sessionId
            ? { triggeredBySessionId: input.sessionId }
            : {}),
        },
        SRC.daemon,
      );
      return { snapshotId, safetySnapshotId };
    },

    async deleteSnapshot(snapshotId: string): Promise<void> {
      requireConnected();
      const target = snapshots.find((s) => s.snapshotId === snapshotId);
      if (!target || target.status === "deleted") {
        throw bridgeError(
          "NOT_FOUND",
          `no such snapshot: ${snapshotId}`,
          false,
        );
      }
      target.status = "deleted";
    },

    async diagnostics(): Promise<DiagnosticsResponse> {
      requireConnected();
      return {
        daemon: { version: "0.3.0-mock", uptimeMs: Date.now() - bootAt },
        protocol: { version: 1 },
        workspace: { path: "/workspace" },
        discovery: {
          entries: [
            {
              kind: "tool",
              name: "bash",
              file: ".agena/tools/bash.toml",
              status: "ok",
            },
            {
              kind: "skill",
              name: "review",
              file: ".agena/skills/review.md",
              status: "ok",
            },
            {
              kind: "hook",
              name: "pre-push",
              file: ".agena/hooks/pre-push.ts",
              status: "invalid",
              reason: "default export is not a function",
            },
          ],
        },
      };
    },
    async createPairing(daemonUrl: string) {
      const link = new URL("agena://pair");
      link.searchParams.set("url", daemonUrl);
      link.searchParams.set("token", "mock-pairing-token");
      return {
        pairingUri: link.toString(),
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
    },

    async listPtys(): Promise<PtySummary[]> {
      requireConnected();
      return [];
    },

    async listPlugins(): Promise<PluginSummary[]> {
      return mockPlugins.map((plugin) => ({ ...plugin }));
    },
    async installPlugin(id: string): Promise<PluginSummary> {
      return updateMockPlugin(id, { status: "installed", enabled: true });
    },
    async updatePlugin(id: string): Promise<PluginSummary> {
      return updateMockPlugin(id, { status: "ready", enabled: true });
    },
    async setPluginEnabled(
      id: string,
      enabled: boolean,
    ): Promise<PluginSummary> {
      return updateMockPlugin(id, {
        status: enabled ? "installed" : "disabled",
        enabled,
      });
    },
    async removePlugin(id: string): Promise<PluginSummary> {
      return updateMockPlugin(id, { status: "available", enabled: false });
    },

    async listProviders(): Promise<ProviderAuthSummary[]> {
      return [
        {
          id: "anthropic",
          name: "Anthropic",
          methods: ["api_key", "oauth"],
          modelCount: 3,
          configured: true,
          source: "environment",
          label: "ANTHROPIC_API_KEY",
        },
        {
          id: "openai-codex",
          name: "ChatGPT Plus/Pro (Codex Subscription)",
          methods: ["oauth"],
          modelCount: 3,
          configured: false,
        },
      ];
    },
    async saveProviderApiKey(id): Promise<ProviderAuthSummary> {
      return {
        id,
        name: id,
        methods: ["api_key"],
        modelCount: 1,
        configured: true,
        credentialKind: "api_key",
        source: "stored",
      };
    },
    async removeProviderAuth(id): Promise<ProviderAuthSummary> {
      return {
        id,
        name: id,
        methods: ["api_key"],
        modelCount: 1,
        configured: false,
      };
    },
    async startProviderOAuth(id): Promise<ProviderOAuthStatusResponse> {
      return { flowId: ulid(), providerId: id, state: "completed" };
    },
    async providerOAuthStatus(flowId): Promise<ProviderOAuthStatusResponse> {
      return { flowId, providerId: "openai-codex", state: "completed" };
    },
    async respondProviderOAuth(flowId): Promise<ProviderOAuthStatusResponse> {
      return { flowId, providerId: "openai-codex", state: "completed" };
    },

    // ---- local-session import ------------------------------------------------
    async importScan(opts?: { refresh?: boolean }) {
      requireConnected();
      if (opts?.refresh) await sleep(400);
      return {
        projects: IMPORT_PROJECTS.map((p) => ({
          ...p,
          byHarness: { ...p.byHarness },
        })),
        scannedAt: new Date().toISOString(),
      };
    },

    async importRun(plan: ImportPlan): Promise<ImportRunResult> {
      requireConnected();
      // Fixture theater only — dedupe/idempotency live in the daemon route and
      // the sqlite UNIQUE constraint, not here.
      const sessions: ImportRunResult["sessions"] = [];
      for (const proj of plan.projects) {
        const scan = IMPORT_PROJECTS.find((p) => p.cwd === proj.cwd);
        const enc = proj.cwd.replaceAll("/", "-");
        const projectId = `prj_${proj.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        importLedger.push({
          id: ulid(),
          projectId,
          machineId: CLIENT_ID,
          harness: "files",
          sourcePath: proj.cwd,
          importedAt: new Date().toISOString(),
        });
        for (const harness of proj.harnesses) {
          for (let i = 0; i < (scan?.byHarness[harness]?.count ?? 0); i++) {
            const sourcePath = `/Users/dev/.${harness}/projects/${enc}/session-${i}.jsonl`;
            if (sessions.length === 0) {
              // one skipped row so the result list exercises that badge tone
              sessions.push({ sourcePath, status: "skipped" });
              continue;
            }
            const sessionId = ulid();
            importLedger.push({
              id: ulid(),
              sessionId,
              projectId,
              machineId: CLIENT_ID,
              harness,
              sourcePath,
              sourceSessionId: ulid(),
              importedAt: new Date().toISOString(),
            });
            sessions.push({ sourcePath, status: "ok", sessionId });
          }
        }
      }
      await sleep(400);
      return { sessions };
    },

    async importStatus() {
      requireConnected();
      return { imports: [...importLedger] };
    },

    async mcpImportScan(opts?: { refresh?: boolean }) {
      requireConnected();
      if (opts?.refresh) await sleep(250);
      return {
        mcps: discoveredMcps.map((mcp) => ({ ...mcp })),
        scannedAt: new Date().toISOString(),
      };
    },

    async mcpImportRun(plan: { ids: string[] }): Promise<McpImportRunResult> {
      requireConnected();
      const mcps: McpImportRunResult["mcps"] = [];
      for (const id of plan.ids) {
        const found = discoveredMcps.find((mcp) => mcp.id === id);
        if (!found) {
          mcps.push({ id, status: "error", error: "MCP not found" });
          continue;
        }
        const mcpId = `mcp_${id}`;
        const status =
          found.authKind === "oauth" ? "needs_authorization" : "imported";
        importedMcps.push({
          id: mcpId,
          identity: found.identity,
          name: found.name,
          status,
        });
        mcps.push({
          id,
          mcpId,
          status:
            status === "needs_authorization"
              ? "needs_authorization"
              : "imported",
        });
      }
      await sleep(250);
      return { mcps };
    },

    async mcpImportStatus() {
      requireConnected();
      return { mcps: importedMcps.map((mcp) => ({ ...mcp })) };
    },

    async mcpAuthStart(mcpId: string) {
      requireConnected();
      const mcp = importedMcps.find((item) => item.id === mcpId);
      if (mcp) mcp.status = "ready";
    },

    async skillImportScan(opts?: { refresh?: boolean }) {
      requireConnected();
      if (opts?.refresh) await sleep(250);
      return {
        skills: discoveredSkills.map((skill) => ({ ...skill })),
        scannedAt: new Date().toISOString(),
      };
    },

    async skillImportRun(plan: {
      ids: string[];
    }): Promise<SkillImportRunResult> {
      requireConnected();
      const skills: SkillImportRunResult["skills"] = [];
      for (const id of plan.ids) {
        const found = discoveredSkills.find((skill) => skill.id === id);
        if (!found) {
          skills.push({ id, status: "error", error: "Skill not found" });
          continue;
        }
        const previous = importedSkills.find(
          (skill) => skill.identity === found.identity,
        );
        if (previous) {
          previous.contentHash = found.contentHash;
          skills.push({ id, skillId: previous.id, status: "imported" });
        } else {
          const skillId = `skill_${id}`;
          importedSkills.push({
            id: skillId,
            identity: found.identity,
            contentHash: found.contentHash,
            name: found.name,
            status: "ready",
          });
          skills.push({ id, skillId, status: "imported" });
        }
      }
      return { skills };
    },

    async skillImportStatus() {
      requireConnected();
      return { skills: importedSkills.map((skill) => ({ ...skill })) };
    },

    async skillUpdate(skillId: string) {
      requireConnected();
      const skill = importedSkills.find((item) => item.id === skillId);
      if (skill) skill.status = "ready";
    },

    // ---- streams -------------------------------------------------------------------
    onBatch(cb: (batch: UiBatch) => void): () => void {
      return world.onBatch(cb);
    },

    onStatus(
      cb: (state: BridgeConnectionState, detail?: string) => void,
    ): () => void {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },

    // ---- embedded browser (fake: no native WebContentsView in a bare browser) -----
    async browserOpen(url: string, opts?: BrowserOpenOptions): Promise<string> {
      return fakeLoad(url, opts?.newTab);
    },
    async browserNavigate(action: BrowserNavAction): Promise<void> {
      if (action.kind === "activate") {
        const tab = browserState.tabs.find(
          (item) => item.tabId === action.tabId,
        );
        if (tab) {
          emitBrowser({ activeTabId: tab.tabId, ...tab });
        }
      } else if (action.kind === "close") {
        const tabs = browserState.tabs.filter(
          (item) => item.tabId !== action.tabId,
        );
        const tab = tabs.at(-1);
        emitBrowser({
          tabs,
          activeTabId: tab?.tabId ?? null,
          url: tab?.url ?? null,
          title: tab?.title ?? null,
          loading: tab?.loading ?? false,
          canGoBack: tab?.canGoBack ?? false,
          canGoForward: tab?.canGoForward ?? false,
        });
      } else if (action.kind === "url") fakeLoad(action.url);
      else if (action.kind === "reload" && browserState.url) {
        fakeLoad(browserState.url);
      } else if (action.kind === "stop") emitBrowser({ loading: false });
    },
    async browserSetBounds(_bounds: BrowserBounds): Promise<void> {},
    async browserSetVisible(_visible: boolean): Promise<void> {},
    async browserOpenDevTools(): Promise<void> {
      console.info("[mock] browserOpenDevTools — no-op in the browser mock");
    },
    async browserOpenExternal(): Promise<void> {
      console.info("[mock] browserOpenExternal", browserState.url);
    },
    async browserClose(): Promise<void> {
      emitBrowser({
        tabs: [],
        activeTabId: null,
        url: null,
        title: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
      });
    },
    onBrowserState(cb: (state: BrowserState) => void): () => void {
      browserListeners.add(cb);
      return () => browserListeners.delete(cb);
    },

    // ---- terminals -------------------------------------------------------------------
    async openPty(opts: Partial<CreatePtyRequest>): Promise<PtyHandle> {
      requireConnected();
      return openFakePty(opts);
    },

    // ---- persistence -----------------------------------------------------------------
    async loadPersisted(): Promise<PersistedState> {
      try {
        const raw = localStorage.getItem(PERSIST_KEY);
        if (raw) {
          return {
            ...EMPTY_PERSISTED,
            ...(JSON.parse(raw) as Partial<PersistedState>),
          };
        }
      } catch (err) {
        console.warn("[mock] failed to load persisted state", err);
      }
      return EMPTY_PERSISTED;
    },

    async savePersisted(patch: Partial<PersistedState>): Promise<void> {
      let current: PersistedState = EMPTY_PERSISTED;
      try {
        const raw = localStorage.getItem(PERSIST_KEY);
        if (raw) {
          current = {
            ...EMPTY_PERSISTED,
            ...(JSON.parse(raw) as Partial<PersistedState>),
          };
        }
      } catch {
        // fall back to EMPTY_PERSISTED
      }
      localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({ ...current, ...patch }),
      );
    },
  };
}
