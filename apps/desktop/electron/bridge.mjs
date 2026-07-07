// Real AgenaBridge host: @agena/client lives HERE (main process, D-INV-2 —
// the token never enters the renderer). Electron's Node (≥22.18) type-strips
// the workspace .ts imports directly; no bundle step.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgenaClient, parsePtyExit, ulid } from "@agena/client";
import { EMPTY_PERSISTED } from "../src/shared/bridge.ts";

const FLUSH_MS = 16; // one renderer frame per UiBatch (§5.1 of docs/desktop_plan.md)

export function createBridgeHost({ url, token, userData, broadcast }) {
  let client = null;
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

  // ---- open project: pick (main.mjs supplies) + copy INTO the workspace ------
  // The protocol path is POST /v1/files/upload?format=tar (M5); until the
  // daemon serves it we tar-pipe through docker for LOCAL containers.
  // ponytail: docker fallback is local-only by nature; the cloud path arrives
  // with the upload route — same bridge method, swapped transport.
  const openProjectFolder = async (pickFolder) => {
    const src = await pickFolder();
    if (!src) return null;
    const name = (
      src.replace(/\/+$/, "").split("/").pop() ?? "project"
    ).replace(/[^A-Za-z0-9._-]+/g, "-");
    const dest = `/workspace/${name}`;
    const container = await dockerContainerForUrl(url);
    if (!container) {
      const err = new Error(
        "cannot copy into the workspace: daemon has no files-upload route yet and no local docker container was found for it",
      );
      err.code = "NOT_IMPLEMENTED";
      throw err;
    }
    // COPYFILE_DISABLE stops macOS bsdtar emitting AppleDouble ._* entries
    await sh(
      `COPYFILE_DISABLE=1 tar -C ${q(src)} --exclude=node_modules --exclude=.git ` +
        `--exclude=dist --exclude=build --exclude=.next --exclude=.DS_Store ` +
        `--exclude='._*' -cf - . | ` +
        `docker exec -i ${q(container)} sh -c 'mkdir -p ${dest} && tar -xf - -C ${dest}'`,
    );
    const out = await sh(
      `docker exec ${q(container)} sh -c 'find ${dest} -type f | wc -l'`,
    );
    return {
      name,
      // ponytail: client-side projectId slug until daemon-side registration (M4)
      projectId: `prj_${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      projectRoot: dest,
      cwd: dest,
      fileCount: Number.parseInt(out.trim(), 10) || 0,
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
    port1.on("message", (e) => {
      const m = e.data;
      if (m?.type === "data" && m.data) {
        sock.send(new Uint8Array(m.data));
      } else if (m?.type === "resize") {
        sock.send(
          JSON.stringify({ type: "resize", cols: m.cols, rows: m.rows }),
        );
      } else if (m?.type === "close") {
        sock.close(1000, "client close");
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
      case "setThinkingLevel":
        return need().setThinkingLevel(args[0], args[1]);
      case "compact":
        return need().compact(args[0]);
      case "createSession":
        return need().createSession(args[0]);
      case "listSessionSummaries":
        return need().listSessionSummaries(args[0] ?? {});
      case "updateSessionStatus":
        return need().updateSessionStatus(args[0], args[1]);
      case "readEvents":
        return need().readEvents(args[0], args[1] ?? {});
      case "search":
        return need().search(args[0], args[1] ?? {});
      case "listApprovals":
        return need().listApprovals();
      case "listFiles":
        return need().listFiles(args[0] ?? {});
      case "readFile":
        return need().readFile(args[0]);
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
      await client?.close().catch(() => {});
      client = null;
    },
  };
}

// ---- helpers -------------------------------------------------------------------

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function sh(cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", cmd], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      errOut += d;
    });
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else {
        const err = new Error(errOut.trim() || `command failed (${code})`);
        err.code = "INTERNAL";
        reject(err);
      }
    });
  });
}

/** Find the local docker container publishing the daemon's host port. */
async function dockerContainerForUrl(url) {
  let port;
  try {
    port = new URL(url).port || "80";
  } catch {
    return null;
  }
  try {
    const out = await sh(`docker ps --format '{{.Names}}\t{{.Ports}}'`);
    for (const line of out.trim().split("\n")) {
      const [name, ports = ""] = line.split("\t");
      if (name && ports.includes(`:${port}->`)) return name;
    }
  } catch {
    // docker not available
  }
  return null;
}
