// WsBridge — a complete AgenaBridge over @agena/client + daemon HTTP so the
// renderer runs in a plain browser pointed at a daemon URL (no Electron main).
// This is the ONLY renderer module allowed to import @agena/client (D-INV-2's
// browser-mode carve-out; see ARCHITECTURE.md invariants).
//
// Differences from the Electron host (apps/desktop/electron/bridge.mjs, whose
// UiBatch composition is ported verbatim below):
//   - auth: HTTP uses the bearer token; each browser WS gets a one-use,
//     path-scoped ticket because browser WebSocket cannot set headers.
//   - persistence: localStorage instead of userData/persisted.json, same
//     shallow top-level merge semantics.
//   - local-machine-only methods (host filesystem scans, native pickers, the
//     WebContentsView browser pane) reject with code "DESKTOP_ONLY".
import {
  AgenaClient,
  type PtyWsLike,
  parsePtyExit,
  ulid,
  type WsLike,
} from "@agena/client";
import type { AgenaEvent, AgenaFrame, InFlightSnapshot } from "@agena/protocol";
import {
  type AgenaBridge,
  type BridgeConnectionState,
  type ConnectedInfo,
  EMPTY_PERSISTED,
  type ImportedMcp,
  type ImportedSkill,
  type PersistedState,
  type PtyPortMessage,
  type UiBatch,
} from "../../shared/bridge.ts";
import { bridgeError, desktopOnlyError, toBridgeError } from "./errors.ts";

// @agena/client composes the hello envelope from process.platform; give bare
// browsers a minimal stand-in (Node and Electron already have process). `env`
// must exist too — shiki (and other deps) read process.env.* at module scope.
const g = globalThis as {
  process?: { platform?: string; env?: Record<string, string | undefined> };
};
if (!g.process) g.process = { platform: "web", env: {} };
if (!g.process.platform) g.process.platform = "web";
if (!g.process.env) g.process.env = {};

// ---- connection config (localStorage) ---------------------------------------

export type WsConfig = { url: string; token: string };

type MobileConnectionHost = {
  connection: WsConfig | null;
  setConnection(config: WsConfig | null): void;
};

function mobileHost(): MobileConnectionHost | undefined {
  return (globalThis as { __AGENA_MOBILE__?: MobileConnectionHost })
    .__AGENA_MOBILE__;
}

const WS_CONFIG_KEY = "agena.connection";
const PERSISTED_KEY = "agena.persisted";
const CLIENT_ID_KEY = "agena.clientId";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage disabled (sandboxed iframe / privacy mode)
  }
}

/** Read {url, token} from localStorage["agena.connection"]; null when absent/invalid. */
export function getWsConfig(): WsConfig | null {
  const native = mobileHost();
  if (native) return native.connection;
  const raw = storage()?.getItem(WS_CONFIG_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { url?: unknown; token?: unknown };
    if (
      typeof parsed?.url === "string" &&
      parsed.url.length > 0 &&
      typeof parsed?.token === "string"
    ) {
      return { url: parsed.url, token: parsed.token };
    }
  } catch {
    // fall through — treat unparseable config as absent
  }
  return null;
}

/**
 * Persist (or clear, with null) the daemon connection. Bridge selection is
 * decided once at boot — the connect feature should reload after changing this.
 */
export function setWsConfig(cfg: WsConfig | null): void {
  const native = mobileHost();
  if (native) {
    native.setConnection(cfg);
    return;
  }
  const s = storage();
  if (!s) return;
  if (cfg) s.setItem(WS_CONFIG_KEY, JSON.stringify(cfg));
  else s.removeItem(WS_CONFIG_KEY);
}

/** Stable per-browser-install clientId ULID (mirrors userData/client-id). */
function loadClientId(): string {
  const s = storage();
  const existing = s?.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const id = ulid();
  s?.setItem(CLIENT_ID_KEY, id);
  return id;
}

// ---- UiBatch batcher (pure; ported from electron/bridge.mjs) ----------------

