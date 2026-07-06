#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// agena — M1 entrypoint: resolve url/token, resume the newest session or create
// one, run the TUI. Runs directly under Node 22 type stripping (and Bun).
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { parseArgs } from "node:util";
import {
  AgenaClient,
  AgenaClientError,
  type CreateSessionOptions,
  type ListSessionsOptions,
  type PtyWsLike,
  parsePtyExit,
  ptyDataToBytes,
  ulid,
} from "@agena/client";
import { runTui } from "@agena/tui";

const USAGE = `usage: agena [--url <daemonUrl>] [--token <token>] [--session <id>]
       agena info [--json]
       agena sessions [--global|--all-projects] [--json]
       agena sessions archive|restore <sessionId>
       agena search <query> [--all-projects] [--json]
       agena approvals
       agena approve <approvalId> [--option <id>|--input <text>|--input-file <path>|--deny]
       agena files ls [path]
       agena files cat <path>
       agena files get [-r] <path> [local]
       agena snapshots list|create|restore|delete [id] [--name <name>]
       agena abort|steer|follow-up|compact|set-model|set-thinking-level
       agena rebuild --yes [--session <id>]
       agena shell [--session <id>] [--cwd <path>] [-- <cmd>]

env: AGENA_URL (default http://127.0.0.1:7777), AGENA_TOKEN`;

type CliValues = {
  url?: string;
  token?: string;
  session?: string;
  cwd?: string;
  yes?: boolean;
  help?: boolean;
  global?: boolean;
  "all-projects"?: boolean;
  json?: boolean;
  option?: string;
  input?: string;
  "input-file"?: string;
  deny?: boolean;
  name?: string;
  recursive?: boolean;
};

