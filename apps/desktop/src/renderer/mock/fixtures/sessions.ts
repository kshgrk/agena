// The four demo sessions: fully scripted, protocol-valid event logs.
import type {
  AgenaEvent,
  ContentBlock,
  EventSource,
  ModelRef,
  SessionSummary,
  UsageTotals,
} from "@agena/protocol";
import {
  DEFAULT_MODEL,
  type LiveTurn,
  type SessionSeed,
  SRC,
  ulid,
  WORKSPACE_ID,
} from "../world.ts";

export const PROJECT = {
  projectId: "prj_repoA",
  projectRoot: "/workspace/repo-a",
  cwd: "/workspace/repo-a",
} as const;

const OPUS: ModelRef = { provider: "pi", id: "claude-opus-5" };

// ---- log builder ---------------------------------------------------------------

class Log {
  readonly events: AgenaEvent[] = [];
  private readonly sessionId: string;
  private readonly branchId: string;
  private seq = 0;
  private t: number;

  constructor(sessionId: string, branchId: string, startMs: number) {
    this.sessionId = sessionId;
    this.branchId = branchId;
    this.t = startMs;
  }

  get lastAt(): string {
    return new Date(this.t).toISOString();
  }

  ev(
    type: string,
    payload: unknown,
    source: EventSource,
    stepMs = 4000,
  ): AgenaEvent {
    this.t += stepMs;
    const event: AgenaEvent = {
      sessionId: this.sessionId,
      branchId: this.branchId,
      seq: ++this.seq,
      v: 1,
      createdAt: new Date(this.t).toISOString(),
      source,
      type,
      payload,
    };
    this.events.push(event);
    return event;
  }
}

type ToolSpec = { id: string; name: string; args: unknown };
type TurnIds = { runId: string; turnId: string; userMessageId: string };

/** started → completed pair for one assistant segment; returns messageId. */
function assistant(
  l: Log,
  src: EventSource,
  model: ModelRef,
  ids: TurnIds,
  opts: {
    thinking?: string;
    text: string;
    tool?: ToolSpec;
    usage?: UsageTotals;
  },
): string {
  const messageId = ulid();
  l.ev(
    "message.assistant.started",
    {
      messageId,
      runId: ids.runId,
      turnId: ids.turnId,
      model,
      inResponseTo: ids.userMessageId,
    },
    src,
    2000,
  );
  const content: ContentBlock[] = [];
  if (opts.thinking) content.push({ type: "thinking", text: opts.thinking });
  content.push({ type: "text", text: opts.text });
  if (opts.tool) {
    content.push({
      type: "toolCall",
      toolCallId: opts.tool.id,
      name: opts.tool.name,
      args: opts.tool.args,
    });
  }
  l.ev(
    "message.assistant.completed",
    {
      messageId,
      content,
      model,
      stopReason: opts.tool ? "tool_use" : "end_turn",
      ...(opts.usage ? { usage: opts.usage } : {}),
    },
    src,
    5000,
  );
  return messageId;
}

function toolRun(
  l: Log,
  src: EventSource,
  ids: TurnIds,
  messageId: string,
  tool: ToolSpec,
  output: string,
  durationMs: number,
): void {
  l.ev(
    "tool.call.started",
    {
      toolCallId: tool.id,
      messageId,
      runId: ids.runId,
      turnId: ids.turnId,
      name: tool.name,
      args: tool.args,
    },
    src,
    1500,
  );
  l.ev(
    "tool.call.completed",
    {
      toolCallId: tool.id,
      result: [{ type: "text", text: output }],
      durationMs,
    },
    src,
    Math.max(1500, Math.min(durationMs, 12_000)),
  );
}

function summaryOf(
  l: Log,
  sessionId: string,
  branchId: string,
  createdAt: string,
  base: Omit<
    SessionSummary,
    | "sessionId"
    | "workspaceId"
    | "rootBranchId"
    | "lastSeq"
    | "createdAt"
    | "updatedAt"
  >,
): SessionSummary {
  return {
    sessionId,
    workspaceId: WORKSPACE_ID,
    rootBranchId: branchId,
    lastSeq: l.events.length,
    createdAt,
    updatedAt: l.lastAt,
    ...base,
  };
}

