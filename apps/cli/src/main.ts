#!/usr/bin/env node
// agena — M1 entrypoint: resolve url/token, resume the newest session or create
// one, run the TUI. Runs directly under Node 22 type stripping (and Bun).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  AgenaClient,
  AgenaClientError,
  type PtyWsLike,
  parsePtyExit,
  ptyDataToBytes,
  ulid,
} from "@agena/client";
import { runTui } from "@agena/tui";

const USAGE = `usage: agena [--url <daemonUrl>] [--token <token>] [--session <id>]
       agena rebuild --yes [--session <id>]
       agena shell [--session <id>] [-- <cmd>]

env: AGENA_URL (default http://127.0.0.1:7777), AGENA_TOKEN`;

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
  commandParts: string[],
): Promise<number> {
  const [command, ...args] = commandParts;
  const size = terminalSize();
  const { socket } = await client.openPty({
    ...size,
    ...(sessionId ? { sessionId } : {}),
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
  let values: {
    url?: string;
    token?: string;
    session?: string;
    yes?: boolean;
    help?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      allowPositionals: true,
      options: {
        url: { type: "string" },
        token: { type: "string" },
        session: { type: "string" },
        yes: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    values = parsed.values;
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
    if (positionals[0] === "shell") {
      return await runShell(client, values.session, positionals.slice(1));
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
    const sessionId =
      values.session ??
      (await client.listSessions())[0] ??
      (await client.createSession());
    await client.connect();
    await runTui(client, sessionId);
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

process.exit(await main());