export type UiBatcher = {
  pushEvent(event: AgenaEvent, replayed: boolean): void;
  pushFrame(frame: AgenaFrame): void;
  pushSync(sync: {
    sessionId: string;
    branchId: string;
    upToSeq: number;
  }): void;
  pushSnapshot(snapshot: InFlightSnapshot): void;
  pushLostSession(sessionId: string): void;
};

/**
 * rAF in a browser (one flush per rendered frame), 16 ms timer elsewhere.
 * The rAF is raced with a timer: hidden tabs suspend rAF callbacks, and
 * without the fallback batches would buffer unboundedly until refocus.
 */
function defaultSchedule(flush: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    setTimeout(flush, 16);
    return;
  }
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    flush();
  };
  const timer = setTimeout(run, 32);
  requestAnimationFrame(() => {
    clearTimeout(timer);
    run();
  });
}

type TextDeltaPayload = {
  messageId: string;
  blockIndex: number;
  delta: string;
};
type ToolDeltaPayload = { toolCallId: string; delta: string; reset?: boolean };

/**
 * Buffers daemon push traffic and emits one UiBatch per flush. Binding rules
 * (shared/bridge.ts doc comment): events are never dropped/reordered; deltas
 * coalesce per target by CONCATENATION (`reset: true` on a tool delta discards
 * the accumulation); coalesce maps clear at every flush so coalescing never
 * spans batches.
 */
export function createUiBatcher(
  emit: (batch: UiBatch) => void,
  schedule: (flush: () => void) => void = defaultSchedule,
): UiBatcher {
  let buf: UiBatch | null = null;
  let armed = false;
  const textKeys = new Map<string, number>(); // coalesce target → index into buf.frames
  const toolKeys = new Map<string, number>();

  const ensureBuf = (): UiBatch => {
    buf ??= {
      events: [],
      frames: [],
      syncs: [],
      snapshots: [],
      lostSessions: [],
    };
    return buf;
  };
  const arm = (): void => {
    if (armed) return;
    armed = true;
    schedule(() => {
      armed = false;
      const b = buf;
      buf = null;
      textKeys.clear();
      toolKeys.clear();
      if (b) emit(b);
    });
  };

  const coalesceFrame = (f: AgenaFrame): void => {
    const b = ensureBuf();
    if (f.type === "message.assistant.text.delta") {
      const p = f.payload as TextDeltaPayload;
      const key = `${f.sessionId}\0${p.messageId}\0${p.blockIndex}`;
      const at = textKeys.get(key);
      const prev = at === undefined ? undefined : b.frames[at];
      if (prev) {
        const prevPayload = prev.payload as TextDeltaPayload;
        prev.payload = { ...p, delta: prevPayload.delta + p.delta };
        prev.afterSeq = f.afterSeq; // afterSeq advances to the newest
        return;
      }
      textKeys.set(key, b.frames.push({ ...f }) - 1);
      return;
    }
    if (f.type === "tool.call.output.delta") {
      const p = f.payload as ToolDeltaPayload;
      const key = `${f.sessionId}\0${p.toolCallId}`;
      const at = toolKeys.get(key);
      const prev = at === undefined ? undefined : b.frames[at];
      if (prev && !p.reset) {
        const prevPayload = prev.payload as ToolDeltaPayload;
        // keep an accumulated reset flag: "reset then RS" must still tell the
        // renderer to discard its pre-batch accumulation
        prev.payload = {
          ...p,
          delta: prevPayload.delta + p.delta,
          ...(prevPayload.reset ? { reset: true } : {}),
        };
        prev.afterSeq = f.afterSeq;
        return;
      }
      if (prev && p.reset && at !== undefined) {
        // reset discards the accumulation and starts over (rule 3)
        b.frames[at] = { ...f };
        return;
      }
      toolKeys.set(key, b.frames.push({ ...f }) - 1);
      return;
    }
    b.frames.push(f); // unknown frame types pass through untouched
  };

  return {
    pushEvent(event, replayed) {
      ensureBuf().events.push({ event, replayed });
      arm();
    },
    pushFrame(frame) {
      coalesceFrame(frame);
      arm();
    },
    pushSync(sync) {
      ensureBuf().syncs.push(sync);
      arm();
    },
    pushSnapshot(snapshot) {
      ensureBuf().snapshots.push(snapshot);
      arm();
    },
    pushLostSession(sessionId) {
      ensureBuf().lostSessions.push(sessionId);
      arm();
    },
  };
}