// ---- session 1: "Fix flaky auth test" (idle, rich completed history) --------------

const FAILING_TEST_OUTPUT = ` RUN  v3.0.4 /workspace/repo-a

 ✓ src/auth/session.test.ts > session refresh > extends expiry by a full ttl  (4ms)
 ✗ src/auth/session.test.ts > session refresh > only one of two concurrent refreshes mints tokens  (11ms)
 ✓ src/auth/session.test.ts > session refresh > rejects a revoked session  (2ms)

 FAIL  src/auth/session.test.ts > session refresh > only one of two concurrent refreshes mints tokens
AssertionError: expected 'f3a91c…' to be '7bd204…' // Object.is equality

- Expected  "7bd204e1c09a4d55b8f2a6e3d1c07f44"
+ Received  "f3a91c8b2e6f4a01b7d3c5e9f2a80c17"

 ❯ src/auth/session.test.ts:22:28
     20|       refreshSession(s.id, s.refreshToken, clock),
     21|     ]);
     22|     expect(a.refreshToken).toBe(b.refreshToken);
       |                            ^

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Duration  412ms`;

const PASSING_TEST_OUTPUT = ` RUN  v3.0.4 /workspace/repo-a

 ✓ src/auth/session.test.ts > session refresh > extends expiry by a full ttl  (4ms)
 ✓ src/auth/session.test.ts > session refresh > only one of two concurrent refreshes mints tokens  (6ms)
 ✓ src/auth/session.test.ts > session refresh > rejects a revoked session  (2ms)

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  389ms`;

const SESSION_PATCH = `--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -24,6 +24,10 @@ type Store = Map<string, Session>;
 const sessions: Store = new Map();

+// Serializes refreshes per session id: two concurrent refreshes for the same
+// session must not both mint tokens (that was the CI race).
+const refreshLocks = new Map<string, Promise<Session>>();
+
 export function issueSession(userId: string, clock: Clock = systemClock): Session {
@@ -41,12 +45,24 @@ export function getSession(id: string): Session | null {
-export async function refreshSession(
-  id: string,
-  token: string,
-  clock: Clock = systemClock,
-): Promise<Session> {
+export async function refreshSession(
+  id: string,
+  token: string,
+  clock: Clock = systemClock,
+): Promise<Session> {
+  const inFlight = refreshLocks.get(id);
+  if (inFlight) return inFlight;
+
+  const work = doRefresh(id, token, clock).finally(() => {
+    refreshLocks.delete(id);
+  });
+  refreshLocks.set(id, work);
+  return work;
+}
+
+async function doRefresh(id: string, token: string, clock: Clock): Promise<Session> {
   const current = sessions.get(id);`;

