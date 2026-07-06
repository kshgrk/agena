// Rendering layer: thin pi-tui shell over the pure store (ADR-0001 keeps all
// pi-tui usage in this file so the framework stays swappable).
import type { AgenaClient, ConnectionState } from "@agena/client";
import {
  Container,
  Editor,
  type EditorTheme,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TUI,
} from "@earendil-works/pi-tui";
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

  const tui = new TUI(new ProcessTerminal());
  const transcript = new Container();
  const statusBar = new Text("", 1, 0);
  const editor = new Editor(tui, editorTheme);
  tui.addChild(transcript);
  tui.addChild(new Spacer(1));
  tui.addChild(statusBar);
  tui.addChild(editor);
  tui.setFocus(editor);

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
    return `${dot} ${conn} · session ${short(currentSession)}${warn}`;
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
    tui.addInputListener((data) => {
      // ponytail: single Ctrl+C quits; the double-press guard is later polish (§11.3)
      if (matchesKey(data, "ctrl+c")) {
        if (redrawTimer) clearTimeout(redrawTimer);
        tui.stop();
        void client.close();
        resolve();
        return { consume: true };
      }
      return undefined;
    });
    tui.start();
    client
      .subscribe(currentSession, 0)
      .catch((err) => marker(`subscribe failed: ${message(err)}`));
    redraw();
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
