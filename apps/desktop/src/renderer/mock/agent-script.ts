// Scripted "agent": drives live turns over the World — text deltas word-by-word,
// streaming tool output, approvals that pause, steer pivots, aborts, follow-ups.
import type {
  ApprovalRequested,
  ApprovalResponse,
  ContentBlock,
  UsageTotals,
} from "@agena/protocol";
import {
  type LiveTool,
  type LiveTurn,
  type MockSession,
  SRC,
  ulid,
  type World,
} from "./world.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- streaming primitives -------------------------------------------------------

/** Word-by-word text deltas into blocks[blockIndex]; breaks early on steer. */
async function streamText(
  world: World,
  s: MockSession,
  turn: LiveTurn,
  blockIndex: number,
  text: string,
  wordMs = 30,
): Promise<void> {
  while (turn.blocks.length <= blockIndex) {
    turn.blocks.push({ type: "text", text: "" });
  }
  const block = turn.blocks[blockIndex];
  if (!block) return;
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    if (turn.aborted) return;
    const delta = (block.text.length > 0 ? " " : "") + (words[i] ?? "");
    block.text += delta;
    world.frame(s.summary.sessionId, "message.assistant.text.delta", {
      messageId: turn.messageId,
      blockIndex,
      delta,
    });
    if (turn.steerText !== null) return; // caller pivots
    await sleep(wordMs);
  }
}

async function streamToolOutput(
  world: World,
  s: MockSession,
  turn: LiveTurn,
  tool: LiveTool,
  lines: string[],
  lineMs: number,
): Promise<void> {
  for (const line of lines) {
    if (turn.aborted) return;
    const delta = `${line}\n`;
    tool.partialOutput += delta;
    world.frame(s.summary.sessionId, "tool.call.output.delta", {
      toolCallId: tool.toolCallId,
      delta,
    });
    await sleep(lineMs);
  }
}

/** If a steer arrived, stream a visible pivot paragraph; returns next free blockIndex. */
async function maybePivot(
  world: World,
  s: MockSession,
  turn: LiveTurn,
  nextBlockIndex: number,
): Promise<number> {
  if (turn.steerText === null || turn.aborted) return nextBlockIndex;
  const steer = turn.steerText.trim();
  turn.steerText = null;
  await streamText(
    world,
    s,
    turn,
    nextBlockIndex,
    `Adjusting approach — you said: "${steer}". Folding that in before continuing.`,
    35,
  );
  return nextBlockIndex + 1;
}

// ---- turn assembly ---------------------------------------------------------------

function contentOfTurn(turn: LiveTurn): ContentBlock[] {
  const content: ContentBlock[] = turn.blocks
    .filter((b) => b.text.length > 0)
    .map((b) => ({ type: b.type, text: b.text }));
  for (const t of turn.tools) {
    content.push({
      type: "toolCall",
      toolCallId: t.toolCallId,
      name: t.name,
      args: t.args,
    });
  }
  return content;
}

function usageOfTurn(turn: LiveTurn, promptLen: number): UsageTotals {
  const outChars = turn.blocks.reduce((n, b) => n + b.text.length, 0);
  const outputTokens = Math.max(64, Math.round(outChars / 4));
  const inputTokens = 2_400 + promptLen;
  return {
    inputTokens,
    outputTokens,
    costUsd: Math.round((inputTokens * 3 + outputTokens * 15) / 10_000) / 100,
  };
}

function finishTurn(
  world: World,
  s: MockSession,
  turn: LiveTurn,
  extraContent: ContentBlock[],
  promptLen: number,
): void {
  if (turn.aborted) return;
  const sessionId = s.summary.sessionId;
  const usage = usageOfTurn(turn, promptLen);
  world.append(
    sessionId,
    "message.assistant.completed",
    {
      messageId: turn.messageId,
      content: [...extraContent, ...contentOfTurn(turn)],
      model: turn.model,
      stopReason: "end_turn",
      usage,
    },
    SRC.runtime,
  );
  world.append(
    sessionId,
    "run.completed",
    { runId: turn.runId, usage },
    SRC.daemon,
  );
  s.live = null;
  world.setStatus(sessionId, "idle");
  const next = turn.followUps.shift();
  if (next)
    runScriptedTurn(world, sessionId, next.messageId, next.text, "followUp");
}

