import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import type { EventStore } from "@agena/core";
import type {
  CreatePtyRequest,
  CreatePtyResponse,
  ListPtysResponse,
  PtySummary,
} from "@agena/protocol";
import {
  PTY_IDLE_TIMEOUT_MS,
  PTY_PAUSE_BUFFERED_BYTES,
  PTY_RESUME_BUFFERED_BYTES,
  PTY_SCROLLBACK_BYTES,
  ptyClientControlFrameSchema,
  WS_CLOSE_CODES,
} from "@agena/protocol";
import * as pty from "node-pty";
import { type RawData, WebSocket, WebSocketServer } from "ws";

type PtyProcess = ReturnType<typeof pty.spawn>;
type ExitEvent = Parameters<Parameters<PtyProcess["onExit"]>[0]>[0];

type PtyRecord = {
  id: string;
  proc: PtyProcess;
  sessionId?: string;
  branchId?: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: string;
  lastAttachedAt: string | null;
  attached: WebSocket | null;
  ring: Buffer[];
  ringBytes: number;
  ended: boolean;
  reapTimer: ReturnType<typeof setTimeout> | null;
};

export class PtyManager {
  readonly wss = new WebSocketServer({ noServer: true });
  readonly #store: EventStore;
  readonly #workspaceDir: string;
  readonly #ptys = new Map<string, PtyRecord>();

  constructor(store: EventStore, workspaceDir: string) {
    this.#store = store;
    this.#workspaceDir = resolve(workspaceDir);
  }

