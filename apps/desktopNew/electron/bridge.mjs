// Real AgenaBridge host: @agena/client lives HERE (main process, D-INV-2 —
// the token never enters the renderer). Electron's Node (≥22.18) type-strips
// the workspace .ts imports directly; no bundle step.
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AgenaClient, parsePtyExit, ulid } from "@agena/client";
import { EMPTY_PERSISTED } from "../src/shared/bridge.ts";
import { createBrowserHost } from "./browser-host.mjs";
import { importMcps, scanMcps } from "./importer/mcp.mjs";
import { runImport } from "./importer/run.mjs";
import { scanImports } from "./importer/scan.mjs";
import {
  importSkills,
  publicSkillIdentity,
  scanSkills,
} from "./importer/skills.mjs";
import { createTunnelPool, parseLocalPort } from "./tunnel.mjs";
import {
  assertNoCredentialedGitRemotes,
  shouldSkipUploadName,
  shouldSkipUploadPath,
} from "./upload-policy.mjs";

const FLUSH_MS = 16; // one renderer frame per UiBatch (§5.1 of docs/desktop_plan.md)
const OPENED_FILE_TTL_MS = 10 * 60 * 1000;

export function createBridgeHost({
  url,
  token,
  userData,
  broadcast,
  getWindow,
  notify,
}) {
  let client = null;
  let oauthServer = null;
  const openedProviderInteractions = new Set();
  const providerCallbackServers = new Map();
  const openedFileTemps = new Map();
  const removeOpenedFileTemp = async (dir) => {
    const timer = openedFileTemps.get(dir);
    if (timer) clearTimeout(timer);
    openedFileTemps.delete(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  const bindProviderCallback = async (flowId, authorizationUrl) => {
    if (providerCallbackServers.has(flowId)) return;
    const auth = new URL(authorizationUrl);
    const redirect = auth.searchParams.get("redirect_uri");
    if (!redirect) return;
    const callback = new URL(redirect);
    if (
      callback.protocol !== "http:" ||
      (callback.hostname !== "localhost" && callback.hostname !== "127.0.0.1")
    )
      return;
    const server = createServer(async (req, res) => {
      try {
        const status = await need().providerOAuthStatus(flowId);
        const prompt = status.interaction;
        if (prompt?.kind !== "prompt" || prompt.inputKind !== "manual_code")
          throw new Error("provider is not waiting for its browser callback");
        await need().respondProviderOAuth(flowId, {
          action: "respond",
          interactionId: prompt.interactionId,
          value: `${callback.origin}${req.url ?? callback.pathname}`,
        });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          "<h1>Authorization complete</h1><p>This provider is ready in Agena.</p>",
        );
      } catch (error) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end(
          error instanceof Error ? error.message : "Authorization failed",
        );
      } finally {
        server.close();
        providerCallbackServers.delete(flowId);
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(callback.port), "127.0.0.1", resolve);
    });
    providerCallbackServers.set(flowId, server);
  };

  const surfaceProviderOAuth = async (status) => {
    const interaction = status?.interaction;
    if (
      !interaction ||
      openedProviderInteractions.has(interaction.interactionId)
    )
      return status;
    const target =
      interaction.kind === "auth_url"
        ? interaction.url
        : interaction.kind === "device_code"
          ? interaction.verificationUri
          : null;
    if (target) {
      const url = new URL(target);
      const localhost =
        url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && localhost))
        throw new Error(
          `refusing to open non-https authorization URL (${url.protocol}//)`,
        );
      openedProviderInteractions.add(interaction.interactionId);
      if (interaction.kind === "auth_url")
        await bindProviderCallback(status.flowId, target).catch(() => {});
      const { shell } = await import("electron");
      await shell.openExternal(target);
    }
    return status;
  };

  const beginSystemOAuth = async (authorizationUrl, complete) => {
    // SECURITY: the authorization URL comes from the MCP server (agent /
    // daemon influenced). shell.openExternal launches the OS handler for ANY
    // scheme (file:, smb:, app-registered) — only real web URLs may pass.
    // Single choke point: covers startMcpOAuth and openExternalOAuth alike.
    const u = new URL(authorizationUrl);
    const localhost = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && localhost)) {
      throw new Error(
        `refusing to open non-https authorization URL (${u.protocol}//)`,
      );
    }
    if (oauthServer)
      throw new Error("another MCP authorization is in progress");
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    oauthServer = createServer(async (req, res) => {
      const redirectUrl = `http://127.0.0.1:19876${req.url ?? "/"}`;
      try {
        await complete(redirectUrl);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          "<h1>Authorization complete</h1><p>This MCP is ready in Agena.</p>",
        );
        resolveCompletion();
      } catch (error) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Agena could not complete this authorization.");
        rejectCompletion(error);
      } finally {
        oauthServer?.close();
        oauthServer = null;
      }
    });
    await new Promise((resolve, reject) => {
      oauthServer.once("error", reject);
      oauthServer.listen(19876, "127.0.0.1", resolve);
    });
    const { shell } = await import("electron");
    await shell.openExternal(authorizationUrl);
    return { completion };
  };

  const startMcpOAuth = async (mcpId) => {
    const result = await need().startMcpOAuth(mcpId);
    if (!result.authorizationUrl)
      throw new Error("daemon did not return an authorization URL");
    const { completion } = await beginSystemOAuth(
      result.authorizationUrl,
      (redirectUrl) => need().completeMcpOAuth(mcpId, { redirectUrl }),
    );
    void completion.catch((error) =>
      console.error("MCP OAuth completion failed", error),
    );
  };

  // ---- embedded browser: tunnel pool + WebContentsView host -----------------
  const tunnelPool = createTunnelPool({ url, token });
  const browserHost = createBrowserHost({
    getWindow: getWindow ?? (() => null),
    broadcast,
    partition: "persist:agena-browse",
  });
  const resolveBrowserUrl = async (rawUrl) => {
    const port = parseLocalPort(rawUrl);
    if (port === null) return rawUrl;
    const local = await tunnelPool.ensureTunnel(port);
    const u = new URL(rawUrl);
    return `${local}${u.pathname}${u.search}${u.hash}`;
  };
  const openBrowserUrl = async (rawUrl, opts) => {
    const target = await resolveBrowserUrl(rawUrl);
    await browserHost.open(target, { newTab: opts?.newTab ?? false });
    return target;
  };
  let connectedInfo = null;
  const branchIds = new Map(); // sessionId → branchId (from subscribe acks)

  // ---- persistence (userData/persisted.json) --------------------------------
  const persistedPath = join(userData, "persisted.json");
  let persisted = null;
  const loadPersisted = async () => {
    if (!persisted) {
      try {
        persisted = {
          ...EMPTY_PERSISTED,
          ...JSON.parse(await readFile(persistedPath, "utf8")),
        };
      } catch {
        persisted = { ...EMPTY_PERSISTED };
      }
    }
    return persisted;
  };
  const savePersisted = async (patch) => {
    const base = await loadPersisted();
    persisted = { ...base, ...patch };
    await mkdir(userData, { recursive: true });
    await writeFile(persistedPath, JSON.stringify(persisted, null, 2));
  };

  // Desktop-installation clientId (P3: distinct from the CLI's ~/.config id).
  const clientIdPath = join(userData, "client-id");
  const loadClientId = async () => {
    try {
      const id = (await readFile(clientIdPath, "utf8")).trim();
      if (id) return id;
    } catch {
      // first run
    }
    const id = ulid();
    await mkdir(userData, { recursive: true });
    await writeFile(clientIdPath, `${id}\n`);
    return id;
  };

  // ---- UiBatch batcher -------------------------------------------------------
  let buf = null;
  let timer = null;
  const textKeys = new Map(); // coalesce target → index into buf.frames
  const toolKeys = new Map();
  const ensureBuf = () => {
    if (!buf) {
      buf = {
        events: [],
        frames: [],
        syncs: [],
        snapshots: [],
        lostSessions: [],
      };
    }
    return buf;
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const b = buf;
      buf = null;
      textKeys.clear();
      toolKeys.clear();
      if (b) broadcast("agena:batch", b);
    }, FLUSH_MS);
  };
  const pushFrame = (f) => {
    const b = ensureBuf();
    if (f.type === "message.assistant.text.delta") {
      const p = f.payload;
      const key = `${f.sessionId}\0${p.messageId}\0${p.blockIndex}`;
      const at = textKeys.get(key);
      const prev = at === undefined ? undefined : b.frames[at];
      if (prev) {
        prev.payload = { ...p, delta: prev.payload.delta + p.delta };
        prev.afterSeq = f.afterSeq;
        return;
      }
      textKeys.set(key, b.frames.push(f) - 1);
      return;
    }
    if (f.type === "tool.call.output.delta") {
      const p = f.payload;
      const key = `${f.sessionId}\0${p.toolCallId}`;
      const at = toolKeys.get(key);
      const prev = at === undefined ? undefined : b.frames[at];
      if (prev && !p.reset) {
        prev.payload = { ...p, delta: prev.payload.delta + p.delta };
        prev.afterSeq = f.afterSeq;
        return;
      }
      if (prev && p.reset) {
        // reset discards the accumulation and starts over (§5.1 rule 3)
        b.frames[at] = f;
        return;
      }
      toolKeys.set(key, b.frames.push(f) - 1);
      return;
    }
    b.frames.push(f);
  };

  // ---- connection ------------------------------------------------------------
  const connect = async (profileName) => {
    // Every renderer (re)load calls connect(). Subscriptions and replay are
    // renderer state, and the daemon rejects duplicate subscribes per WS
    // connection (ALREADY_SUBSCRIBED) — so each connect() starts a fresh
    // client: the daemon replays events and resends in-flight snapshots.
    if (client) {
      await client.close().catch(() => {});
      client = null;
      connectedInfo = null;
      branchIds.clear();
    }
    const clientId = await loadClientId();
    client = new AgenaClient({
      url,
      token,
      clientId,
      clientName: "agena-desktop",
      clientVersion: "0.0.0",
    });
    client.onEvent = (event, replayed) => {
      notify?.(event, replayed);
      ensureBuf().events.push({ event, replayed });
      schedule();
    };
    client.onFrame = (f) => {
      pushFrame(f);
      schedule();
    };
    client.onSync = (sessionId, upToSeq) => {
      ensureBuf().syncs.push({
        sessionId,
        branchId: branchIds.get(sessionId) ?? "",
        upToSeq,
      });
      schedule();
    };
    client.onSnapshot = (snapshot) => {
      ensureBuf().snapshots.push(snapshot);
      schedule();
    };
    client.onSessionLost = (sessionId) => {
      ensureBuf().lostSessions.push(sessionId);
      schedule();
    };
    client.onVisibleBrowserRequest = async (action) => {
      if (action.action === "openExternalOAuth") {
        const listed = await need().listMcps();
        const mcps = Array.isArray(listed) ? listed : listed.mcps;
        const mcp = mcps.find((item) => item.name === action.serverName);
        if (!mcp) throw new Error(`MCP "${action.serverName}" is not imported`);
        const { completion } = await beginSystemOAuth(
          action.url,
          (redirectUrl) => need().completeMcpOAuth(mcp.id, { redirectUrl }),
        );
        await completion;
        return { url: action.url, title: "OAuth complete", value: true };
      }
      if (action.action === "open") {
        const target = await resolveBrowserUrl(action.url);
        return browserHost.agentRequest({ ...action, url: target });
      }
      if (action.action === "navigate" && action.kind === "url" && action.url) {
        const target = await resolveBrowserUrl(action.url);
        return browserHost.agentRequest({ ...action, url: target });
      }
      return browserHost.agentRequest(action);
    };
    client.onStatus = (state, detail) =>
      broadcast("agena:status", { state, detail });
    const welcome = await client.connect();
    connectedInfo = {
      profile: profileName ?? "local",
      url,
      daemonVersion: welcome.daemonVersion,
      protocolVersion: welcome.protocolVersion,
      clientId,
    };
    return connectedInfo;
  };

  const need = () => {
    if (!client) {
      const err = new Error("not connected — call connect() first");
      err.code = "DISCONNECTED";
      err.retryable = true;
      throw err;
    }
    return client;
  };

  const createProject = async (name) => {
    const project = await need().createProject(name);
    return { ...project, fileCount: 0 };
  };

  // ---- open project: pick (main.mjs supplies) + copy INTO the workspace ------
  const openProjectFolder = async (pickFolder) => {
    const src = await pickFolder();
    if (!src) return null;
    const name = (
      src.replace(/\/+$/, "").split("/").pop() ?? "project"
    ).replace(/[^A-Za-z0-9._-]+/g, "-");
    const project = await need().createProject(name);
    const tar = await tarFolder(src);
    let uploaded;
    try {
      uploaded = await need().uploadFiles(
        { path: project.projectRoot, format: "tar" },
        tar.body,
      );
    } catch (err) {
      tar.child.kill();
      throw err;
    } finally {
      await tar.cleanup();
    }
    return {
      ...project,
      fileCount: uploaded.fileCount,
    };
  };

  // ---- PTY: client WS ↔ MessagePortMain (bytes stay off the invoke channel) --
  const openPty = async (opts, makePorts, sendPort) => {
    const att = await need().openPty(opts ?? {});
    const { port1, port2 } = makePorts();
    const sock = att.socket;
    sock.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === "string") {
        const exitCode = parsePtyExit(d);
        if (exitCode !== undefined) {
          port1.postMessage({ type: "exit", exitCode });
        }
        return;
      }
      const data =
        d instanceof ArrayBuffer
          ? d
          : ArrayBuffer.isView(d)
            ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)
            : null;
      if (data) port1.postMessage({ type: "data", data });
    };
    sock.onclose = (ev) => {
      port1.postMessage({
        type: "exit",
        exitCode: null,
        reason: ev.reason || `close ${ev.code}`,
      });
      port1.close();
    };
    sock.onerror = () => {
      /* onclose follows */
    };
    // The renderer fires resize/data the moment the terminal mounts — often
    // before the WS finishes connecting (remote daemons make this race a
    // certainty: "InvalidStateError: Sent before connected", which is fatal in
    // main). Queue outbound traffic until open; drop it if the socket dies.
    let sockOpen = false;
    const outbox = [];
    const sendNow = (data) => {
      try {
        sock.send(data);
      } catch {
        // socket closed/closing — the exit path already told the renderer
      }
    };
    const send = (data) => {
      if (sockOpen) sendNow(data);
      else outbox.push(data);
    };
    sock.onopen = () => {
      sockOpen = true;
      for (const data of outbox) sendNow(data);
      outbox.length = 0;
    };
    port1.on("message", (e) => {
      const m = e.data;
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
    });
    port1.start();
    sendPort(att.ptyId, port2);
    return { ptyId: att.ptyId };
  };

  // ---- the invoke surface ------------------------------------------------------
  const call = async (method, args, ctx) => {
    switch (method) {
      case "listProfiles":
        return [{ name: "local", url, isDefault: true }];
      case "connect":
        return connect(args[0]);
      case "disconnect":
        await client?.close();
        client = null;
        connectedInfo = null;
        return undefined;
      case "subscribe": {
        const ack = await need().subscribe(args[0], args[1]);
        branchIds.set(args[0], ack.branchId);
        return ack;
      }
      case "prompt":
      case "steer":
      case "followUp":
        return need()[method](args[0], args[1]);
      case "abort":
        return need().abort(args[0], args[1]);
      case "respondToApproval":
        return need().respondToApproval(args[0], args[1], args[2]);
      case "runtimeInfo":
        return need().runtimeInfo(args[0]);
      case "setModel":
        return need().setModel(args[0], args[1]);
      case "setFastMode":
        return need().setFastMode(args[0], args[1]);
      case "setThinkingLevel":
        return need().setThinkingLevel(args[0], args[1]);
      case "compact":
        return need().compact(args[0]);
      case "createSession":
        return need().createSession(args[0]);
      case "forkSession":
        return {
          sessionId: await need().forkSession(args[0], args[1], args[2]),
        };
      case "createQuickChat":
        return { sessionId: await need().createQuickChat(args[0]) };
      case "navigateSession":
        return need().navigateSession(args[0], args[1]);
      case "createProject":
        return createProject(args[0]);
      case "deleteProject":
        return need().deleteProject(args[0]);
      case "listSessionSummaries":
        return need().listSessionSummaries(args[0] ?? {});
      case "updateSessionStatus":
        return need().updateSessionStatus(args[0], args[1]);
      case "readEvents":
        return need().readEvents(args[0], args[1] ?? {});
      case "listUserMessages":
        return need().listUserMessages(args[0]);
      case "search":
        return need().search(args[0], args[1] ?? {});
      case "listApprovals":
        return need().listApprovals();
      case "listFiles":
        return need().listFiles(args[0] ?? {});
      case "readFile":
        return need().readFile(args[0]);
      case "uploadImage":
        return need().uploadImage(args[0], args[1]);
      case "readBlob":
        return need().readBlob(args[0]);
      case "openWorkspaceFile": {
        const path = args[0];
        if (
          typeof path !== "string" ||
          !path.startsWith("/workspace/") ||
          posix.normalize(path) !== path
        ) {
          throw new Error("workspace file path must stay under /workspace");
        }
        const dir = await mkdtemp(join(tmpdir(), "agena-open-"));
        try {
          const target = join(dir, basename(path));
          await writeFile(target, await need().readFile(path), { mode: 0o600 });
          const { shell } = await import("electron");
          const error = await shell.openPath(target);
          if (error) throw new Error(error);
          const timer = setTimeout(
            () => void removeOpenedFileTemp(dir),
            OPENED_FILE_TTL_MS,
          );
          timer.unref();
          openedFileTemps.set(dir, timer);
        } catch (error) {
          await removeOpenedFileTemp(dir);
          throw error;
        }
        return;
      }
      case "listSnapshots":
        return need().listSnapshots();
      case "createSnapshot":
        return need().createSnapshot(args[0] ?? {});
      case "restoreSnapshot":
        return need().restoreSnapshot(args[0], args[1] ?? {});
      case "deleteSnapshot":
        return need().deleteSnapshot(args[0]);
      case "diagnostics":
        return need().diagnostics();
      case "createPairing":
        return need().createPairing(args[0]);
      case "listPtys":
        return need().listPtys();
      case "openProjectFolder":
        return openProjectFolder(ctx.pickFolder);
      case "openPty":
        return openPty(args[0], ctx.makePorts, ctx.sendPort);
      case "loadPersisted":
        return loadPersisted();
      case "savePersisted":
        return savePersisted(args[0] ?? {});
      case "browserOpen": {
        const rawUrl = args[0];
        return openBrowserUrl(rawUrl, args[1]);
      }
      case "browserNavigate":
        return browserHost.navigate(args[0]);
      case "browserSetBounds":
        return browserHost.setBounds(args[0]);
      case "browserSetVisible":
        return browserHost.setVisible(args[0]);
      case "browserOpenDevTools":
        return browserHost.openDevTools();
      case "browserOpenExternal":
        return browserHost.openExternal();
      case "browserClose":
        return browserHost.close();
      case "importScan":
        return scanImports({ userData, refresh: args[0]?.refresh });
      case "importRun":
        return runImport(args[0], {
          client: need(),
          machineId: await loadClientId(),
          userData,
        });
      case "importStatus":
        return need().listImports(await loadClientId());
      case "mcpImportScan":
        return scanMcps({ refresh: args[0]?.refresh });
      case "mcpImportRun":
        return importMcps(args[0], need());
      case "mcpImportStatus": {
        const result = await need().listMcps();
        const mcps = Array.isArray(result) ? result : result.mcps;
        return {
          mcps: mcps.map((mcp) => ({
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
          })),
        };
      }
      case "mcpAuthStart":
        return startMcpOAuth(args[0]);
      case "listPlugins": {
        const result = await need().listPlugins();
        return result.plugins;
      }
      case "installPlugin": {
        const result = await need().installPlugin(args[0]);
        return result.plugin;
      }
      case "updatePlugin": {
        const result = await need().updatePlugin(args[0]);
        return result.plugin;
      }
      case "setPluginEnabled": {
        const result = await need().setPluginEnabled(args[0], args[1]);
        return result.plugin;
      }
      case "removePlugin": {
        const result = await need().removePlugin(args[0]);
        return result.plugin;
      }
      case "listProviders": {
        const result = await need().listProviders();
        return result.providers;
      }
      case "saveProviderApiKey": {
        const result = await need().saveProviderApiKey(args[0], args[1]);
        return result.provider;
      }
      case "removeProviderAuth": {
        const result = await need().removeProviderAuth(args[0]);
        return result.provider;
      }
      case "startProviderOAuth":
        return surfaceProviderOAuth(await need().startProviderOAuth(args[0]));
      case "providerOAuthStatus":
        return surfaceProviderOAuth(await need().providerOAuthStatus(args[0]));
      case "respondProviderOAuth":
        return surfaceProviderOAuth(
          await need().respondProviderOAuth(args[0], args[1]),
        );
      case "skillImportScan": {
        const local = await scanImports({ userData });
        return scanSkills({
          refresh: args[0]?.refresh,
          projectRoots: local.projects
            .filter((project) => project.exists)
            .map((project) => project.cwd),
        });
      }
      case "skillImportRun":
        return importSkills(args[0], need());
      case "skillImportStatus": {
        const listed = args[0]?.refresh
          ? await need().checkSkillUpdates()
          : await need().listSkills();
        const skills = Array.isArray(listed) ? listed : listed.skills;
        return {
          skills: skills.map((skill) => {
            const { sourceUrl, sourcePath, sourceRevision, ...safe } = skill;
            void sourceUrl;
            void sourcePath;
            void sourceRevision;
            return { ...safe, identity: publicSkillIdentity(skill.identity) };
          }),
        };
      }
      case "skillUpdate":
        await need().updateSkill(args[0]);
        return;
      default: {
        const err = new Error(`unknown bridge method "${method}"`);
        err.code = "INVALID_PAYLOAD";
        throw err;
      }
    }
  };

  return {
    call,
    dispose: async () => {
      oauthServer?.close();
      for (const server of providerCallbackServers.values()) server.close();
      providerCallbackServers.clear();
      browserHost.close();
      tunnelPool.closeAll();
      await Promise.all([...openedFileTemps.keys()].map(removeOpenedFileTemp));
      await client?.close().catch(() => {});
      client = null;
    },
  };
}