/** Abort the live turn: partial content becomes durable, run + tools wrap up. */
export function abortTurn(world: World, sessionId: string): boolean {
  const s = world.sessions.get(sessionId);
  const turn = s?.live;
  if (!s || !turn) return false;
  turn.aborted = true;
  if (turn.pendingApproval) {
    const { summary, resolve } = turn.pendingApproval;
    turn.pendingApproval = null;
    world.append(
      sessionId,
      "approval.cancelled",
      { approvalId: summary.approvalId, reason: "turn_aborted" },
      SRC.daemon,
    );
    resolve({ kind: "deny" });
  }
  for (const t of turn.tools) {
    if (t.done) continue;
    t.done = true;
    world.append(
      sessionId,
      "tool.call.aborted",
      {
        toolCallId: t.toolCallId,
        partialOutput: [{ type: "text", text: t.partialOutput }],
        reason: "user_abort",
      },
      SRC.daemon,
    );
  }
  world.append(
    sessionId,
    "message.assistant.aborted",
    {
      messageId: turn.messageId,
      partialContent: contentOfTurn(turn),
      reason: "user_abort",
    },
    SRC.runtime,
  );
  world.append(
    sessionId,
    "run.aborted",
    { runId: turn.runId, reason: "user_abort" },
    SRC.daemon,
  );
  s.live = null;
  world.setStatus(sessionId, "idle");
  return true;
}

// ---- generic prompt turn -----------------------------------------------------------

const GENERIC_TOOL_OUTPUT = [
  "src/auth/session.ts:31:  // TODO: expose sliding-window rate limit here",
  "src/auth/session.ts:58:  // TODO: emit a metric when a refresh joins an in-flight one",
  "src/auth/session.test.ts:9:// TODO: property-test the clock edge cases",
  "vite.config.ts:6:  // TODO: split vendor chunk once bundle passes 250kb",
];

const PUSH_OUTPUT = [
  "Enumerating objects: 9, done.",
  "Counting objects: 100% (9/9), done.",
  "Delta compression using up to 8 threads",
  "Compressing objects: 100% (5/5), done.",
  "Writing objects: 100% (5/5), 612 bytes | 612.00 KiB/s, done.",
  "To github.com:acme/repo-a.git",
  "   4c9e2d1..8d02f3a  main -> main",
];

/**
 * Runs a plausible scripted turn for any fresh prompt. Prompts containing
 * "deploy" or "push" gate the tool behind a confirm approval and PAUSE.
 */