  async create(input: CreatePtyRequest): Promise<CreatePtyResponse> {
    const session = input.sessionId
      ? await this.#store.getSession(input.sessionId)
      : null;
    if (input.sessionId && !session) throw new Error("SESSION_NOT_FOUND");

    const cwd = this.#cwd(input.cwd);
    const shell = input.command ?? "/bin/bash";
    const args = input.command ? (input.args ?? []) : ["-l"];
    const id = randomUUID();
    if (session) {
      await this.#store.appendEvents({
        sessionId: session.sessionId,
        branchId: session.rootBranchId,
        events: [
          {
            type: "terminal.session.started",
            v: 1,
            source: { kind: "terminal" },
            payload: {
              terminalId: id,
              shell,
              cols: input.cols,
              rows: input.rows,
            },
          },
        ],
      });
    }
    let proc: PtyProcess;
    try {
      proc = pty.spawn(shell, args, {
        name: "xterm-256color",
        cols: input.cols,
        rows: input.rows,
        cwd,
        env: shellEnv(),
      });
    } catch (err) {
      if (session)
        await this.#appendEnded(
          session.sessionId,
          session.rootBranchId,
          id,
          null,
          "killed",
        );
      throw err;
    }
    const rec: PtyRecord = {
      id,
      proc,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(session ? { branchId: session.rootBranchId } : {}),
      shell,
      cwd,
      cols: input.cols,
      rows: input.rows,
      createdAt: new Date().toISOString(),
      lastAttachedAt: null,
      attached: null,
      ring: [],
      ringBytes: 0,
      ended: false,
      reapTimer: null,
    };
    this.#ptys.set(id, rec);
    proc.onData((data) => this.#onData(rec, data));
    proc.onExit((ev) => void this.#end(rec, ev, "exit"));

    return { ptyId: id, wsPath: `/v1/ptys/${id}/ws` };
  }

  list(): ListPtysResponse {
    return { ptys: [...this.#ptys.values()].map(summary) };
  }

  async kill(id: string): Promise<boolean> {
    const rec = this.#ptys.get(id);
    if (!rec) return false;
    rec.proc.kill("SIGHUP");
    setTimeout(() => {
      if (!rec.ended) rec.proc.kill("SIGKILL");
    }, 5_000);
    await this.#end(rec, { exitCode: 0, signal: 1 }, "killed");
    return true;
  }

  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    ptyId: string,
  ): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.#attach(ptyId, ws));
  }

  async close(): Promise<void> {
    for (const rec of [...this.#ptys.values()]) await this.kill(rec.id);
    this.wss.close();
  }

  #attach(id: string, ws: WebSocket): void {
    const rec = this.#ptys.get(id);
    if (!rec) {
      ws.close(WS_CLOSE_CODES.normal, "pty not found");
      return;
    }
    if (rec.attached) {
      ws.close(WS_CLOSE_CODES.ptyAlreadyAttached, "pty already attached");
      return;
    }
    if (rec.reapTimer) clearTimeout(rec.reapTimer);
    const reattach = rec.lastAttachedAt !== null;
    rec.reapTimer = null;
    rec.attached = ws;
    rec.lastAttachedAt = new Date().toISOString();
    for (const chunk of rec.ring) ws.send(chunk);
    if (reattach) {
      // Some shells redraw only after a geometry change; nudge then restore on reattach (§11.5).
      rec.proc.resize(rec.cols === 1 ? 2 : rec.cols - 1, rec.rows);
      rec.proc.resize(rec.cols, rec.rows);
    }
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        rec.proc.write(raw(data));
        return;
      }
      const parsed = ptyClientControlFrameSchema.safeParse(parseJson(data));
      if (!parsed.success) return;
      rec.cols = parsed.data.cols;
      rec.rows = parsed.data.rows;
      rec.proc.resize(parsed.data.cols, parsed.data.rows);
    });
    ws.on("close", () => {
      if (rec.attached !== ws) return;
      rec.attached = null;
      rec.reapTimer = setTimeout(
        () => void this.kill(rec.id),
        PTY_IDLE_TIMEOUT_MS,
      );
    });
  }

  #onData(rec: PtyRecord, data: string): void {
    const chunk = Buffer.from(data, "utf8");
    rec.ring.push(chunk);
    rec.ringBytes += chunk.byteLength;
    while (rec.ringBytes > PTY_SCROLLBACK_BYTES) {
      const removed = rec.ring.shift();
      rec.ringBytes -= removed?.byteLength ?? 0;
    }
    if (rec.attached?.readyState === WebSocket.OPEN) {
      rec.attached.send(chunk);
      if (rec.attached.bufferedAmount > PTY_PAUSE_BUFFERED_BYTES) {
        rec.proc.pause();
        const timer = setInterval(() => {
          if (
            !rec.attached ||
            rec.attached.readyState !== WebSocket.OPEN ||
            rec.attached.bufferedAmount < PTY_RESUME_BUFFERED_BYTES
          ) {
            clearInterval(timer);
            rec.proc.resume();
          }
        }, 50);
      }
    }
  }

  async #end(
    rec: PtyRecord,
    ev: ExitEvent,
    reason: "exit" | "killed",
  ): Promise<void> {
    if (rec.ended) return;
    rec.ended = true;
    if (rec.reapTimer) clearTimeout(rec.reapTimer);
    if (rec.attached?.readyState === WebSocket.OPEN) {
      rec.attached.send(
        JSON.stringify({
          type: "exit",
          exitCode: reason === "exit" ? ev.exitCode : null,
          signal: ev.signal === 0 ? null : String(ev.signal),
        }),
      );
      rec.attached.close(WS_CLOSE_CODES.normal, "pty ended");
    }
    if (rec.sessionId && rec.branchId) {
      await this.#appendEnded(
        rec.sessionId,
        rec.branchId,
        rec.id,
        reason === "exit" ? ev.exitCode : null,
        reason,
      );
    }
    this.#ptys.delete(rec.id);
  }

  async #appendEnded(
    sessionId: string,
    branchId: string,
    terminalId: string,
    exitCode: number | null,
    reason: "exit" | "killed" | "daemon_restart",
  ): Promise<void> {
    await this.#store.appendEvents({
      sessionId,
      branchId,
      events: [
        {
          type: "terminal.session.ended",
          v: 1,
          source: { kind: "terminal" },
          payload: { terminalId, exitCode, reason },
        },
      ],
    });
  }

  #cwd(cwd: string | undefined): string {
    const path = resolve(this.#workspaceDir, cwd ?? ".");
    if (
      path !== this.#workspaceDir &&
      !path.startsWith(`${this.#workspaceDir}/`)
    ) {
      throw new Error("INVALID_CWD");
    }
    if (!existsSync(path)) throw new Error("INVALID_CWD");
    return path;
  }
}

function summary(rec: PtyRecord): PtySummary {
  return {
    ptyId: rec.id,
    cols: rec.cols,
    rows: rec.rows,
    cwd: rec.cwd,
    ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
    attached: rec.attached !== null,
    createdAt: rec.createdAt,
    lastAttachedAt: rec.lastAttachedAt,
  };
}

function raw(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

function parseJson(data: RawData): unknown {
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/(_API_KEY|_TOKEN|SECRET|PASSWORD)$/i.test(key)) continue;
    env[key] = value;
  }
  env.TERM = "xterm-256color";
  return env;
}