/** Stable ULID per installed client (§5.1); persisted under ~/.config/agena/. */
function loadClientId(): string {
  const dir = join(homedir(), ".config", "agena");
  const file = join(dir, "client-id");
  try {
    const id = readFileSync(file, "utf8").trim();
    if (id) return id;
  } catch {
    // fall through and mint one
  }
  const id = ulid();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${id}\n`);
  } catch {
    // unwritable config dir -> per-run id is fine
  }
  return id;
}

function terminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

function enterRawMode(): () => void {
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
  };
}

function installRestore(restore: () => void): () => void {
  const onExit = () => restore();
  const onSigterm = () => {
    restore();
    process.kill(process.pid, "SIGTERM");
  };
  const onSighup = () => {
    restore();
    process.kill(process.pid, "SIGHUP");
  };
  const onUncaught = (err: Error) => {
    restore();
    console.error(err);
    process.exit(1);
  };
  process.once("exit", onExit);
  process.once("SIGTERM", onSigterm);
  process.once("SIGHUP", onSighup);
  process.once("uncaughtException", onUncaught);
  return () => {
    process.off("exit", onExit);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
    process.off("uncaughtException", onUncaught);
  };
}

async function runShell(
  client: AgenaClient,
  sessionId: string | undefined,
  cwd: string | undefined,
  commandParts: string[],
): Promise<number> {
  const [command, ...args] = commandParts;
  const size = terminalSize();
  const { socket } = await client.openPty({
    ...size,
    ...(sessionId ? { sessionId } : {}),
    ...(!sessionId && cwd ? { cwd } : {}),
    ...(command ? { command, args } : {}),
  });
  return attachShell(socket);
}

function attachShell(socket: PtyWsLike): Promise<number> {
  const restore = enterRawMode();
  const uninstallRestore = installRestore(restore);
  let exitCode: number | null = null;
  let settled = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.off("SIGWINCH", onResize);
      uninstallRestore();
      restore();
    };
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const sendResize = () => {
      const { cols, rows } = terminalSize();
      socket.send(JSON.stringify({ type: "resize", cols, rows }));
    };
    function onResize(): void {
      try {
        sendResize();
      } catch (err) {
        fail(err);
      }
    }
    function onData(chunk: Buffer | string): void {
      try {
        socket.send(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      } catch (err) {
        fail(err);
      }
    }
    socket.onopen = () => {
      sendResize();
      process.on("SIGWINCH", onResize);
      process.stdin.on("data", onData);
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const code = parsePtyExit(ev.data);
        if (code !== undefined) exitCode = code;
        return;
      }
      void ptyDataToBytes(ev.data)
        .then((bytes) => {
          process.stdout.write(bytes);
        })
        .catch(fail);
    };
    socket.onerror = fail;
    socket.onclose = () => finish(exitCode ?? 1);
  });
}

async function main(): Promise<number> {
  let values: CliValues;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      allowPositionals: true,
      options: {
        url: { type: "string" },
        token: { type: "string" },
        session: { type: "string" },
        cwd: { type: "string" },
        yes: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        global: { type: "boolean" },
        "all-projects": { type: "boolean" },
        json: { type: "boolean" },
        option: { type: "string" },
        input: { type: "string" },
        "input-file": { type: "string" },
        deny: { type: "boolean" },
        name: { type: "string" },
        recursive: { type: "boolean", short: "r" },
      },
    });
    values = parsed.values as CliValues;
    positionals = parsed.positionals;
  } catch (err) {
    console.error(
      `agena: ${err instanceof Error ? err.message : String(err)}\n${USAGE}`,
    );
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.global && values["all-projects"]) {
    console.error("agena: use either --global or --all-projects, not both");
    return 2;
  }
  const token = values.token ?? process.env.AGENA_TOKEN;
  if (!token) {
    console.error(
      `agena: missing token — set AGENA_TOKEN or pass --token\n${USAGE}`,
    );
    return 2;
  }
  const client = new AgenaClient({
    url: values.url ?? process.env.AGENA_URL ?? "http://127.0.0.1:7777",
    token,
    clientId: loadClientId(),
    clientName: "agena",
    clientVersion: "0.0.0",
  });
  try {
    if (positionals[0] === "info") {
      const diagnostics = await client.diagnostics();
      console.log(
        values.json
          ? JSON.stringify(diagnostics, null, 2)
          : formatInfo(diagnostics),
      );
      return 0;
    }
    if (positionals[0] === "shell") {
      return await runShell(
        client,
        values.session,
        cliWorkspaceCwd(values),
        positionals.slice(1),
      );
    }
    if (positionals[0] === "sessions") {
      if (positionals[1] === "archive" || positionals[1] === "restore") {
        const sessionId = positionals[2];
        if (!sessionId) {
          console.error(
            `agena: sessions ${positionals[1]} requires <sessionId>`,
          );
          return 2;
        }
        await client.updateSessionStatus(
          sessionId,
          positionals[1] === "archive" ? "archived" : "active",
        );
        return 0;
      }
      const sessions = await client.listSessionSummaries(
        listSessionOptions(values),
      );
      console.log(
        values.json
          ? JSON.stringify(sessions, null, 2)
          : sessions
              .map(
                (s) =>
                  `${s.sessionId}\t${s.status}\t${s.scope}\t${s.title ?? ""}`,
              )
              .join("\n"),
      );
      return 0;
    }
    if (positionals[0] === "search") {
      const query = positionals.slice(1).join(" ");
      if (!query) {
        console.error("agena: search requires <query>");
        return 2;
      }
      if (values.global) {
        console.error("agena: search supports --all-projects, not --global");
        return 2;
      }
      const hits = await client.search(query, searchOptions(values));
      console.log(
        values.json
          ? JSON.stringify(hits, null, 2)
          : hits
              .map(
                (h) =>
                  `${h.sessionId}\t${h.seq ?? ""}\t${h.messageId ?? ""}\t${oneLine(h.snippet)}`,
              )
              .join("\n"),
      );
      return 0;
    }
    if (positionals[0] === "files") {
      return await runFiles(client, values, positionals.slice(1));
    }
    if (positionals[0] === "snapshots") {
      return await runSnapshots(client, values, positionals.slice(1));
    }
    if (positionals[0] === "rebuild") {
      if (!values.yes) {
        console.error("agena: rebuild requires --yes");
        return 2;
      }
      const report = await client.rebuild(values.session);
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    if (positionals[0] === "approvals") {
      const approvals = await client.listApprovals();
      console.log(
        values.json
          ? JSON.stringify(approvals, null, 2)
          : approvals
              .map(
                (a) =>
                  `${a.approvalId}\t${a.sessionId}\t${a.payload.kind}\t${a.payload.title ?? a.payload.message}`,
              )
              .join("\n"),
      );
      return 0;
    }
    if (positionals[0] === "approve") {
      const approvalId = positionals[1];
      if (!approvalId) {
        console.error("agena: approve requires <approvalId>");
        return 2;
      }
      const approval = (await client.listApprovals()).find(
        (a) => a.approvalId === approvalId,
      );
      if (!approval) {
        console.error(`agena: approval ${approvalId} is not pending`);
        return 1;
      }
      await client.connect();
      await client.respondToApproval(
        approval.sessionId,
        approvalId,
        approvalResponse(values, approval.payload.kind),
      );
      return 0;
    }
    if (isControlCommand(positionals[0])) {
      const session = await resolveCommandSession(client, values);
      await client.connect();
      switch (positionals[0]) {
        case "abort":
          await client.abort(session);
          return 0;
        case "steer":
          await client.steer(session, positionals.slice(1).join(" "));
          return 0;
        case "follow-up":
          await client.followUp(session, positionals.slice(1).join(" "));
          return 0;
        case "compact":
          await client.compact(session);
          return 0;
        case "set-model":
          await client.setModel(session, parseModel(positionals[1]));
          return 0;
        case "set-thinking-level":
          await client.setThinkingLevel(session, parseThinking(positionals[1]));
          return 0;
      }
    }
    if (positionals.length > 0) {
      console.error(`agena: unknown command ${positionals[0]}\n${USAGE}`);
      return 2;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(
        "agena: the TUI needs a TTY (non-TTY modes land with `agena new --no-tui`)",
      );
      return 2;
    }
    // resume the newest session, or create one if none (fresh M1 daemon)
    const createOptions = createSessionOptions(values);
    const sessionId =
      values.session ??
      (await client.listSessions(listSessionOptions(values)))[0] ??
      (await client.createSession(createOptions));
    await client.connect();
    await runTui(client, sessionId, { freshSession: createOptions });
    return 0;
  } catch (err) {
    console.error(`agena: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof AgenaClientError) {
      if (err.code === "UNAUTHORIZED") return 5;
      if (err.code === "PROTOCOL_MISMATCH") return 7;
      if (err.code === "CONNECTION_FAILED") return 4;
    }
    return 1;
  }
}

