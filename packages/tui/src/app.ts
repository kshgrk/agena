// Rendering layer: thin pi-tui shell over the pure store (ADR-0001 keeps all
// pi-tui usage in this file so the framework stays swappable).
import type { AgenaClient, ConnectionState, PtyWsLike } from "@agena/client";
import {
  isTerminalPtyClose,
  parsePtyExit,
  ptyDataToBytes,
} from "@agena/client";
import {
  Container,
  Editor,
  type EditorTheme,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
} from "@earendil-works/pi-tui";
import {
  FixedHeightPane,
  routeKey,
  ShellDivider,
  ShellPane,
} from "./shell-pane.ts";
import {
  addMarker,
  applyEvent,
  applyFrame,
  applySnapshot,
  type Block,
  initialState,
} from "./store.ts";

const style = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const dim = style("2");
const bold = style("1");
const green = style("32");
const yellow = style("33");
const red = style("31");
const cyan = style("36");

const QUIT_CONFIRM_MS = 1_500; // §11.3: Ctrl+C ×2 within this window quits

const editorTheme: EditorTheme = {
  borderColor: dim,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
};

const short = (id: string) => id.slice(0, 8).toLowerCase();

function blockText(b: Block): Text {
  if (b.kind === "user")
    return new Text(`${cyan(bold("you"))}\n${b.text}`, 1, 0);
  if (b.kind === "assistant")
    return new Text(`${green(bold("agena"))}\n${b.text}`, 1, 0);
  return new Text(dim(`— ${b.text} —`), 1, 0);
}