function buildAuthSession(): SessionSeed {
  const sessionId = ulid();
  const branchId = ulid();
  const l = new Log(sessionId, branchId, Date.UTC(2026, 6, 6, 9, 12, 0));
  const src = SRC.runtime;

  l.ev(
    "session.created",
    {
      workspaceId: WORKSPACE_ID,
      title: "Fix flaky auth test",
      runtime: "pi",
      origin: "native",
      scope: "project",
      ...PROJECT,
      rootBranchId: branchId,
    },
    SRC.daemon,
    0,
  );

  // a short prior run: locating the flake before asking for the fix
  const u0 = ulid();
  l.ev(
    "message.user.created",
    {
      messageId: u0,
      content: [
        {
          type: "text",
          text: "Which CI job is the flaky one? It's been red on and off all week.",
        },
      ],
    },
    SRC.user(),
    8000,
  );
  const ids0: TurnIds = { runId: ulid(), turnId: ulid(), userMessageId: u0 };
  l.ev(
    "run.started",
    { runId: ids0.runId, trigger: "prompt", triggerMessageId: u0 },
    SRC.daemon,
    400,
  );
  const t0: ToolSpec = {
    id: ulid(),
    name: "bash",
    args: { command: "gh run list --workflow ci --limit 8", cwd: PROJECT.cwd },
  };
  const m0 = assistant(l, src, DEFAULT_MODEL, ids0, {
    text: "Pulling the recent CI history to see which job flaps.",
    tool: t0,
  });
  toolRun(
    l,
    src,
    ids0,
    m0,
    t0,
    `completed  failure  main  ci  #4182  2m11s
completed  success  main  ci  #4181  2m04s
completed  success  main  ci  #4180  2m09s
completed  failure  main  ci  #4177  2m18s
completed  success  main  ci  #4176  2m02s
completed  success  main  ci  #4175  2m07s
completed  failure  main  ci  #4171  2m13s
completed  success  main  ci  #4170  2m05s`,
    1840,
  );
  assistant(l, src, DEFAULT_MODEL, ids0, {
    text: "It's the `test` job — roughly 1 red in every 4-5 runs, and every failure is the same assertion: `session refresh > only one of two concurrent refreshes mints tokens`. That's a concurrency flake in the code, not the test runner.",
    usage: { inputTokens: 6_310, outputTokens: 420, costUsd: 0.03 },
  });
  l.ev(
    "run.completed",
    {
      runId: ids0.runId,
      usage: { inputTokens: 6_310, outputTokens: 420, costUsd: 0.03 },
    },
    SRC.daemon,
    500,
  );

  const userMessageId = ulid();
  l.ev(
    "message.user.created",
    {
      messageId: userMessageId,
      content: [
        {
          type: "text",
          text: `The auth test suite is flaky — \`session refresh\` fails maybe 1 in 5 CI runs with mismatched refresh tokens:

\`\`\`ts
const [a, b] = await Promise.all([
  refreshSession(s.id, s.refreshToken, clock),
  refreshSession(s.id, s.refreshToken, clock),
]);
expect(a.refreshToken).toBe(b.refreshToken);
\`\`\`

Can you find the race, fix it, and push once the suite is green?`,
        },
      ],
    },
    SRC.user(),
    10_000,
  );

  const ids: TurnIds = { runId: ulid(), turnId: ulid(), userMessageId };
  l.ev(
    "run.started",
    { runId: ids.runId, trigger: "prompt", triggerMessageId: userMessageId },
    SRC.daemon,
    500,
  );

  // 1. reproduce
  const t1: ToolSpec = {
    id: ulid(),
    name: "bash",
    args: { command: "pnpm test auth --run", cwd: PROJECT.cwd },
  };
  let m = assistant(l, src, DEFAULT_MODEL, ids, {
    thinking:
      "A flaky concurrent-refresh test almost always means two refreshes race the same store slot. Reproduce first, then read the implementation.",
    text: "Let me reproduce the failure first so we're fixing the real thing.",
    tool: t1,
  });
  toolRun(l, src, ids, m, t1, FAILING_TEST_OUTPUT, 4120);

  // 1b. read the failing test itself
  const t1b: ToolSpec = {
    id: ulid(),
    name: "bash",
    args: {
      command: "sed -n '10,26p' src/auth/session.test.ts",
      cwd: PROJECT.cwd,
    },
  };
  m = assistant(l, src, DEFAULT_MODEL, ids, {
    text: "Failure reproduced on the first try locally — good sign it's a genuine race. Reading the test to see exactly what it demands.",
    tool: t1b,
  });
  toolRun(
    l,
    src,
    ids,
    m,
    t1b,
    `  it("only one of two concurrent refreshes mints tokens", async () => {
    const clock = fixedClock(1_000_000);
    const s = issueSession("u2", clock);
    const [a, b] = await Promise.all([
      refreshSession(s.id, s.refreshToken, clock),
      refreshSession(s.id, s.refreshToken, clock),
    ]);
    expect(a.refreshToken).toBe(b.refreshToken);
  });`,
    260,
  );

  // 2. read the file
  const t2: ToolSpec = {
    id: ulid(),
    name: "bash",
    args: { command: "sed -n '1,60p' src/auth/session.ts", cwd: PROJECT.cwd },
  };
  m = assistant(l, src, DEFAULT_MODEL, ids, {
    text: "Reproduced — the concurrent-refresh test fails intermittently. Reading the implementation to find where the two refreshes diverge.",
    tool: t2,
  });
  toolRun(
    l,
    src,
    ids,
    m,
    t2,
    `export async function refreshSession(
  id: string,
  token: string,
  clock: Clock = systemClock,
): Promise<Session> {
  const current = sessions.get(id);
  if (!current) throw new Error("session not found");
  if (current.refreshToken !== token) throw new Error("bad refresh token");
  // ...mints a fresh refreshToken and writes it back to the map
}`,
    310,
  );

  // 3. find callers
  const t3: ToolSpec = {
    id: ulid(),
    name: "bash",
    args: { command: 'rg -n "refreshSession" src', cwd: PROJECT.cwd },
  };
  m = assistant(l, src, DEFAULT_MODEL, ids, {
    text: "There it is: `refreshSession` reads the current session, then writes a new token — two concurrent calls both pass the token check before either write lands. Checking callers before I change the signature.",
    tool: t3,
  });
  toolRun(
    l,
    src,
    ids,
    m,
    t3,
    `src/auth/session.ts:38:export async function refreshSession(
src/auth/session.test.ts:12:import { issueSession, refreshSession, revokeSession } from "./session.ts";
src/auth/session.test.ts:20:      refreshSession(s.id, s.refreshToken, clock),
src/auth/session.test.ts:21:      refreshSession(s.id, s.refreshToken, clock),`,
    280,
  );

  // 4. apply the fix
  const t4: ToolSpec = {
    id: ulid(),
    name: "edit",
    args: { path: "src/auth/session.ts", patch: SESSION_PATCH },
  };
  m = assistant(l, src, DEFAULT_MODEL, ids, {
    thinking:
      "Per-session promise lock: the second concurrent caller awaits the first's in-flight refresh and gets the same Session back. Smallest fix that is actually the root cause.",
    text: "The fix: serialize refreshes per session id with an in-flight promise map. The second concurrent caller joins the first refresh instead of minting its own token.",
    tool: t4,
  });
  toolRun(
    l,
    src,
    ids,
    m,
    t4,
    "Applied 2 hunks to src/auth/session.ts (+18 −5). refreshSession now delegates to doRefresh behind refreshLocks.",
    190,
  );

  // 5. rerun the failing test
  const t5: ToolSpec = {
    id: ulid(),
    name: "bash",
    args: { command: "pnpm test auth --run", cwd: PROJECT.cwd },
  };
  m = assistant(l, src, DEFAULT_MODEL, ids, {
    text: "Re-running the auth suite to confirm.",
    tool: t5,
  });
  toolRun(l, src, ids, m, t5, PASSING_TEST_OUTPUT, 3890);

  // 6. loop it to prove flakiness is gone
  const t6: ToolSpec = {
    id: ulid(),
    name: "bash",
    args: {
      command:
        "for i in 1 2 3 4 5; do pnpm test auth --run --silent || break; done",
      cwd: PROJECT.cwd,
    },
  };
  m = assistant(l, src, DEFAULT_MODEL, ids, {
    text: "Green. Since this was a 1-in-5 flake, one pass proves nothing — running it five times back to back.",
    tool: t6,
  });
  toolRun(
    l,
    src,
    ids,
    m,
    t6,
    `run 1: Tests 3 passed (3) — 401ms
run 2: Tests 3 passed (3) — 388ms
run 3: Tests 3 passed (3) — 395ms
run 4: Tests 3 passed (3) — 383ms
run 5: Tests 3 passed (3) — 390ms`,
    19_600,
  );

  // 7. commit
  const t7: ToolSpec = {
    id: ulid(),
    name: "bash",
    args: {
      command:
        'git add src/auth/session.ts && git commit -m "fix: serialize concurrent session refreshes"',
      cwd: PROJECT.cwd,
    },
  };
  m = assistant(l, src, DEFAULT_MODEL, ids, {
    text: "Five clean passes. Committing the fix.",
    tool: t7,
  });
  toolRun(
    l,
    src,
    ids,
    m,
    t7,
    `[main 4c9e2d1] fix: serialize concurrent session refreshes
 1 file changed, 18 insertions(+), 5 deletions(-)`,
    620,
  );

  // 8. push — gated behind an approval
  const t8: ToolSpec = {
    id: ulid(),
    name: "bash",
    args: { command: "git push origin main", cwd: PROJECT.cwd },
  };
  m = assistant(l, src, DEFAULT_MODEL, ids, {
    text: "You asked me to push once green — pushing now (this needs your approval).",
    tool: t8,
  });
  l.ev(
    "tool.call.started",
    {
      toolCallId: t8.id,
      messageId: m,
      runId: ids.runId,
      turnId: ids.turnId,
      name: t8.name,
      args: t8.args,
    },
    src,
    1500,
  );
  const approvalId = ulid();
  l.ev(
    "approval.requested",
    {
      approvalId,
      kind: "confirm",
      title: "Allow command?",
      message: "The agent wants to push commits to a remote.",
      subject: {
        toolName: "bash",
        command: "git push origin main",
        cwd: PROJECT.cwd,
      },
      toolCallId: t8.id,
    },
    SRC.daemon,
    800,
  );
  l.ev(
    "approval.responded",
    {
      approvalId,
      response: { kind: "confirm", accepted: true },
      respondedBy: "desktop-mock",
    },
    SRC.daemon,
    9000,
  );
  l.ev(
    "tool.call.completed",
    {
      toolCallId: t8.id,
      result: [
        {
          type: "text",
          text: `To github.com:acme/repo-a.git
   9f31ab2..4c9e2d1  main -> main`,
        },
      ],
      durationMs: 2140,
    },
    src,
    2500,
  );

  // markers: user tweaked model + thinking mid-session
  l.ev(
    "model.changed",
    { from: DEFAULT_MODEL, to: OPUS, reason: "user_selected" },
    SRC.daemon,
    3000,
  );
  l.ev(
    "thinking.level.changed",
    { from: "medium", to: "high" },
    SRC.daemon,
    800,
  );

  // final summary
  assistant(l, src, OPUS, ids, {
    text: `Done. Summary of the fix:

- **Root cause** — \`refreshSession\` read the session, validated the token, then wrote a new one with no coordination; two concurrent refreshes both passed validation and each minted a token, so one caller held a stale token.
- **Fix** — a per-session in-flight promise map (\`refreshLocks\`): concurrent callers join the same refresh and receive the same \`Session\`.
- **Verified** — the previously flaky test passed 5/5 consecutive runs; full suite green.
- **Shipped** — committed as \`4c9e2d1\` and pushed to \`origin/main\`.`,
    usage: { inputTokens: 48_213, outputTokens: 3_120, costUsd: 0.19 },
  });
  l.ev(
    "run.completed",
    {
      runId: ids.runId,
      usage: { inputTokens: 48_213, outputTokens: 3_120, costUsd: 0.19 },
    },
    SRC.daemon,
    500,
  );

  // post-run shell activity (terminal lifecycle + runtime message)
  const terminalId = ulid();
  l.ev(
    "terminal.session.started",
    { terminalId, shell: "/bin/zsh", cols: 120, rows: 32 },
    SRC.terminal,
    60_000,
  );
  l.ev(
    "message.runtime.created",
    {
      messageId: ulid(),
      runtimeType: "bash",
      content: [
        { type: "text", text: "pnpm lint → clean (0 errors, 0 warnings)" },
      ],
      meta: { command: "pnpm lint", exitCode: 0 },
    },
    SRC.daemon,
    22_000,
  );
  l.ev(
    "terminal.session.ended",
    { terminalId, exitCode: 0, reason: "exit" },
    SRC.daemon,
    5000,
  );

  return {
    summary: summaryOf(
      l,
      sessionId,
      branchId,
      l.events[0]?.createdAt ?? l.lastAt,
      {
        title: "Fix flaky auth test",
        scope: "project",
        status: "idle",
        ...PROJECT,
      },
    ),
    events: l.events,
    live: null,
    runtime: { model: OPUS, thinkingLevel: "high" },
  };
}