// ---- PTY: dedicated WS ↔ MessagePort (PtyPortMessage protocol) --------------

/**
 * Wrap a PTY WebSocket in a MessageChannel speaking PtyPortMessage exactly:
 * binary WS frames ↔ {type:"data"} port messages, daemon exit/close → "exit",
 * renderer "resize"/"close" → control frame / WS close. Returns the renderer's
 * end of the channel. BINDING: postMessage is always called WITHOUT a transfer
 * list (shared/bridge.ts — Electron-bridged ports reject ArrayBuffer transfers,
 * and the mock/real divergence hides exactly there).
 */
export function wirePtyPort(sock: PtyWsLike): MessagePort {
  const { port1, port2 } = new MessageChannel();
  sock.binaryType = "arraybuffer";
  sock.onmessage = (ev) => {
    const d = ev.data;
    if (typeof d === "string") {
      const exitCode = parsePtyExit(d);
      if (exitCode !== undefined) {
        const msg: PtyPortMessage = { type: "exit", exitCode };
        port1.postMessage(msg);
      }
      return;
    }
    const data =
      d instanceof ArrayBuffer
        ? d
        : ArrayBuffer.isView(d)
          ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)
          : null;
    if (data) {
      const msg: PtyPortMessage = { type: "data", data: data as ArrayBuffer };
      port1.postMessage(msg); // no transfer list
    }
  };
  sock.onclose = (ev) => {
    const msg: PtyPortMessage = {
      type: "exit",
      exitCode: null,
      reason: ev.reason || `close ${ev.code}`,
    };
    port1.postMessage(msg);
    port1.close();
  };
  sock.onerror = () => {
    /* onclose follows */
  };

  // The renderer fires resize/data the moment the terminal mounts — usually
  // before the WS finishes connecting. Queue outbound traffic until open.
  let sockOpen = false;
  const outbox: Array<string | Uint8Array> = [];
  const sendNow = (data: string | Uint8Array): void => {
    try {
      sock.send(data);
    } catch {
      // socket closed/closing — the exit path already told the renderer
    }
  };
  const send = (data: string | Uint8Array): void => {
    if (sockOpen) sendNow(data);
    else outbox.push(data);
  };
  sock.onopen = () => {
    sockOpen = true;
    for (const data of outbox) sendNow(data);
    outbox.length = 0;
  };

  port1.onmessage = (e: MessageEvent) => {
    const m = e.data as PtyPortMessage | null;
    if (m?.type === "data" && m.data) {
      send(new Uint8Array(m.data));
    } else if (m?.type === "resize") {
      send(JSON.stringify({ type: "resize", cols: m.cols, rows: m.rows }));
    } else if (m?.type === "close") {
      try {
        sock.close(1000, "client close");
      } catch {
        // already closed
      }
    }
  };
  return port2;
}

// ---- persistence (localStorage; same shallow-merge semantics as main) -------

function loadPersistedState(): PersistedState {
  const raw = storage()?.getItem(PERSISTED_KEY);
  if (!raw) return { ...EMPTY_PERSISTED };
  try {
    return {
      ...EMPTY_PERSISTED,
      ...(JSON.parse(raw) as Partial<PersistedState>),
    };
  } catch {
    return { ...EMPTY_PERSISTED };
  }
}

function savePersistedState(patch: Partial<PersistedState>): void {
  // shallow TOP-LEVEL merge — a patch key replaces that entire record
  storage()?.setItem(
    PERSISTED_KEY,
    JSON.stringify({ ...loadPersistedState(), ...patch }),
  );
}

// ---- the bridge --------------------------------------------------------------

type SocketInit = { protocols?: string[]; headers?: Record<string, string> };

/** Test seams only — production callers pass just the config. */
export type WsBridgeOptions = {
  createSocket?: (url: string, init: SocketInit) => WsLike;
  createPtySocket?: (url: string, init: SocketInit) => PtyWsLike;
  schedule?: (flush: () => void) => void;
  fetch?: typeof fetch;
};

