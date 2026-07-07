// Rendering layer: thin pi-tui shell over the pure store (ADR-0001 keeps all
// pi-tui usage in this file so the framework stays swappable).
import type {
  AgenaClient,
  ConnectionState,
  CreateSessionOptions,
  PtyWsLike,
} from "@agena/client";
import {
  isTerminalPtyClose,
  parsePtyExit,
  ptyDataToBytes,
} from "@agena/client";
import type {
  AgenaEvent,
  ApprovalRequested,
  ApprovalResponse,
  ModelRef,
  ThinkingLevel,
} from "@agena/protocol";
import { approvalRequestedSchema } from "@agena/protocol";
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

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[2J\x1b[H";
const EXIT_ALT_SCREEN = "\x1b[?1049l";

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
const clip = (text: string) =>
  text.length > 120 ? `${text.slice(0, 117)}...` : text;

type ApprovalModal = {
  kind: "approval";
  approvalId: string;
  input: string;
  selectedIndex: number;
  submitting: boolean;
  error: string | null;
};

type SelectModal<K extends "model" | "thinking", T> = {
  kind: K;
  title: string;
  current: string;
  options: Array<{ label: string; value: T }>;
  selectedIndex: number;
  submitting: boolean;
  error: string | null;
};

type ModelModal = SelectModal<"model", ModelRef>;
type ThinkingModal = SelectModal<"thinking", ThinkingLevel>;

type CompactModal = {
  kind: "compact";
  submitting: boolean;
  error: string | null;
};

type ControlModal = ApprovalModal | ModelModal | ThinkingModal | CompactModal;

function blockText(b: Block): Text {
  if (b.kind === "user")
    return new Text(`${cyan(bold("you"))}\n${b.text}`, 1, 0);
  if (b.kind === "assistant")
    return new Text(`${green(bold("agena"))}\n${b.text}`, 1, 0);
  if (b.kind === "tool") return new Text(dim(`tool\n${b.text}`), 1, 0);
  return new Text(dim(`— ${b.text} —`), 1, 0);
}

/** Run the M1 TUI (transcript + prompt + status bar); resolves when the user quits. */
export type RunTuiOptions = {
  freshSession?: CreateSessionOptions;
};

export function runTui(
  client: AgenaClient,
  sessionId: string,
  opts: RunTuiOptions = {},
): Promise<void> {
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
  let activePane: "chat" | "shell" = "chat";
  let quitNow: (() => void) | null = null;
  const activeRuns = new Set<string>();
  const pendingApprovals = new Map<string, ApprovalRequested>();
  let controlModal: ControlModal | null = null;

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
    const turn = activeRuns.size > 0 ? `  ${yellow("turn active")}` : "";
    const approvals =
      pendingApprovals.size > 0
        ? `  ${yellow(`approvals ${pendingApprovals.size}`)}`
        : "";
    const hint = shellPane.visible ? "" : `  ${dim("Ctrl+T terminal")}`;
    return `${dot} ${conn} · session ${short(currentSession)}${turn}${approvals}${warn}${hint}`;
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
    if (controlModal) {
      transcript.addChild(new Spacer(1));
      transcript.addChild(renderControlModal(controlModal));
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
    applyClientSurfaceEvent(e);
    scheduleRedraw();
  };
  client.onFrame = (f) => {
    state = applyFrame(state, f);
    scheduleRedraw();
  };
  client.onSnapshot = (snapshot) => {
    state = applySnapshot(state, snapshot);
    syncSnapshotApprovals(snapshot.pendingApprovals);
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
    activeRuns.clear();
    pendingApprovals.clear();
    controlModal = null;
    marker(
      `daemon restarted: history for session ${short(lost)} was lost (M1 in-memory store)`,
    );
    void (async () => {
      try {
        currentSession = await client.createSession(opts.freshSession);
        activeRuns.clear();
        pendingApprovals.clear();
        controlModal = null;
        marker(`continuing in fresh session ${short(currentSession)}`);
        await client.subscribe(currentSession, 0);
      } catch (err) {
        marker(`could not start a fresh session: ${message(err)}`);
      }
    })();
  };

  function applyClientSurfaceEvent(e: AgenaEvent): void {
    switch (e.type) {
      case "run.started": {
        const runId = stringProp(e.payload, "runId");
        if (runId) activeRuns.add(runId);
        return;
      }
      case "run.completed":
      case "run.aborted":
      case "run.failed": {
        const runId = stringProp(e.payload, "runId");
        if (runId) activeRuns.delete(runId);
        return;
      }
      case "approval.requested": {
        const parsed = approvalRequestedSchema.safeParse(e.payload);
        if (!parsed.success) return;
        const approval = parsed.data;
        queueApproval(approval);
        const label = approval.title ?? approval.kind;
        marker(
          `approval requested ${short(approval.approvalId)}: ${label}${approval.message ? ` - ${clip(approval.message)}` : ""}`,
        );
        return;
      }
      case "approval.responded": {
        const approvalId = stringProp(e.payload, "approvalId");
        if (!approvalId) return;
        clearApproval(approvalId);
        marker(`approval answered ${short(approvalId)}`);
        return;
      }
      case "approval.expired": {
        const approvalId = stringProp(e.payload, "approvalId");
        if (!approvalId) return;
        clearApproval(approvalId);
        marker(`approval expired ${short(approvalId)}`);
        return;
      }
      case "approval.cancelled": {
        const approvalId = stringProp(e.payload, "approvalId");
        if (!approvalId) return;
        clearApproval(approvalId);
        marker(`approval cancelled ${short(approvalId)}`);
        return;
      }
    }
  }

  function syncSnapshotApprovals(items: readonly unknown[]): void {
    const currentId =
      controlModal?.kind === "approval" ? controlModal.approvalId : null;
    pendingApprovals.clear();
    for (const item of items) {
      const parsed = approvalRequestedSchema.safeParse(item);
      if (parsed.success)
        pendingApprovals.set(parsed.data.approvalId, parsed.data);
    }
    if (currentId && !pendingApprovals.has(currentId)) controlModal = null;
    openNextApproval();
  }

  function queueApproval(approval: ApprovalRequested): void {
    pendingApprovals.set(approval.approvalId, approval);
    openNextApproval();
  }

  function clearApproval(approvalId: string): void {
    pendingApprovals.delete(approvalId);
    if (
      controlModal?.kind === "approval" &&
      controlModal.approvalId === approvalId
    )
      controlModal = null;
    openNextApproval();
  }

  function openNextApproval(): void {
    if (controlModal) return;
    const [approvalId] = pendingApprovals.keys();
    if (!approvalId) return;
    const approval = pendingApprovals.get(approvalId);
    controlModal = {
      kind: "approval",
      approvalId,
      input: approval?.defaultValue ?? "",
      selectedIndex: 0,
      submitting: false,
      error: null,
    };
  }

  function renderControlModal(modal: ControlModal): Text {
    if (modal.kind === "approval") return renderApprovalModal(modal);
    if (modal.kind === "compact") return renderCompactModal(modal);
    return renderSelectModal(modal);
  }

  function renderApprovalModal(modal: ApprovalModal): Text {
    const approval = pendingApprovals.get(modal.approvalId);
    if (!approval) return new Text(yellow("approval no longer pending"), 1, 0);
    const title = approval.title ?? `Approval ${short(approval.approvalId)}`;
    const rows = [
      `${yellow(bold("approval"))} ${dim(short(approval.approvalId))} · ${approval.kind}`,
      bold(title),
      approval.message,
    ];
    if (approval.kind === "confirm") {
      rows.push(dim("Y approve · N deny · Esc deny"));
    } else if (approval.kind === "select") {
      const options = approval.options ?? [];
      rows.push(
        ...options.map((option, index) => {
          const prefix = index === modal.selectedIndex ? cyan(">") : " ";
          return `${prefix} ${index + 1}. ${option.label}${option.description ? dim(` — ${option.description}`) : ""}`;
        }),
        dim("↑/↓ or J/K move · 1-9 choose · Enter select · Esc deny"),
      );
    } else {
      rows.push(
        `${cyan(">")} ${modal.input || dim("(empty)")}`,
        dim("type response · Enter submit · Backspace edit · Esc deny"),
      );
    }
    if (modal.submitting) rows.push(yellow("sending response..."));
    if (modal.error) rows.push(red(modal.error));
    return new Text(rows.join("\n"), 1, 0);
  }

  function renderSelectModal(modal: ModelModal | ThinkingModal): Text {
    const rows = [
      `${yellow(bold(modal.title))} · current ${modal.current}`,
      ...modal.options.map((option, index) => {
        const prefix = index === modal.selectedIndex ? cyan(">") : " ";
        return `${prefix} ${index + 1}. ${option.label}`;
      }),
      dim("↑/↓ or J/K move · 1-9 choose · Enter select · Esc close"),
    ];
    if (modal.submitting) rows.push(yellow("sending..."));
    if (modal.error) rows.push(red(modal.error));
    return new Text(rows.join("\n"), 1, 0);
  }

  function renderCompactModal(modal: CompactModal): Text {
    const rows = [
      yellow(bold("compact context")),
      "Compact this session's runtime context?",
      dim("Y/Enter compact · N/Esc close"),
    ];
    if (modal.submitting) rows.push(yellow("compacting..."));
    if (modal.error) rows.push(red(modal.error));
    return new Text(rows.join("\n"), 1, 0);
  }

  editor.onSubmit = (text) => {
    const t = text.trim();
    if (!t) return;
    transcriptPane.scrollToBottom();
    editor.addToHistory(t);
    const handled = handleSlash(t);
    if (handled) return;
    if (activeRuns.size > 0) {
      marker("turn active; use /steer <text>, /follow <text>, or /abort");
      return;
    }
    client
      .prompt(currentSession, t)
      .catch((err) => marker(`prompt failed: ${message(err)}`));
  };

  function handleSlash(text: string): boolean {
    if (!text.startsWith("/")) return false;
    const [raw, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(" ");
    const run = (label: string, promise: Promise<unknown>) => {
      promise
        .then(() => marker(`${label} sent`))
        .catch((err) => marker(`${label} failed: ${message(err)}`));
    };
    const show = (label: string, promise: Promise<void>) => {
      promise.catch((err) => marker(`${label} failed: ${message(err)}`));
    };
    switch (raw) {
      case "quit":
      case "exit":
        quitNow?.();
        return true;
      case "abort":
        run("abort", client.abort(currentSession));
        return true;
      case "compact":
        openCompactModal();
        return true;
      case "steer":
        run("steer", client.steer(currentSession, arg));
        return true;
      case "follow":
      case "follow-up":
        run("follow-up", client.followUp(currentSession, arg));
        return true;
      case "model":
        if (!arg.trim()) show("models", openModelPicker());
        else run("model", setModelFromRuntime(arg));
        return true;
      case "thinking":
        if (!arg.trim()) show("thinking", openThinkingPicker());
        else run("thinking", setThinkingFromRuntime(arg));
        return true;
      case "approve":
        run(
          "approval",
          respondFromText(rest[0], rest.slice(1).join(" "), false),
        );
        return true;
      case "deny":
        run("approval", respondFromText(rest[0], "", true));
        return true;
      default:
        marker(`unknown command /${raw}`);
        return true;
    }
  }

  async function respondFromText(
    approvalId: string | undefined,
    text: string,
    deny: boolean,
  ): Promise<void> {
    if (!approvalId) throw new Error("approval id required");
    const match = [...pendingApprovals.keys()].find((id) =>
      id.startsWith(approvalId),
    );
    const id = match ?? approvalId;
    const approval = pendingApprovals.get(id);
    const kind = approval?.kind ?? "input";
    const response = deny
      ? ({ kind: "deny" } as const)
      : kind === "confirm"
        ? ({ kind: "confirm", accepted: true } as const)
        : kind === "select"
          ? ({ kind: "select", optionId: text } as const)
          : ({ kind: kind === "editor" ? "editor" : "input", text } as const);
    await client.respondToApproval(currentSession, id, response);
  }

  function openCompactModal(): void {
    controlModal = { kind: "compact", submitting: false, error: null };
    scheduleRedraw();
  }

  async function openModelPicker(): Promise<void> {
    const info = await client.runtimeInfo(currentSession);
    const current = info.model
      ? `${info.model.provider}/${info.model.id}`
      : "none";
    controlModal = {
      kind: "model",
      title: "model",
      current,
      options: info.availableModels.map((model) => ({
        label: `${model.provider}/${model.id}`,
        value: model,
      })),
      selectedIndex: Math.max(
        0,
        info.availableModels.findIndex(
          (m) =>
            info.model &&
            m.provider === info.model.provider &&
            m.id === info.model.id,
        ),
      ),
      submitting: false,
      error: null,
    };
    scheduleRedraw();
  }

  async function openThinkingPicker(): Promise<void> {
    const info = await client.runtimeInfo(currentSession);
    controlModal = {
      kind: "thinking",
      title: "thinking",
      current: info.thinkingLevel,
      options: info.availableThinkingLevels.map((level) => ({
        label: level,
        value: level,
      })),
      selectedIndex: Math.max(
        0,
        info.availableThinkingLevels.indexOf(info.thinkingLevel),
      ),
      submitting: false,
      error: null,
    };
    scheduleRedraw();
  }

  async function setModelFromRuntime(value: string): Promise<unknown> {
    const model = await resolveRuntimeModel(value);
    return client.setModel(currentSession, model);
  }

  async function setThinkingFromRuntime(value: string): Promise<unknown> {
    const level = value.trim();
    const info = await client.runtimeInfo(currentSession);
    if (!info.availableThinkingLevels.includes(level as ThinkingLevel)) {
      throw new Error(
        `thinking level must be one of: ${info.availableThinkingLevels.join(", ")}`,
      );
    }
    return client.setThinkingLevel(currentSession, level as ThinkingLevel);
  }

  async function resolveRuntimeModel(value: string): Promise<ModelRef> {
    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1) {
      throw new Error("model must be provider/model");
    }
    const model = {
      provider: value.slice(0, slash),
      id: value.slice(slash + 1),
    };
    const info = await client.runtimeInfo(currentSession);
    if (
      !info.availableModels.some(
        (m) => m.provider === model.provider && m.id === model.id,
      )
    ) {
      throw new Error(
        `unknown model ${model.provider}/${model.id}; available ${formatChoices(
          info.availableModels.map((m) => `${m.provider}/${m.id}`),
        )}`,
      );
    }
    return model;
  }

  function handleApprovalInput(data: string): boolean {
    const modal = controlModal;
    if (!modal) return false;
    if (modal.kind === "model" || modal.kind === "thinking") {
      handleControlSelectInput(data, modal);
      return true;
    }
    if (modal.kind === "compact") {
      handleCompactInput(data, modal);
      return true;
    }
    const approval = pendingApprovals.get(modal.approvalId);
    if (!approval) {
      controlModal = null;
      openNextApproval();
      return true;
    }
    if (modal.submitting) return true;
    if (data === "\x1b") {
      void submitApproval({ kind: "deny" });
      return true;
    }
    if (approval.kind === "confirm") {
      if (data.toLowerCase() === "y") {
        void submitApproval({ kind: "confirm", accepted: true });
      } else if (data.toLowerCase() === "n") {
        void submitApproval({ kind: "deny" });
      }
      return true;
    }
    if (approval.kind === "select") {
      handleSelectApprovalInput(data, approval);
      return true;
    }
    handleTextApprovalInput(data, approval.kind);
    return true;
  }

  function handleSelectApprovalInput(
    data: string,
    approval: ApprovalRequested,
  ): void {
    const modal = controlModal?.kind === "approval" ? controlModal : null;
    if (!modal) return;
    const options = approval.options ?? [];
    if (options.length === 0) {
      void submitApproval({ kind: "deny" });
      return;
    }
    if (isEnter(data)) {
      const option = options[modal.selectedIndex] ?? options[0];
      if (!option) return;
      void submitApproval({ kind: "select", optionId: option.id });
      return;
    }
    const digit = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
    if (digit >= 0 && digit < options.length) {
      const option = options[digit];
      if (!option) return;
      void submitApproval({ kind: "select", optionId: option.id });
      return;
    }
    const delta =
      data === "\x1b[A" || data.toLowerCase() === "k"
        ? -1
        : data === "\x1b[B" || data.toLowerCase() === "j"
          ? 1
          : 0;
    if (delta === 0) return;
    modal.selectedIndex = clamp(
      modal.selectedIndex + delta,
      0,
      options.length - 1,
    );
    scheduleRedraw();
  }

  function handleTextApprovalInput(
    data: string,
    kind: "input" | "editor",
  ): void {
    const modal = controlModal?.kind === "approval" ? controlModal : null;
    if (!modal) return;
    if (isEnter(data)) {
      void submitApproval({ kind, text: modal.input });
      return;
    }
    if (data === "\x7f" || data === "\b") {
      modal.input = [...modal.input].slice(0, -1).join("");
      scheduleRedraw();
      return;
    }
    const text = printableAscii(data);
    if (!text) return;
    modal.input += text;
    scheduleRedraw();
  }

  async function submitApproval(response: ApprovalResponse): Promise<void> {
    const modal = controlModal?.kind === "approval" ? controlModal : null;
    if (!modal) return;
    controlModal = { ...modal, submitting: true, error: null };
    scheduleRedraw();
    try {
      await client.respondToApproval(
        currentSession,
        modal.approvalId,
        response,
      );
    } catch (err) {
      if (
        controlModal?.kind === "approval" &&
        controlModal.approvalId === modal.approvalId
      ) {
        controlModal = {
          ...controlModal,
          submitting: false,
          error: `response failed: ${message(err)}`,
        };
      }
      marker(`approval failed: ${message(err)}`);
    }
  }

  function handleControlSelectInput(
    data: string,
    modal: ModelModal | ThinkingModal,
  ): void {
    if (modal.submitting) return;
    if (data === "\x1b") {
      controlModal = null;
      openNextApproval();
      scheduleRedraw();
      return;
    }
    const option = pickOption<ModelRef | ThinkingLevel>(
      data,
      modal.options,
      modal.selectedIndex,
    );
    if (option) {
      void submitControlSelection(modal, option.value);
      return;
    }
    const delta = selectDelta(data);
    if (delta === 0) return;
    modal.selectedIndex = clamp(
      modal.selectedIndex + delta,
      0,
      modal.options.length - 1,
    );
    scheduleRedraw();
  }

  async function submitControlSelection(
    modal: ModelModal | ThinkingModal,
    value: ModelRef | ThinkingLevel,
  ): Promise<void> {
    controlModal = { ...modal, submitting: true, error: null };
    scheduleRedraw();
    try {
      if (modal.kind === "model") {
        await client.setModel(currentSession, value as ModelRef);
        marker("model sent");
      } else {
        await client.setThinkingLevel(currentSession, value as ThinkingLevel);
        marker("thinking sent");
      }
      if (controlModal?.kind === modal.kind) {
        controlModal = null;
        openNextApproval();
      }
    } catch (err) {
      if (controlModal?.kind === modal.kind) {
        controlModal = {
          ...controlModal,
          submitting: false,
          error: message(err),
        };
      }
    }
    scheduleRedraw();
  }

  function handleCompactInput(data: string, modal: CompactModal): void {
    if (modal.submitting) return;
    if (data === "\x1b" || data.toLowerCase() === "n") {
      controlModal = null;
      openNextApproval();
      scheduleRedraw();
      return;
    }
    if (isEnter(data) || data.toLowerCase() === "y") {
      void submitCompact(modal);
    }
  }

  async function submitCompact(modal: CompactModal): Promise<void> {
    controlModal = { ...modal, submitting: true, error: null };
    scheduleRedraw();
    try {
      await client.compact(currentSession);
      marker("compact sent");
      if (controlModal?.kind === "compact") {
        controlModal = null;
        openNextApproval();
      }
    } catch (err) {
      if (controlModal?.kind === "compact") {
        controlModal = {
          ...controlModal,
          submitting: false,
          error: message(err),
        };
      }
      marker(`compact failed: ${message(err)}`);
    }
    scheduleRedraw();
  }

  function scrollTranscript(data: string): boolean {
    if (activePane === "shell" || controlModal) return false;
    const page = Math.max(1, chatHeight() - 1);
    if (matchesKey(data, "pageUp") || matchesKey(data, "alt+up")) {
      transcriptPane.scroll(page);
      scheduleRedraw();
      return true;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "alt+down")) {
      transcriptPane.scroll(-page);
      scheduleRedraw();
      return true;
    }
    if (editor.getText().length > 0) return false;
    if (matchesKey(data, "home")) {
      transcriptPane.scrollToTop();
      scheduleRedraw();
      return true;
    }
    if (matchesKey(data, "end")) {
      transcriptPane.scrollToBottom();
      scheduleRedraw();
      return true;
    }
    return false;
  }

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
      quitNow = null;
      if (redrawTimer) clearTimeout(redrawTimer);
      if (shellReconnectTimer) clearTimeout(shellReconnectTimer);
      try {
        shellSocket?.close(1000, "client quit");
      } catch {
        // best effort; daemon reaps unattached PTYs after the idle window.
      }
      process.off("SIGWINCH", sendShellResize);
      tui.stop();
      process.stdout.write(EXIT_ALT_SCREEN);
      void client.close();
      resolve();
    }

    tui.addInputListener((data) => {
      if (handleApprovalInput(data)) return { consume: true };
      if (scrollTranscript(data)) return { consume: true };
      const action = routeKey(data, {
        shellFocused: activePane === "shell",
        shellVisible: shellPane.visible,
        editorEmpty: editor.getText().length === 0,
      });
      if (action === "pass") {
        return undefined; // focused component owns the key (shell PTY or editor)
      }
      if (action === "shell-input") {
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
          quit();
          break;
      }
      return { consume: true };
    });
    quitNow = quit;
    process.stdout.write(ENTER_ALT_SCREEN);
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

function stringProp(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
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

function isEnter(data: string): boolean {
  return data === "\r" || data === "\n";
}

function printableAscii(data: string): string {
  // TUI approval prompts are control surfaces; keep pasted escape/control bytes
  // out of the durable approval response.
  return data.replace(/[^\x20-\x7e]/g, "");
}

function selectDelta(data: string): number {
  if (data === "\x1b[A" || data.toLowerCase() === "k") return -1;
  if (data === "\x1b[B" || data.toLowerCase() === "j") return 1;
  return 0;
}

function pickOption<T>(
  data: string,
  options: Array<{ value: T }>,
  selectedIndex: number,
): { value: T } | undefined {
  if (options.length === 0) return undefined;
  if (isEnter(data)) return options[selectedIndex] ?? options[0];
  const digit = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
  return digit >= 0 && digit < options.length ? options[digit] : undefined;
}

function formatChoices(values: string[]): string {
  if (values.length === 0) return "(none)";
  const head = values.slice(0, 20).join(", ");
  return values.length > 20 ? `${head}, +${values.length - 20} more` : head;
}