// ---- session 2: "Add ports drawer" (active, ends mid-turn) ------------------------

export type PortsSeed = SessionSeed & { live: LiveTurn };

function buildPortsSession(): PortsSeed {
  const sessionId = ulid();
  const branchId = ulid();
  const l = new Log(sessionId, branchId, Date.UTC(2026, 6, 7, 8, 30, 0));
  const src = SRC.runtime;

  l.ev(
    "session.created",
    {
      workspaceId: WORKSPACE_ID,
      title: "Add ports drawer",
      runtime: "pi",
      origin: "native",
      scope: "project",
      ...PROJECT,
      rootBranchId: branchId,
    },
    SRC.daemon,
    0,
  );

  // one completed prior turn
  const u1 = ulid();
  l.ev(
    "message.user.created",
    {
      messageId: u1,
      content: [
        {
          type: "text",
          text: "Sketch a plan for a ports drawer in the bottom dock — detected ports, copy preview URL, open external.",
        },
      ],
    },
    SRC.user(),
    8000,
  );
  const ids1: TurnIds = { runId: ulid(), turnId: ulid(), userMessageId: u1 };
  l.ev(
    "run.started",
    { runId: ids1.runId, trigger: "prompt", triggerMessageId: u1 },
    SRC.daemon,
    400,
  );
  const pt: ToolSpec = {
    id: ulid(),
    name: "bash",
    args: { command: "ls src", cwd: PROJECT.cwd },
  };
  const m1 = assistant(l, src, DEFAULT_MODEL, ids1, {
    thinking:
      "Small feature, but it touches dock layout, a poller, and clipboard access. Check what exists first.",
    text: "Quick look at the current layout before proposing anything.",
    tool: pt,
  });
  toolRun(l, src, ids1, m1, pt, "auth", 140);
  assistant(l, src, DEFAULT_MODEL, ids1, {
    text: `Plan, smallest-first:

1. **Registry poll** — hit the daemon's port registry on a 2s interval while the drawer is open; no polling when closed.
2. **Drawer UI** — a table in the bottom dock: port, process, visibility badge, copy-URL, open-external.
3. **Copy affordance** — clipboard write with a 1.5s "copied" tick; keep the row stable while the list refreshes.

Say the word and I'll wire it up.`,
    usage: { inputTokens: 9_140, outputTokens: 860, costUsd: 0.04 },
  });
  l.ev(
    "run.completed",
    {
      runId: ids1.runId,
      usage: { inputTokens: 9_140, outputTokens: 860, costUsd: 0.04 },
    },
    SRC.daemon,
    400,
  );

  // second prompt: the turn that is still in flight
  const u2 = ulid();
  l.ev(
    "message.user.created",
    {
      messageId: u2,
      content: [
        { type: "text", text: "Sounds right — go ahead and wire it up." },
      ],
    },
    SRC.user(),
    30_000,
  );
  const runId = ulid();
  const turnId = ulid();
  const messageId = ulid();
  l.ev(
    "run.started",
    { runId, trigger: "prompt", triggerMessageId: u2 },
    SRC.daemon,
    400,
  );
  l.ev(
    "message.assistant.started",
    { messageId, runId, turnId, model: DEFAULT_MODEL, inResponseTo: u2 },
    src,
    1200,
  );
  const liveToolId = ulid();
  const liveToolArgs = {
    command: 'rg -n "ports|drawer" src --type ts',
    cwd: PROJECT.cwd,
  };
  l.ev(
    "tool.call.started",
    {
      toolCallId: liveToolId,
      messageId,
      runId,
      turnId,
      name: "bash",
      args: liveToolArgs,
    },
    src,
    2500,
  );
  // NOTE: no terminal event — this turn is in flight; snapshot carries the tail.

  const live: LiveTurn = {
    runId,
    turnId,
    messageId,
    model: DEFAULT_MODEL,
    blocks: [
      {
        type: "text",
        text: "Starting with the registry poll since everything else hangs off its shape. The drawer needs three pieces: a poller against the daemon registry, a",
      },
    ],
    tools: [
      {
        toolCallId: liveToolId,
        name: "bash",
        args: liveToolArgs,
        partialOutput: "src/dock/README.md:4:- ports drawer (planned)\n",
        done: false,
      },
    ],
    aborted: false,
    steerText: null,
    followUps: [],
    pendingApproval: null,
  };

  return {
    summary: summaryOf(
      l,
      sessionId,
      branchId,
      l.events[0]?.createdAt ?? l.lastAt,
      {
        title: "Add ports drawer",
        scope: "project",
        status: "active",
        ...PROJECT,
      },
    ),
    events: l.events,
    live,
  };
}