async function runFiles(
  client: AgenaClient,
  values: CliValues,
  args: string[],
): Promise<number> {
  const [command, path = "."] = args;
  if (command === "ls") {
    const entries = await client.listFiles({ path });
    console.log(
      values.json
        ? JSON.stringify(entries, null, 2)
        : entries
            .map((e) => `${e.type}\t${e.size}\t${e.mtime}\t${e.name}`)
            .join("\n"),
    );
    return 0;
  }
  if (command === "cat") {
    if (!args[1]) throw new Error("files cat requires <path>");
    process.stdout.write(Buffer.from(await client.readFile(path)));
    return 0;
  }
  if (command === "get") {
    if (!args[1]) throw new Error("files get requires <path>");
    const local = args[2] ?? defaultGetPath(path, values.recursive === true);
    const bytes =
      values.recursive === true
        ? await client.archiveFiles(path)
        : await client.readFile(path);
    writeFileSync(local, bytes);
    return 0;
  }
  throw new Error("files requires ls, cat, or get");
}

function defaultGetPath(path: string, recursive: boolean): string {
  const name = basename(path.replace(/\/+$/, ""));
  if (recursive) return `${name || "workspace"}.tar.zst`;
  return name || "file";
}

async function runSnapshots(
  client: AgenaClient,
  values: CliValues,
  args: string[],
): Promise<number> {
  const command = args[0] ?? "list";
  switch (command) {
    case "list": {
      const snapshots = await client.listSnapshots();
      console.log(
        values.json
          ? JSON.stringify(snapshots, null, 2)
          : snapshots
              .map(
                (s) =>
                  `${s.snapshotId}\t${s.status}\t${s.kind}\t${s.name ?? ""}`,
              )
              .join("\n"),
      );
      return 0;
    }
    case "create": {
      const snapshot = await client.createSnapshot({
        ...(values.name ? { name: values.name } : {}),
        ...(values.session ? { sessionId: values.session } : {}),
      });
      console.log(snapshot.snapshotId);
      return 0;
    }
    case "restore": {
      const snapshotId = args[1];
      if (!snapshotId) {
        console.error("agena: snapshots restore requires <snapshotId>");
        return 2;
      }
      const result = await client.restoreSnapshot(snapshotId, {
        ...(values.session ? { sessionId: values.session } : {}),
      });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    case "delete": {
      const snapshotId = args[1];
      if (!snapshotId) {
        console.error("agena: snapshots delete requires <snapshotId>");
        return 2;
      }
      await client.deleteSnapshot(snapshotId);
      return 0;
    }
    default:
      console.error(`agena: unknown snapshots command ${command}`);
      return 2;
  }
}

function formatInfo(
  diagnostics: Awaited<ReturnType<AgenaClient["diagnostics"]>>,
): string {
  const lines = [
    `daemon\t${diagnostics.daemon.version}`,
    `protocol\t${diagnostics.protocol.version}`,
    `workspace\t${diagnostics.workspace.path}`,
  ];
  if (diagnostics.discovery.entries.length === 0) {
    lines.push("discovery\t(no .agena/tools/*.ts found)");
    return lines.join("\n");
  }
  lines.push("discovery");
  for (const entry of diagnostics.discovery.entries) {
    lines.push(
      `${entry.status}\t${entry.kind}\t${entry.name}\t${entry.file}${entry.reason ? `\t${entry.reason}` : ""}`,
    );
  }
  return lines.join("\n");
}

function isControlCommand(command: string | undefined): boolean {
  return (
    command === "abort" ||
    command === "steer" ||
    command === "follow-up" ||
    command === "compact" ||
    command === "set-model" ||
    command === "set-thinking-level"
  );
}

async function resolveCommandSession(
  client: AgenaClient,
  values: CliValues,
): Promise<string> {
  if (values.session) return values.session;
  const session = (await client.listSessions(listSessionOptions(values)))[0];
  if (!session) throw new Error("no session found for this scope");
  return session;
}

function approvalResponse(values: CliValues, kind: string) {
  if (values.deny) return { kind: "deny" as const };
  if (kind === "confirm") return { kind: "confirm" as const, accepted: true };
  if (kind === "select") {
    if (!values.option) throw new Error("select approval requires --option");
    return { kind: "select" as const, optionId: values.option };
  }
  const text =
    values["input-file"] !== undefined
      ? readFileSync(values["input-file"], "utf8")
      : (values.input ?? "");
  return { kind: kind === "editor" ? "editor" : "input", text } as const;
}

function parseModel(value: string | undefined) {
  if (!value) throw new Error("set-model requires provider/model");
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error("model must be provider/model");
  }
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function parseThinking(value: string | undefined) {
  const allowed = ["off", "minimal", "low", "medium", "high", "xhigh"];
  if (!value || !allowed.includes(value)) {
    throw new Error(`thinking level must be one of: ${allowed.join(", ")}`);
  }
  return value as Parameters<AgenaClient["setThinkingLevel"]>[1];
}

function createSessionOptions(values: CliValues): CreateSessionOptions {
  const hostCwdHint = hostPath(values.cwd ?? process.cwd());
  const project = hostProject(hostCwdHint);
  const cwd = workspaceCwdFromHost(hostCwdHint, project.root);
  if (values.global) return { scope: "global", cwd, hostCwdHint };
  return {
    scope: "project",
    projectId: project.id,
    projectRoot: ".",
    cwd,
    hostCwdHint,
  };
}

function listSessionOptions(values: CliValues): ListSessionsOptions {
  if (values["all-projects"]) return { allProjects: true };
  if (values.global) return { scope: "global" };
  return {
    projectId: hostProject(hostPath(values.cwd ?? process.cwd())).id,
  };
}

function searchOptions(values: CliValues) {
  if (values.session) return { sessionId: values.session };
  if (values["all-projects"]) return { allProjects: true };
  return {
    projectId: hostProject(hostPath(values.cwd ?? process.cwd())).id,
  };
}

function oneLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function cliWorkspaceCwd(values: CliValues): string {
  const hostCwd = hostPath(values.cwd ?? process.cwd());
  return workspaceCwdFromHost(hostCwd, hostProject(hostCwd).root);
}

function workspaceCwdFromHost(hostCwd: string, hostRoot: string): string {
  const rel = relative(hostRoot, hostCwd);
  if (rel.startsWith("..") || isAbsolute(rel)) return ".";
  const cwd = normalize(rel).replaceAll("\\", "/");
  return cwd === "" ? "." : cwd;
}

function hostProject(cwd: string): { id: string; root: string } {
  const root = gitRoot(cwd) ?? cwd;
  return {
    id: `host-${Buffer.from(root).toString("base64url")}`,
    root,
  };
}

function gitRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function hostPath(path: string): string {
  return realpathSync(resolve(path));
}

process.exit(await main());