export function createWsBridge(
  cfg: WsConfig,
  opts: WsBridgeOptions = {},
): AgenaBridge {
  let client: AgenaClient | null = null;
  const branchIds = new Map<string, string>(); // sessionId → branchId (subscribe acks)
  const batchSubs = new Set<(b: UiBatch) => void>();
  const statusSubs = new Set<
    (s: BridgeConnectionState, detail?: string) => void
  >();
  const batcher = createUiBatcher((b) => {
    for (const cb of batchSubs) cb(b);
  }, opts.schedule);

  const rawSocket =
    opts.createSocket ??
    ((url: string, init: SocketInit): WsLike =>
      new WebSocket(url, init.protocols) as unknown as WsLike);
  const rawPtySocket =
    opts.createPtySocket ??
    ((url: string, init: SocketInit): PtyWsLike =>
      new WebSocket(url, init.protocols) as unknown as PtyWsLike);

  const need = (): AgenaClient => {
    if (!client) {
      throw bridgeError(
        "DISCONNECTED",
        "not connected — call connect() first",
        true,
      );
    }
    return client;
  };

  const connect = async (profileName?: string): Promise<ConnectedInfo> => {
    // Every renderer (re)load calls connect(). Subscriptions/replay are
    // renderer state and the daemon rejects duplicate subscribes per WS
    // connection (ALREADY_SUBSCRIBED) — so each connect() starts fresh.
    if (client) {
      await client.close().catch(() => {});
      client = null;
      branchIds.clear();
    }
    const clientId = loadClientId();
    const c = new AgenaClient({
      url: cfg.url,
      token: cfg.token,
      clientId,
      clientName: "agena-desktop-web",
      clientVersion: "0.1.0",
      platform: "web",
      socketAuth: "ticket",
      createSocket: rawSocket,
      createPtySocket: rawPtySocket,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    c.onEvent = (event, replayed) => batcher.pushEvent(event, replayed);
    c.onFrame = (f) => batcher.pushFrame(f);
    c.onSync = (sessionId, upToSeq) =>
      batcher.pushSync({
        sessionId,
        branchId: branchIds.get(sessionId) ?? "",
        upToSeq,
      });
    c.onSnapshot = (snapshot) => batcher.pushSnapshot(snapshot);
    c.onSessionLost = (sessionId) => batcher.pushLostSession(sessionId);
    c.onStatus = (state, detail) => {
      for (const cb of statusSubs) cb(state, detail);
    };
    client = c;
    const welcome = await c.connect();
    return {
      profile: profileName ?? "browser",
      url: cfg.url,
      daemonVersion: welcome.daemonVersion,
      protocolVersion: welcome.protocolVersion,
      clientId,
    };
  };

  const rejectDesktopOnly = (method: string) => (): Promise<never> =>
    Promise.reject(desktopOnlyError(method));

  const bridge: AgenaBridge = {
    // lifecycle
    listProfiles: async () => [
      { name: "browser", url: cfg.url, isDefault: true },
    ],
    connect,
    disconnect: async () => {
      await client?.close();
      client = null;
      branchIds.clear();
    },

    // WS commands
    subscribe: async (sessionId, fromSeq) => {
      const ack = await need().subscribe(sessionId, fromSeq);
      branchIds.set(sessionId, ack.branchId);
      return ack;
    },
    prompt: (sessionId, text) => need().prompt(sessionId, text),
    steer: (sessionId, text) => need().steer(sessionId, text),
    followUp: (sessionId, text) => need().followUp(sessionId, text),
    abort: (sessionId, reason) => need().abort(sessionId, reason),
    respondToApproval: (sessionId, approvalId, response) =>
      need().respondToApproval(sessionId, approvalId, response),
    runtimeInfo: (sessionId) => need().runtimeInfo(sessionId),
    setModel: (sessionId, model) => need().setModel(sessionId, model),
    setFastMode: (sessionId, enabled) => need().setFastMode(sessionId, enabled),
    setThinkingLevel: (sessionId, thinkingLevel) =>
      need().setThinkingLevel(sessionId, thinkingLevel),
    compact: (sessionId) => need().compact(sessionId),

    // HTTP
    createSession: (input) => need().createSession(input ?? {}),
    forkSession: async (sourceSessionId, sourceMessageId, mode) => ({
      sessionId: await need().forkSession(
        sourceSessionId,
        sourceMessageId,
        mode,
      ),
    }),
    navigateSession: (sessionId, sourceMessageId) =>
      need().navigateSession(sessionId, sourceMessageId),
    createProject: async (name) => ({
      ...(await need().createProject(name)),
      fileCount: 0,
    }),
    deleteProject: (projectId) => need().deleteProject(projectId),
    listSessionSummaries: (filters) =>
      need().listSessionSummaries(filters ?? {}),
    updateSessionStatus: (sessionId, status) =>
      need().updateSessionStatus(sessionId, status),
    readEvents: (sessionId, o) => need().readEvents(sessionId, o ?? {}),
    listUserMessages: (sessionId) => need().listUserMessages(sessionId),
    search: (query, o) => need().search(query, o ?? {}),
    listApprovals: () => need().listApprovals(),
    listFiles: (o) => need().listFiles(o ?? {}),
    readFile: (path) => need().readFile(path),
    uploadImage: (bytes, mimeType) => need().uploadImage(bytes, mimeType),
    readBlob: (hash) => need().readBlob(hash),
    listSnapshots: () => need().listSnapshots(),
    createSnapshot: (input) => need().createSnapshot(input ?? {}),
    restoreSnapshot: (snapshotId, input) =>
      need().restoreSnapshot(snapshotId, input ?? {}),
    deleteSnapshot: (snapshotId) => need().deleteSnapshot(snapshotId),
    diagnostics: () => need().diagnostics(),
    createPairing: (daemonUrl) => need().createPairing(daemonUrl),
    listPtys: () => need().listPtys(),
    listPlugins: async () => (await need().listPlugins()).plugins,
    installPlugin: async (id) => (await need().installPlugin(id)).plugin,
    updatePlugin: async (id) => (await need().updatePlugin(id)).plugin,
    setPluginEnabled: async (id, enabled) =>
      (await need().setPluginEnabled(id, enabled)).plugin,
    removePlugin: async (id) => (await need().removePlugin(id)).plugin,
    listProviders: async () => (await need().listProviders()).providers,
    saveProviderApiKey: async (id, input) =>
      (await need().saveProviderApiKey(id, input)).provider,
    removeProviderAuth: async (id) =>
      (await need().removeProviderAuth(id)).provider,
    startProviderOAuth: async (id) => {
      const status = await need().startProviderOAuth(id);
      const interaction = status.interaction;
      const url =
        interaction?.kind === "auth_url"
          ? interaction.url
          : interaction?.kind === "device_code"
            ? interaction.verificationUri
            : null;
      if (url) window.open(url, "_blank", "noopener");
      return status;
    },
    providerOAuthStatus: (flowId) => need().providerOAuthStatus(flowId),
    respondProviderOAuth: (flowId, input) =>
      need().respondProviderOAuth(flowId, input),

    // local-session import: scans/conversion need the host filesystem (Electron
    // main); only the daemon-side ledger is reachable from a browser.
    importScan: rejectDesktopOnly("importScan"),
    importRun: rejectDesktopOnly("importRun"),
    importStatus: () => need().listImports(loadClientId()),

    // MCP / skill management (daemon-backed parts work; host scans do not)
    mcpImportScan: rejectDesktopOnly("mcpImportScan"),
    mcpImportRun: rejectDesktopOnly("mcpImportRun"),
    mcpImportStatus: async () => {
      const mcps = await need().listMcps();
      return {
        mcps: mcps.map(
          (mcp): ImportedMcp => ({
            id: mcp.id,
            identity: mcp.identity,
            name: mcp.name,
            status:
              mcp.status === "needs_auth"
                ? "needs_authorization"
                : mcp.status === "error"
                  ? "error"
                  : mcp.status === "connected"
                    ? "ready"
                    : "imported",
          }),
        ),
      };
    },
    mcpAuthStart: async (mcpId) => {
      const { authorizationUrl } = await need().startMcpOAuth(mcpId);
      if (!authorizationUrl) {
        throw bridgeError(
          "INTERNAL",
          "daemon did not return an authorization URL",
        );
      }
      // Fire-and-forget per contract: resolve once the browser tab is open;
      // poll mcpImportStatus() to observe the status change.
      window.open(authorizationUrl, "_blank", "noopener");
    },
    skillImportScan: rejectDesktopOnly("skillImportScan"),
    skillImportRun: rejectDesktopOnly("skillImportRun"),
    skillImportStatus: async (o) => {
      const skills = o?.refresh
        ? await need().checkSkillUpdates()
        : await need().listSkills();
      // Source url/path/revision stay daemon-side (secret-free view).
      // ponytail: identity passes through unhashed — the Electron host digests
      // it to hide THIS machine's paths, and a browser client has none to hide.
      return {
        skills: skills.map(
          (skill): ImportedSkill => ({
            id: skill.id,
            identity: skill.identity,
            contentHash: skill.contentHash,
            name: skill.name,
            status: skill.status,
          }),
        ),
      };
    },
    skillUpdate: async (skillId) => {
      await need().updateSkill(skillId);
    },

    // streams
    onBatch: (cb) => {
      batchSubs.add(cb);
      return () => batchSubs.delete(cb);
    },
    onStatus: (cb) => {
      statusSubs.add(cb);
      return () => statusSubs.delete(cb);
    },

    // terminals
    openPty: async (o) => {
      const att = await need().openPty({
        cols: o.cols ?? 80,
        rows: o.rows ?? 24,
        ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
        ...(o.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
        ...(o.command !== undefined ? { command: o.command } : {}),
        ...(o.args !== undefined ? { args: o.args } : {}),
      });
      return { ptyId: att.ptyId, port: wirePtyPort(att.socket) };
    },

    // persistence
    loadPersisted: async () => loadPersistedState(),
    savePersisted: async (patch) => savePersistedState(patch ?? {}),

    // local-machine-only surfaces: no native picker / WebContentsView here
    openProjectFolder: rejectDesktopOnly("openProjectFolder"),
    openWorkspaceFile: rejectDesktopOnly("openWorkspaceFile"),
    browserOpen: rejectDesktopOnly("browserOpen"),
    browserNavigate: rejectDesktopOnly("browserNavigate"),
    browserSetBounds: rejectDesktopOnly("browserSetBounds"),
    browserSetVisible: rejectDesktopOnly("browserSetVisible"),
    browserOpenDevTools: rejectDesktopOnly("browserOpenDevTools"),
    browserOpenExternal: rejectDesktopOnly("browserOpenExternal"),
    browserClose: rejectDesktopOnly("browserClose"),
    onBrowserState: () => () => {}, // never fires — there is no embedded browser host
  };

  // pickFolder/readFolder live on AgenaShell, not AgenaBridge, but reject the
  // same way if some caller reaches for them on this object.
  Object.assign(bridge as object, {
    pickFolder: rejectDesktopOnly("pickFolder"),
    readFolder: rejectDesktopOnly("readFolder"),
  });

  return withBridgeErrors(bridge);
}

/**
 * Every method's failure is normalized to a BridgeError-shaped REJECTION (§4)
 * — sync throws (e.g. need() before connect) become rejections too, matching
 * the always-async preload transport. The on* subscriptions never throw and
 * pass their unsubscribe functions through untouched.
 */
function withBridgeErrors(bridge: AgenaBridge): AgenaBridge {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bridge)) {
    out[key] =
      typeof value === "function" && !key.startsWith("on")
        ? (...args: unknown[]) => {
            try {
              const result = (value as (...a: unknown[]) => unknown)(...args);
              return result instanceof Promise
                ? result.catch((err) => {
                    throw toBridgeError(err);
                  })
                : result;
            } catch (err) {
              return Promise.reject(toBridgeError(err));
            }
          }
        : value;
  }
  return out as unknown as AgenaBridge;
}