// ---- session 3: "spike: xterm renderer" (global, 8 events) ------------------------

function buildSpikeSession(): SessionSeed {
  const sessionId = ulid();
  const branchId = ulid();
  const l = new Log(sessionId, branchId, Date.UTC(2026, 6, 5, 14, 0, 0));
  const src = SRC.runtime;

  l.ev(
    "session.created",
    {
      workspaceId: WORKSPACE_ID,
      title: "spike: xterm renderer",
      runtime: "pi",
      origin: "native",
      scope: "global",
      cwd: "/workspace",
      rootBranchId: branchId,
    },
    SRC.daemon,
    0,
  );
  const u = ulid();
  l.ev(
    "message.user.created",
    {
      messageId: u,
      content: [
        {
          type: "text",
          text: "Is the webgl addon worth it for xterm here, or is the canvas renderer fine?",
        },
      ],
    },
    SRC.user(),
    5000,
  );
  const runId = ulid();
  const turnId = ulid();
  l.ev(
    "run.started",
    { runId, trigger: "prompt", triggerMessageId: u },
    SRC.daemon,
    300,
  );
  // Exactly 8 events: tool runs while the assistant message is in flight (the
  // real streaming order), then one completed message closes the turn.
  const messageId = ulid();
  l.ev(
    "message.assistant.started",
    { messageId, runId, turnId, model: DEFAULT_MODEL, inResponseTo: u },
    src,
    1000,
  );
  const toolCallId = ulid();
  const toolArgs = { command: "npm view @xterm/addon-webgl version" };
  l.ev(
    "tool.call.started",
    { toolCallId, messageId, runId, turnId, name: "bash", args: toolArgs },
    src,
    2000,
  );
  l.ev(
    "tool.call.completed",
    { toolCallId, result: [{ type: "text", text: "0.19.0" }], durationMs: 880 },
    src,
    1500,
  );
  l.ev(
    "message.assistant.completed",
    {
      messageId,
      content: [
        {
          type: "text",
          text: "Checking the current addon version, then the short answer.",
        },
        { type: "toolCall", toolCallId, name: "bash", args: toolArgs },
        {
          type: "text",
          text: "Short answer: yes, use webgl with a fit-addon fallback. It matters exactly when your demo does — long scrollback under fast streaming output. Keep the canvas renderer as the automatic fallback when the webgl context is lost.",
        },
      ],
      model: DEFAULT_MODEL,
      stopReason: "end_turn",
      usage: { inputTokens: 4_020, outputTokens: 310, costUsd: 0.02 },
    },
    src,
    6000,
  );
  l.ev(
    "run.completed",
    { runId, usage: { inputTokens: 4_020, outputTokens: 310, costUsd: 0.02 } },
    SRC.daemon,
    300,
  );

  return {
    summary: summaryOf(
      l,
      sessionId,
      branchId,
      l.events[0]?.createdAt ?? l.lastAt,
      {
        title: "spike: xterm renderer",
        scope: "global",
        status: "idle",
        cwd: "/workspace",
      },
    ),
    events: l.events,
    live: null,
  };
}