export function runScriptedTurn(
  world: World,
  sessionId: string,
  userMessageId: string,
  promptText: string,
  trigger: "prompt" | "followUp",
): void {
  const s = world.sessions.get(sessionId);
  if (!s || s.live) return;
  const turn: LiveTurn = {
    runId: ulid(),
    turnId: ulid(),
    messageId: ulid(),
    model: s.runtime.model,
    blocks: [],
    tools: [],
    aborted: false,
    steerText: null,
    followUps: [],
    pendingApproval: null,
  };
  s.live = turn;
  world.setStatus(sessionId, "active");
  world.append(
    sessionId,
    "run.started",
    { runId: turn.runId, trigger, triggerMessageId: userMessageId },
    SRC.daemon,
  );
  world.append(
    sessionId,
    "message.assistant.started",
    {
      messageId: turn.messageId,
      runId: turn.runId,
      turnId: turn.turnId,
      model: turn.model,
      inResponseTo: userMessageId,
    },
    SRC.runtime,
  );

  const topic = (promptText.trim().split("\n")[0] ?? "that").slice(0, 120);
  const thinking = `The user asked: "${topic}". Ground the answer in the repo first — one quick scan, then a concrete response. If anything touches a remote, that needs an approval.`;
  const needsApproval = /deploy|push/i.test(promptText);

  void (async () => {
    await sleep(600);
    if (turn.aborted) return;

    let bi = 0;
    await streamText(
      world,
      s,
      turn,
      bi++,
      `On it. Taking "${topic}" from the top — first a quick look at the repo so the plan is grounded in what's actually here rather than guesswork.`,
    );
    bi = await maybePivot(world, s, turn, bi);
    if (turn.aborted) return;
    await sleep(500);

    await streamText(
      world,
      s,
      turn,
      bi++,
      needsApproval
        ? "This involves touching a remote, so I'll stage everything locally first and ask before anything leaves the machine. Running the command now — it will pause for your approval."
        : "The shape of this is small: one targeted command to see where things stand, then I'll summarize what I'd change and why. Running it now.",
    );
    bi = await maybePivot(world, s, turn, bi);
    if (turn.aborted) return;

    const tool: LiveTool = {
      toolCallId: ulid(),
      name: "bash",
      args: {
        command: needsApproval
          ? "git push origin main"
          : 'rg -n "TODO" src vite.config.ts',
        cwd: s.summary.cwd,
      },
      partialOutput: "",
      done: false,
    };
    turn.tools.push(tool);
    world.append(
      sessionId,
      "tool.call.started",
      {
        toolCallId: tool.toolCallId,
        messageId: turn.messageId,
        runId: turn.runId,
        turnId: turn.turnId,
        name: tool.name,
        args: tool.args,
      },
      SRC.runtime,
    );

    if (needsApproval) {
      const approvalId = ulid();
      const payload: ApprovalRequested = {
        approvalId,
        kind: "confirm",
        title: "Allow command?",
        message: "The agent wants to run a command that pushes to a remote.",
        subject: {
          toolName: "bash",
          command: "git push origin main",
          cwd: s.summary.cwd,
        },
        toolCallId: tool.toolCallId,
      };
      const ev = world.append(
        sessionId,
        "approval.requested",
        payload,
        SRC.daemon,
      );
      const response = await new Promise<ApprovalResponse>((resolve) => {
        turn.pendingApproval = {
          summary: {
            sessionId,
            branchId: s.summary.rootBranchId,
            seq: ev.seq,
            approvalId,
            requestedAt: ev.createdAt,
            payload,
          },
          resolve,
        };
      });
      turn.pendingApproval = null;
      if (turn.aborted) return;
      const accepted = response.kind === "confirm" && response.accepted;
      if (!accepted) {
        tool.done = true;
        world.append(
          sessionId,
          "tool.call.denied",
          { toolCallId: tool.toolCallId, approvalId, reason: "user_denied" },
          SRC.daemon,
        );
        await sleep(400);
        await streamText(
          world,
          s,
          turn,
          bi++,
          "Understood — leaving the remote alone. Everything stays committed locally; run the push yourself whenever you're ready and nothing else here is blocked on it.",
        );
        finishTurn(
          world,
          s,
          turn,
          [{ type: "thinking", text: thinking }],
          promptText.length,
        );
        return;
      }
    }

    await sleep(700);
    if (turn.aborted) return;
    await streamToolOutput(
      world,
      s,
      turn,
      tool,
      needsApproval ? PUSH_OUTPUT : GENERIC_TOOL_OUTPUT,
      220,
    );
    if (turn.aborted) return;
    tool.done = true;
    world.append(
      sessionId,
      "tool.call.completed",
      {
        toolCallId: tool.toolCallId,
        result: [{ type: "text", text: tool.partialOutput }],
        durationMs: 1900,
      },
      SRC.runtime,
    );

    await sleep(600);
    if (turn.aborted) return;
    bi = await maybePivot(world, s, turn, bi);
    await streamText(
      world,
      s,
      turn,
      bi++,
      needsApproval
        ? "Pushed cleanly — `main` is up to date on the remote and nothing was force-written. If CI flags anything on this commit I'd start with the newest test file, since that's the only surface that changed recently."
        : "That's the lay of the land. The TODOs above are the honest backlog; none of them block what you asked for, and the smallest next step is the one at the top of the list. Want me to take it?",
    );
    finishTurn(
      world,
      s,
      turn,
      [{ type: "thinking", text: thinking }],
      promptText.length,
    );
  })().catch((err) => console.warn("[mock] scripted turn failed", err));
}

