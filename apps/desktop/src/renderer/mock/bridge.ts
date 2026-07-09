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
  ListSessionsQuery,
  ModelRef,
  PendingApprovalSummary,
  PromptAck,
  PtySummary,
  RespondToApprovalAck,
  RuntimeInfoAck,
  SearchHit,
  SessionStatus,
  SessionSummary,
  SetModelAck,
  SetThinkingLevelAck,
  SnapshotSummary,
  SubscribeAck,
  ThinkingLevel,
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
  type OpenedProject,
  type PersistedState,
  type ProfileSummary,
  type PtyHandle,
  type ReadEventsPage,
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
    url: null,
    title: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    poppedOut: false,
  };
  const emitBrowser = (patch: Partial<BrowserState>): void => {
    browserState = { ...browserState, ...patch };
    for (const cb of browserListeners) cb(browserState);
  };
  const fakeLoad = (url: string): string => {
    let host = url;
    try {
      host = new URL(url).host || url;
    } catch {
      // keep the raw string as the title
    }
    emitBrowser({ url, title: host, loading: true, canGoBack: true });
    setTimeout(() => emitBrowser({ loading: false, title: host }), 200);
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

    async listPtys(): Promise<PtySummary[]> {
      requireConnected();
      return [];
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
    async browserOpen(
      url: string,
      _opts?: BrowserOpenOptions,
    ): Promise<string> {
      return fakeLoad(url);
    },
    async browserNavigate(action: BrowserNavAction): Promise<void> {
      if (action.kind === "url") fakeLoad(action.url);
      else if (action.kind === "reload" && browserState.url) {
        fakeLoad(browserState.url);
      } else if (action.kind === "stop") emitBrowser({ loading: false });
    },
    async browserSetBounds(_bounds: BrowserBounds): Promise<void> {},
    async browserSetVisible(_visible: boolean): Promise<void> {},
    async browserOpenDevTools(): Promise<void> {
      console.info("[mock] browserOpenDevTools — no-op in the browser mock");
    },
    async browserPopOut(): Promise<void> {
      emitBrowser({ poppedOut: !browserState.poppedOut });
    },
    async browserClose(): Promise<void> {
      emitBrowser({
        url: null,
        title: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        poppedOut: false,
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