// ---- helpers -------------------------------------------------------------------

// Exported for importer/run.mjs (§8 step 2 reuses the same tar + skip-list).
export async function tarFolder(src, { includeGit = false } = {}) {
  if (includeGit) await rejectCredentialedGitRemote(src);
  const tmp = await mkdtemp(join(tmpdir(), "agena-upload-"));
  const archive = join(tmp, "upload.tar");
  await pipeline(
    Readable.from(tarStream(src, includeGit)),
    createWriteStream(archive),
  );
  // Buffer, don't stream: a stream body sends Transfer-Encoding: chunked,
  // which Modal's ingress proxy (aiohttp) cannot forward — it 500s before the
  // daemon sees the request. A buffer sends Content-Length and works through
  // every path. The tar is already source-only (SKIPPED_UPLOAD_NAMES).
  const body = await readFile(archive);
  return {
    child: {
      kill() {
        // body is fully buffered; nothing in flight to cancel
      },
    },
    body,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}

const SKIPPED_UPLOAD_NAMES = new Set([
  "node_modules",
  ".venv",
  "venv",
  ".git",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".turbo",
  "dist",
  "build",
  ".build",
  ".next",
  "coverage",
  "__pycache__",
  ".DS_Store",
]);

async function* tarStream(root, includeGit) {
  for await (const file of walkFiles(root, ".", includeGit)) {
    const info = await lstat(file.absolute);
    if (!info.isFile()) continue;
    yield tarHeader(file.relative, info.size, info.mode, info.mtime);
    if (info.size > 0) {
      yield* createReadStream(file.absolute, { start: 0, end: info.size - 1 });
    }
    const padding = (512 - (info.size % 512)) % 512;
    if (padding) yield Buffer.alloc(padding);
  }
  yield Buffer.alloc(1024);
}

async function* walkFiles(root, dir = ".", includeGit = false) {
  const handle = await opendir(join(root, dir));
  for await (const entry of handle) {
    if (shouldSkipUploadName(entry.name, includeGit, SKIPPED_UPLOAD_NAMES)) {
      continue;
    }
    const relative = dir === "." ? entry.name : join(dir, entry.name);
    const archivePath = relative.replaceAll("\\", "/");
    if (shouldSkipUploadPath(archivePath)) continue;
    const absolute = join(root, relative);
    if (entry.isDirectory()) {
      yield* walkFiles(root, relative, includeGit);
    } else if (entry.isFile()) {
      yield { absolute, relative: archivePath };
    }
  }
}

async function rejectCredentialedGitRemote(root) {
  let config;
  try {
    config = await readFile(join(root, ".git", "config"), "utf8");
  } catch {
    return;
  }
  assertNoCredentialedGitRemotes(config);
}

function tarHeader(path, size, mode, mtime) {
  const { name, prefix } = splitTarPath(path);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode & 0o777);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(mtime.getTime() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0").slice(-6), 148, 6);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  const parts = path.split("/");
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`path too long to upload: ${path}`);
}

function writeString(header, offset, length, value) {
  header.write(value, offset, length, "utf8");
}

function writeOctal(header, offset, length, value) {
  const text = Math.trunc(value)
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  header.write(text, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}
