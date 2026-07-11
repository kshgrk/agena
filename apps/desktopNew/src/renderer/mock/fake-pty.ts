// A tiny line-discipline shell over PtyPortMessage — enough for a convincing
// xterm demo: echo, backspace, and a handful of commands over the fixture tree.
import type { CreatePtyRequest } from "@agena/protocol";
import type { PtyHandle, PtyPortMessage } from "../../shared/bridge.ts";
import {
  listDir,
  nodeAt,
  REPO_ROOT,
  readFixtureFile,
} from "./fixtures/files.ts";
import { ulid } from "./world.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const BLUE = "\x1b[1;34m";
const RESET = "\x1b[0m";

function resolvePath(cwd: string, arg: string): string {
  const raw = arg.startsWith("/") ? arg : `${cwd}/${arg}`;
  const parts: string[] = [];
  for (const p of raw.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return `/${parts.join("/")}`;
}

export function openFakePty(opts: Partial<CreatePtyRequest>): PtyHandle {
  const { port1, port2 } = new MessageChannel();
  let cwd = opts.cwd ?? REPO_ROOT;
  let line = "";
  let closed = false;

  const send = (text: string): void => {
    if (closed) return;
    const buf = encoder.encode(text).buffer as ArrayBuffer;
    port2.postMessage({ type: "data", data: buf } satisfies PtyPortMessage, [
      buf,
    ]);
  };
  const prompt = (): string =>
    `\x1b[38;5;141m${cwd.split("/").pop() || "/"}\x1b[0m ❯ `;

  const runLine = (input: string): void => {
    const [cmd = "", ...args] = input.trim().split(/\s+/);
    switch (cmd) {
      case "":
        break;
      case "ls": {
        const target = resolvePath(cwd, args[0] ?? ".");
        if (target === "/workspace") {
          send(`${BLUE}repo-a${RESET}\r\n`);
          break;
        }
        const entries = listDir(target);
        if (!entries) {
          send(`ls: ${args[0] ?? cwd}: No such file or directory\r\n`);
          break;
        }
        const width = Math.max(...entries.map((e) => e.name.length)) + 2;
        const row = entries
          .map((e) => {
            const padded = e.name.padEnd(width);
            return e.type === "dir" ? `${BLUE}${padded}${RESET}` : padded;
          })
          .join("");
        send(`${row}\r\n`);
        break;
      }
      case "pwd":
        send(`${cwd}\r\n`);
        break;
      case "cd": {
        const target = args[0] ? resolvePath(cwd, args[0]) : REPO_ROOT;
        const node =
          target === "/" || target === "/workspace"
            ? { type: "dir" }
            : nodeAt(target);
        if (node && node.type === "dir") cwd = target;
        else send(`cd: no such file or directory: ${args[0] ?? ""}\r\n`);
        break;
      }
      case "echo":
        send(`${args.join(" ")}\r\n`);
        break;
      case "cat": {
        if (!args[0]) {
          send("usage: cat <file>\r\n");
          break;
        }
        const content = readFixtureFile(resolvePath(cwd, args[0]));
        if (content === null)
          send(`cat: ${args[0]}: No such file or directory\r\n`);
        else send(content.replaceAll("\n", "\r\n"));
        break;
      }
      case "clear":
        send("\x1b[2J\x1b[H");
        break;
      case "help":
        send(
          "mock shell — available: ls, pwd, cd, echo, cat, clear, help, exit\r\n",
        );
        break;
      case "exit": {
        send("exit\r\n");
        closed = true;
        port2.postMessage({
          type: "exit",
          exitCode: 0,
        } satisfies PtyPortMessage);
        port2.close();
        return;
      }
      default:
        send(`zsh: command not found: ${cmd}\r\n`);
    }
    send(prompt());
  };

  port2.onmessage = (e: MessageEvent) => {
    const msg = e.data as PtyPortMessage;
    if (closed) return;
    switch (msg.type) {
      case "data": {
        const text = decoder.decode(msg.data);
        for (const ch of text) {
          if (ch === "\r" || ch === "\n") {
            send("\r\n");
            const input = line;
            line = "";
            runLine(input);
          } else if (ch === "\x7f") {
            if (line.length > 0) {
              line = line.slice(0, -1);
              send("\b \b");
            }
          } else if (ch === "\x03") {
            line = "";
            send(`^C\r\n${prompt()}`);
          } else if (ch >= " ") {
            line += ch;
            send(ch);
          }
        }
        break;
      }
      case "resize":
        break; // handled silently
      case "close":
        closed = true;
        port2.close();
        break;
      case "exit":
        break; // main→renderer only; ignore
    }
  };

  send(`agena mock shell — type 'help' for commands\r\n${prompt()}`);
  return { ptyId: ulid(), port: port1 };
}