// ---- session 4: imported "claude: migrate to pnpm" (20 events) --------------------

function buildImportedSession(): SessionSeed {
  const sessionId = ulid();
  const branchId = ulid();
  const l = new Log(sessionId, branchId, Date.UTC(2026, 5, 28, 11, 0, 0));
  const src = SRC.importer;

  l.ev(
    "session.created",
    {
      workspaceId: WORKSPACE_ID,
      title: "claude: migrate to pnpm",
      runtime: "pi",
      origin: "import.claude",
      scope: "project",
      ...PROJECT,
      rootBranchId: branchId,
    },
    src,
    0,
  );

  const u1 = ulid();
  l.ev(
    "message.user.created",
    {
      messageId: u1,
      content: [
        {
          type: "text",
          text: "Migrate this repo from npm to pnpm. Keep CI green.",
        },
      ],
    },
    src,
    6000,
  );
  const ids: TurnIds = { runId: ulid(), turnId: ulid(), userMessageId: u1 };
  l.ev(
    "run.started",
    { runId: ids.runId, trigger: "prompt", triggerMessageId: u1 },
    src,
    300,
  );

  const t1: ToolSpec = {
    id: ulid(),
    name: "bash",
    args: { command: "cat package-lock.json | head -5", cwd: PROJECT.cwd },
  };
  let m = assistant(l, src, DEFAULT_MODEL, ids, {
    text: "Checking the lockfile version first — that decides the import path.",
    tool: t1,
  });
  toolRun(
    l,
    src,
    ids,
    m,
    t1,
    `{
  "name": "repo-a",
  "version": "0.4.2",
  "lockfileVersion": 3,`,
    120,
  );

  const t2: ToolSpec = {
    id: ulid(),
    name: "bash",
    args: { command: "pnpm import && rm package-lock.json", cwd: PROJECT.cwd },
  };
  m = assistant(l, src, DEFAULT_MODEL, ids, {
    text: "Lockfile v3 — `pnpm import` handles it directly. Converting and removing the npm lockfile.",
    tool: t2,
  });
  toolRun(
    l,
    src,
    ids,
    m,
    t2,
    "Lockfile converted: package-lock.json → pnpm-lock.yaml (214 packages)",
    3400,
  );

  const t3: ToolSpec = {
    id: ulid(),
    name: "edit",
    args: {
      path: ".github/workflows/ci.yml",
      patch: `-      - run: npm ci
-      - run: npm test
+      - uses: pnpm/action-setup@v4
+      - run: pnpm install --frozen-lockfile
+      - run: pnpm test --run`,
    },
  };
  m = assistant(l, src, DEFAULT_MODEL, ids, {
    text: "Updating CI to install pnpm and use the frozen lockfile.",
    tool: t3,
  });
  toolRun(
    l,
    src,
    ids,
    m,
    t3,
    "Applied 1 hunk to .github/workflows/ci.yml (+3 −2).",
    150,
  );

  const t4: ToolSpec = {
    id: ulid(),
    name: "bash",
    args: {
      command: "pnpm install --frozen-lockfile && pnpm test --run",
      cwd: PROJECT.cwd,
    },
  };
  m = assistant(l, src, DEFAULT_MODEL, ids, {
    text: "Verifying the whole thing end to end.",
    tool: t4,
  });
  toolRun(
    l,
    src,
    ids,
    m,
    t4,
    `Packages: +214
Progress: resolved 214, reused 214, downloaded 0, added 214, done

 Test Files  6 passed (6)
      Tests  41 passed (41)
   Duration  2.31s`,
    28_400,
  );

  assistant(l, src, DEFAULT_MODEL, ids, {
    text: "Migration complete: `pnpm-lock.yaml` generated via `pnpm import`, npm lockfile removed, CI switched to `pnpm/action-setup` with a frozen-lockfile install. Full suite passes (41/41).",
    usage: { inputTokens: 22_400, outputTokens: 1_480, costUsd: 0.09 },
  });
  l.ev("run.completed", { runId: ids.runId }, src, 300);

  return {
    summary: summaryOf(
      l,
      sessionId,
      branchId,
      l.events[0]?.createdAt ?? l.lastAt,
      {
        title: "claude: migrate to pnpm",
        scope: "project",
        status: "idle",
        ...PROJECT,
      },
    ),
    events: l.events,
    live: null,
  };
}

// ---- entry -------------------------------------------------------------------------

export type FixtureIds = {
  auth: string;
  ports: string;
  spike: string;
  imported: string;
};

export function buildFixtureSessions(): {
  seeds: SessionSeed[];
  ids: FixtureIds;
} {
  const auth = buildAuthSession();
  const ports = buildPortsSession();
  const spike = buildSpikeSession();
  const imported = buildImportedSession();
  return {
    seeds: [auth, ports, spike, imported],
    ids: {
      auth: auth.summary.sessionId,
      ports: ports.summary.sessionId,
      spike: spike.summary.sessionId,
      imported: imported.summary.sessionId,
    },
  };
}