/** Run the M1 TUI (transcript + prompt + status bar); resolves when the user quits. */
export function runTui(client: AgenaClient, sessionId: string): Promise<void> {
  let state = initialState;
  let currentSession = sessionId;
  let connState: ConnectionState = "connected";
  let connDetail = "";
  let notice = "";
  let shellHeight = Math.min(
    10,
    Math.max(6, Math.floor(terminalSize().rows / 3)),
  );
  let shellWsPath: string | null = null;
  let shellSocket: PtyWsLike | null = null;
  let shellExitCode: number | null = null;
  let shellOpened = false;
  let shellReconnectAttempts = 0;
  let shellReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let quitArmedAt = 0;
  let quitNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  let activePane: "chat" | "shell" = "chat";

  const tui = new TUI(new ProcessTerminal());
  const transcript = new Container();
  const statusBar = new Text("", 1, 0);
  const shellPane = new ShellPane((data) => {
    try {
      shellSocket?.send(Buffer.from(data));
    } catch (err) {
      marker(`shell write failed: ${message(err)}`);
    }
  });
  const editor = new Editor(tui, editorTheme);
  const transcriptPane = new FixedHeightPane(transcript, chatHeight, "end");
  const shellDivider = new ShellDivider(
    () => shellPane.visible,
    () => activePane === "shell",
  );
  tui.addChild(transcriptPane);
  tui.addChild(shellDivider);
  tui.addChild(shellPane);
  tui.addChild(statusBar);
  tui.addChild(editor);
  tui.setFocus(editor);

  function setActivePane(pane: "chat" | "shell"): void {
    activePane = pane;
    tui.setFocus(pane === "shell" ? shellPane : editor);
  }

  function quitArmed(): boolean {
    return Date.now() - quitArmedAt < QUIT_CONFIRM_MS;
  }

  function statusLine(): string {
    const dot =
      connState === "connected"
        ? green("●")
        : connState === "reconnecting"
          ? yellow("◐")
          : red("○");
    const conn =
      connDetail && connState !== "connected"
        ? `${connState} (${connDetail})`
        : connState;
    const warn = notice ? `  ${yellow(`! ${notice}`)}` : "";
    const quit = quitArmed() ? `  ${yellow("press Ctrl+C again to quit")}` : "";
    const hint = shellPane.visible ? "" : `  ${dim("Ctrl+T terminal")}`;
    return `${dot} ${conn} · session ${short(currentSession)}${warn}${quit}${hint}`;
  }

  function chatHeight(): number {
    const shellRows = shellPane.visible ? shellHeight + 1 : 0;
    return Math.max(3, terminalSize().rows - shellRows - 3);
  }

  function redraw(): void {
    transcript.clear();
    for (const b of state.blocks) {
      transcript.addChild(new Spacer(1));
      transcript.addChild(blockText(b));
    }
    if (state.inFlight) {
      transcript.addChild(new Spacer(1));
      transcript.addChild(
        new Text(
          `${green(bold("agena"))}\n${state.inFlight.text}${dim("|")}`,
          1,
          0,
        ),
      );
    }
    statusBar.setText(statusLine());
    tui.requestRender();
  }

  // 40 ms client render tick (§3.2) — coalesces frame floods into one rebuild
  let redrawTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRedraw(): void {
    if (redrawTimer) return;
    redrawTimer = setTimeout(() => {
      redrawTimer = null;
      redraw();
    }, 40);
  }

  function marker(text: string): void {
    state = addMarker(state, text);
    scheduleRedraw();
  }

  client.onEvent = (e) => {
    state = applyEvent(state, e);
    scheduleRedraw();
  };
  client.onFrame = (f) => {
    state = applyFrame(state, f);
    scheduleRedraw();
  };
  client.onSnapshot = (snapshot) => {
    state = applySnapshot(state, snapshot);
    scheduleRedraw();
  };
  client.onStatus = (s, detail) => {
    connState = s;
    connDetail = detail ?? "";
    scheduleRedraw();
  };
  // M1 acceptance #3 (P8 honesty): the daemon restarted and its in-memory store is gone.
  client.onSessionLost = (lost) => {
    notice = "daemon restarted — history lost";
    marker(
      `daemon restarted: history for session ${short(lost)} was lost (M1 in-memory store)`,
    );
    void (async () => {
      try {
        currentSession = await client.createSession();
        marker(`continuing in fresh session ${short(currentSession)}`);
        await client.subscribe(currentSession, 0);
      } catch (err) {
        marker(`could not start a fresh session: ${message(err)}`);
      }
    })();
  };

  editor.onSubmit = (text) => {
    const t = text.trim();
    if (!t) return;
    editor.addToHistory(t);
    client
      .prompt(currentSession, t)
      .catch((err) => marker(`prompt failed: ${message(err)}`));
  };

  return new Promise((resolve) => {
    async function showShell(): Promise<void> {
      if (shellSocket) {
        shellPane.setHeight(shellHeight);
        sendShellResize();
        redraw();
        return;
      }
      shellPane.setHeight(shellHeight);
      shellPane.setState("opening");
      redraw();
      try {
        if (shellWsPath) {
          bindShell(client.connectPty(shellWsPath));
          return;
        }
        const attachment = await client.openPty({
          ...shellTerminalSize(),
          sessionId: currentSession,
        });
        shellWsPath = attachment.wsPath;
        bindShell(attachment.socket);
      } catch (err) {
        shellWsPath = null;
        shellPane.setState("ended");
        marker(`shell failed: ${message(err)}`);
        setActivePane("chat");
        redraw();
      }
    }

    function hideShell(): void {
      shellPane.setHeight(0);
      if (activePane === "shell") setActivePane("chat");
      redraw();
    }

    function toggleShell(): void {
      if (shellPane.visible) {
        hideShell();
        return;
      }
      void showShell();
    }

    function focusChat(): void {
      setActivePane("chat");
      redraw();
    }

    function focusShell(): void {
      if (!shellPane.visible) return;
      setActivePane("shell");
      redraw();
    }

    function resizeShell(direction: "grow" | "shrink"): void {
      if (!shellPane.visible) return;
      const max = Math.max(5, terminalSize().rows - 7);
      const next = clamp(shellHeight + (direction === "grow" ? 1 : -1), 5, max);
      if (next === shellHeight) return;
      shellHeight = next;
      shellPane.setHeight(shellHeight);
      sendShellResize();
      redraw();
    }

    function bindShell(socket: PtyWsLike): void {
      if (shellReconnectTimer) {
        clearTimeout(shellReconnectTimer);
        shellReconnectTimer = null;
      }
      shellSocket = socket;
      shellExitCode = null;
      shellOpened = false;
      // Attach replays the daemon's full scrollback ring (§9.5) — start from an
      // empty pane or the replay duplicates everything already rendered.
      shellPane.clear();
      shellPane.setHeight(shellHeight);
      shellPane.setState("opening");
      // Per-socket decoder: keeps UTF-8 sequences split across frames intact.
      const decoder = new TextDecoder();
      socket.onopen = () => {
        shellOpened = true;
        shellReconnectAttempts = 0;
        shellPane.setState("attached");
        sendShellResize();
        redraw();
      };
      socket.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          const code = parsePtyExit(ev.data);
          if (code !== undefined) shellExitCode = code;
          return;
        }
        void ptyDataToBytes(ev.data)
          .then((bytes) => {
            shellPane.write(decoder.decode(bytes, { stream: true }));
            scheduleRedraw();
          })
          .catch((err) => marker(`shell read failed: ${message(err)}`));
      };
      socket.onerror = () => {
        if (!shellOpened) reconnectShell();
      };
      socket.onclose = (ev) => {
        if (shellExitCode !== null) {
          finishShell(shellExitCode);
          return;
        }
        if (isTerminalPtyClose(ev.code, ev.reason)) {
          finishShell(ev.reason === "pty not found" ? 1 : 0);
          return;
        }
        reconnectShell();
      };
    }

    function reconnectShell(): void {
      if (!shellWsPath) {
        finishShell(1);
        return;
      }
      if (shellReconnectTimer) return;
      if (shellReconnectAttempts >= 20) {
        finishShell(shellExitCode ?? 1);
        return;
      }
      shellReconnectAttempts += 1;
      shellSocket = null;
      shellPane.setState("reconnecting");
      redraw();
      shellReconnectTimer = setTimeout(
        () => {
          shellReconnectTimer = null;
          if (!shellWsPath) return;
          bindShell(client.connectPty(shellWsPath));
        },
        Math.min(1_000, 100 * shellReconnectAttempts),
      );
    }

    function finishShell(code: number): void {
      shellSocket = null;
      shellWsPath = null;
      shellExitCode = null;
      shellOpened = false;
      shellPane.setState("ended"); // ended ⇒ hidden; the split's rows return to chat
      if (activePane === "shell") setActivePane("chat");
      marker(`terminal exited (code ${code})`);
      redraw();
    }

    function sendShellResize(): void {
      if (!shellSocket) return;
      try {
        shellSocket.send(
          JSON.stringify({ type: "resize", ...shellTerminalSize() }),
        );
      } catch (err) {
        marker(`shell resize failed: ${message(err)}`);
      }
    }

    function shellTerminalSize(): { cols: number; rows: number } {
      return {
        cols: terminalSize().cols,
        rows: shellPane.ptyRows,
      };
    }

    function quit(): void {
      if (redrawTimer) clearTimeout(redrawTimer);
      if (shellReconnectTimer) clearTimeout(shellReconnectTimer);
      if (quitNoticeTimer) clearTimeout(quitNoticeTimer);
      try {
        shellSocket?.close(1000, "client quit");
      } catch {
        // best effort; daemon reaps unattached PTYs after the idle window.
      }
      process.off("SIGWINCH", sendShellResize);
      tui.stop();
      void client.close();
      resolve();
    }

    function armQuit(): void {
      quitArmedAt = Date.now();
      if (quitNoticeTimer) clearTimeout(quitNoticeTimer);
      quitNoticeTimer = setTimeout(() => {
        quitNoticeTimer = null;
        redraw(); // the confirm hint expires with the window
      }, QUIT_CONFIRM_MS);
      redraw();
    }

    function disarmQuit(): void {
      if (!quitArmedAt) return;
      quitArmedAt = 0;
      if (quitNoticeTimer) {
        clearTimeout(quitNoticeTimer);
        quitNoticeTimer = null;
      }
      scheduleRedraw();
    }

    tui.addInputListener((data) => {
      const action = routeKey(data, {
        shellFocused: activePane === "shell",
        shellVisible: shellPane.visible,
        editorEmpty: editor.getText().length === 0,
      });
      if (action === "pass") {
        disarmQuit();
        return undefined; // focused component owns the key (shell PTY or editor)
      }
      if (action === "shell-input") {
        disarmQuit();
        shellPane.handleInput(data);
        return { consume: true };
      }
      switch (action) {
        case "toggle-shell":
          toggleShell();
          break;
        case "focus-chat":
          focusChat();
          break;
        case "focus-shell":
          focusShell();
          break;
        case "grow":
        case "shrink":
          resizeShell(action);
          break;
        case "quit-key":
          if (quitArmed()) quit();
          else armQuit();
          break;
      }
      return { consume: true };
    });
    tui.start();
    process.on("SIGWINCH", sendShellResize);
    client
      .subscribe(currentSession, 0)
      .catch((err) => marker(`subscribe failed: ${message(err)}`));
    redraw();
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function terminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