// ---- session 2 continuation ----------------------------------------------------------

const PORTS_RG_OUTPUT = [
  "src/dock/README.md:4:- ports drawer (planned)",
  "src/dock/registry.ts:12:export type PortEntry = { port: number; pid: number; visibility: Visibility };",
  "src/dock/registry.ts:29:export async function listPorts(): Promise<PortEntry[]> {",
  "src/dock/registry.ts:41:  // polls /v1/ports; 2s interval while the drawer is open",
  'src/dock/DrawerShell.tsx:8:const PANES = ["terminal", "diagnostics"] as const;',
  "src/dock/DrawerShell.tsx:52:  // TODO: ports pane slots in here",
  "src/store/slices.ts:77:// visibility: private-by-default, mirrored from the daemon",
  "src/store/slices.ts:91:export const usePortsStore = create<PortsState>()(() => ({ entries: [] }));",
];

/**
 * Session 2's in-flight turn: seeded half-written by the fixtures, continued
 * live after the first subscribe's sync+snapshot (proves FN-2/FN-3 visually).
 */
export function attachPortsScript(world: World, sessionId: string): void {
  const s = world.sessions.get(sessionId);
  if (!s) return;
  s.onFirstSubscribe = () => {
    void continuePortsTurn(world, s).catch((err) =>
      console.warn("[mock] ports continuation failed", err),
    );
  };
}

async function continuePortsTurn(world: World, s: MockSession): Promise<void> {
  const turn = s.live;
  const tool = turn?.tools[0];
  if (!turn || !tool) return;
  const sessionId = s.summary.sessionId;

  await sleep(900);
  if (turn.aborted) return;

  // finish the half-written paragraph the snapshot carried
  await streamText(
    world,
    s,
    turn,
    0,
    "thin store slice that owns visibility and refresh state, and the copy-URL affordance that has to stay stable while the list refreshes underneath it. The scan below tells me how much of that scaffolding already exists.",
    55,
  );
  let bi = await maybePivot(world, s, turn, 1);
  if (turn.aborted) return;

  await sleep(1400);
  await streamToolOutput(world, s, turn, tool, PORTS_RG_OUTPUT, 420);
  if (turn.aborted) return;
  tool.done = true;
  world.append(
    sessionId,
    "tool.call.completed",
    {
      toolCallId: tool.toolCallId,
      result: [{ type: "text", text: tool.partialOutput }],
      durationMs: 3400,
    },
    SRC.runtime,
  );

  await sleep(2000);
  if (turn.aborted) return;
  bi = await maybePivot(world, s, turn, bi);
  await streamText(
    world,
    s,
    turn,
    bi++,
    "Good news — more exists than I expected. `registry.ts` already exposes `listPorts()` with the 2-second poll note, and `usePortsStore` is stubbed in the slices file, so the remaining work is genuinely just the pane: mount a `PortsPane` into `DrawerShell`'s pane list, subscribe it to the store, and drive the poll from pane visibility so a closed drawer costs nothing. The visibility badge maps straight off `PortEntry.visibility`, private-by-default exactly as the daemon mirrors it.",
    55,
  );
  bi = await maybePivot(world, s, turn, bi);
  if (turn.aborted) return;

  await sleep(1600);
  await streamText(
    world,
    s,
    turn,
    bi++,
    "For copy-URL I'll key rows by port number rather than array index so a refresh can't yank the row out from under a click, and the copied-tick state lives in the row, not the store. I'll wire the pane next, then the poll lifecycle, then the clipboard affordance — three small commits so each lands reviewable on its own.",
    55,
  );
  finishTurn(
    world,
    s,
    turn,
    [
      {
        type: "thinking",
        text: "Registry and store stubs already exist; the honest remaining scope is the pane itself plus poll lifecycle. Keep rows keyed by port so refreshes don't break the copy affordance.",
      },
    ],
    64,
  );
}
