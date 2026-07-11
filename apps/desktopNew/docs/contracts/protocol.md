# Agena Wire Protocol Contract

Source of truth: `packages/protocol/src/` (`@agena/protocol`, zod schemas). This doc is the
complete renderer-facing contract. All types below are the TypeScript shapes inferred from
those schemas — treat them as exact. Import from `@agena/protocol` where possible instead of
redeclaring.

- **Protocol version:** `PROTOCOL_VERSION = 1`, `MIN_SUPPORTED_PROTOCOL_VERSION = 1`
- **Main WS endpoint:** `WS_PATH = "/v1/ws"`, subprotocol `WS_SUBPROTOCOL = "agena.v1"`
- **Auth:** HTTP routes require `Authorization: Bearer <token>`. WS upgrades (`/v1/ws`,
  `/v1/ptys/:id/ws`, `/v1/tunnels/:n/ws`) accept the Bearer header **or** a `?token=<token>`
  query param (browsers cannot set WS headers; both are timing-safe compared). The daemon
  serves CORS on `/v1/*` (echoed origin, `authorization`/`content-type` headers) so
  cross-origin browser clients pass preflight.
- Two version axes: the connection-level `protocolVersion` (handshake) and a per-event
  payload version `v` (every known event payload is currently `v: 1`).

---

## 1. WS envelope layer

Every JSON message on the main WS is exactly one member of this discriminated union on `kind`:

```ts
type WireEnvelope =
  | HelloEnvelope                        // kind: "hello"   (client → daemon, first message)
  | WelcomeEnvelope                      // kind: "welcome" (daemon → client)
  | CmdEnvelope                          // kind: "cmd"     (client → daemon)
  | AckEnvelope                          // kind: "ack"     (daemon → client)
  | ErrorEnvelope                        // kind: "error"   (daemon → client)
  | EventEnvelope                        // kind: "event"   (daemon → client, durable)
  | FrameEnvelope                        // kind: "frame"   (daemon → client, ephemeral)
  | SyncEnvelope                         // kind: "sync"    (daemon → client, end-of-replay)
  | SnapshotEnvelope                     // kind: "snapshot" (daemon → client, in-flight state)
  | PingEnvelope                         // kind: "ping"
  | PongEnvelope                         // kind: "pong"
  | VisibleBrowserRequestEnvelope        // kind: "visibleBrowserRequest" (daemon → client)
  | VisibleBrowserResponseEnvelope;      // kind: "visibleBrowserResponse" (client → daemon)
```

### 1.1 Handshake

Client sends `hello` first; daemon replies `welcome`, or an `error` envelope followed by
close code `4400`. No `hello` within `HELLO_TIMEOUT_MS` (10 s) → close `4408`.

```ts
interface HelloEnvelope {
  kind: "hello";
  protocolVersion: number;          // send PROTOCOL_VERSION (1)
  client: {
    name: string;
    version: string;
    platform: string;
    capabilities?: string[];        // include "visible_browser" (VISIBLE_BROWSER_CAPABILITY)
  };                                //   if the client can serve visibleBrowserRequest
  clientId: string;                 // stable ULID per installed client; becomes
}                                   //   EventSource.clientId on user-sourced events

interface WelcomeEnvelope {
  kind: "welcome";
  protocolVersion: number;
  daemonVersion: string;
  serverTime: string;               // ISO timestamp
  limits: WireLimits;               // { maxEnvelopeBytes, maxPromptBytes, maxSubscriptions }
}
```

### 1.2 Command / ack / error

Client mints a ULID `requestId` per command. **Exactly one terminal `ack` or `error` per
cmd.** Payload is validated per-name (invalid → `INVALID_PAYLOAD` error).

```ts
interface CmdEnvelope   { kind: "cmd";   requestId: string; name: CommandName; payload: unknown; }
interface AckEnvelope   { kind: "ack";   requestId: string; result?: unknown; }
interface ErrorEnvelope { kind: "error"; requestId?: string; error: AgenaError; }
// requestId absent on ErrorEnvelope = connection-level error, not tied to a command
```

Client-side per-command timeout: `COMMAND_ACK_TIMEOUT_MS = 30_000`.
Request dedupe TTL on the daemon: `REQUEST_DEDUPE_TTL_MS = 300_000`.

### 1.3 Event / frame / sync / snapshot delivery

```ts
interface EventEnvelope {
  kind: "event";
  event: AgenaEvent;    // strict seq order, gap-free, per subscription
  replayed: boolean;    // true during replay — skip animations/typing effects
}

interface FrameEnvelope { kind: "frame"; frame: AgenaFrame; }

interface SyncEnvelope {              // end-of-replay marker after subscribe
  kind: "sync";
  sessionId: string;
  branchId: string;
  upToSeq: number;                    // replay delivered everything ≤ this seq
}

interface SnapshotEnvelope { kind: "snapshot"; snapshot: InFlightSnapshot; }

interface PingEnvelope { kind: "ping"; ts: string; }
interface PongEnvelope { kind: "pong"; ts: string; }
// Daemon pings every PING_INTERVAL_MS (15 s); 2 missed pongs → close 1001.
```

`InFlightSnapshot` (daemon pushes current mid-turn state, e.g. right after subscribe so a
reconnecting client can render an in-progress assistant turn):

```ts
interface InFlightSnapshot {
  sessionId: string;
  branchId: string;
  afterSeq: number;
  assistant: {
    messageId: string;
    model: ModelRef;
    blocks: ContentBlock[];
  } | null;
  toolCalls: Array<{
    toolCallId: string;
    name: string;
    args: unknown;
    partialOutput?: string;
  }>;
  pendingApprovals: unknown[];
  retry: { attempt: number; maxAttempts: number; nextAttemptAt: string } | null;
  queue: { steerCount: number; followUpCount: number };
  status: { state: string; detail?: string };
}
```

### 1.4 Visible browser (daemon-initiated RPC to the client)

Only sent if the client declared the `"visible_browser"` capability in `hello`. The daemon
is the requester; the client executes the action in a visible browser window and replies.

```ts
interface VisibleBrowserRequestEnvelope {
  kind: "visibleBrowserRequest";
  requestId: string;
  action: VisibleBrowserAction;
}
interface VisibleBrowserResponseEnvelope {
  kind: "visibleBrowserResponse";
  requestId: string;               // echo the request's id
  result?: VisibleBrowserResult;
  error?: AgenaError;
}

type VisibleBrowserAction =
  // every member also carries optional { sessionId?: string; toolCallId?: string }
  | { action: "open"; url: string }
  | { action: "openExternalOAuth"; url: string; serverName: string }   // url must be a valid URL
  | { action: "read"; includeHtml?: boolean }
  | { action: "screenshot"; maxWidth?: number }                        // maxWidth ≤ 2048
  | { action: "click"; selector?: string; x?: number; y?: number }
  | { action: "type"; selector?: string; text: string; submit?: boolean }
  | { action: "evaluate"; script: string };

interface VisibleBrowserResult {
  url: string;
  title: string;
  text?: string;
  html?: string;
  value?: unknown;                 // evaluate() return value
  screenshot?: {
    mimeType: "image/jpeg";
    base64: string;
    width: number;
    height: number;
  };
}
```

---

## 2. WS commands (`name` + payload → ack)

`CommandName` enum: `"subscribe" | "prompt" | "steer" | "followUp" | "abort" | "runtimeInfo"
| "setModel" | "setThinkingLevel" | "respondToApproval" | "compact"`.

| name | payload | ack |
|---|---|---|
| `subscribe` | `SubscribeCmd` | `SubscribeAck` |
| `prompt` | `PromptCmd` | `PromptAck` |
| `steer` | `SteerCmd` (= PromptCmd) | `PromptAck` |
| `followUp` | `FollowUpCmd` (= PromptCmd) | `PromptAck` |
| `abort` | `AbortCmd` | `{}` (EmptyAck) |
| `runtimeInfo` | `RuntimeInfoCmd` | `RuntimeInfoAck` |
| `setModel` | `SetModelCmd` | `SetModelAck` |
| `setThinkingLevel` | `SetThinkingLevelCmd` | `SetThinkingLevelAck` |
| `respondToApproval` | `RespondToApprovalCmd` | `RespondToApprovalAck` |
| `compact` | `CompactCmd` | `CompactAck` |

```ts
interface SubscribeCmd {
  sessionId: string;
  fromSeq: number;        // EXCLUSIVE: replay returns events with seq > fromSeq; 0 = everything
  branchId?: string;
}
interface SubscribeAck {
  lastSeq: number;        // daemon head seq at subscribe time
  branchId: string;
  replayCount: number;
}

// v1 prompt content is TEXT-ONLY (schema-enforced), min 1 block:
interface PromptCmd  { sessionId: string; content: Array<{ type: "text"; text: string }>; }
type SteerCmd = PromptCmd;      // steer: inject into the current running turn
type FollowUpCmd = PromptCmd;   // followUp: queue for after the current turn
interface PromptAck  { messageId: string; seq: number; }  // seq of message.user.created

interface AbortCmd { sessionId: string; reason?: string; }

interface RuntimeInfoCmd { sessionId: string; }
interface RuntimeInfoAck {
  model?: ModelRef;
  thinkingLevel: ThinkingLevel;
  availableModels: ModelRef[];
  availableThinkingLevels: ThinkingLevel[];
  slashCommands: Array<{ name: string; description?: string }>;
}

interface SetModelCmd { sessionId: string; model: ModelRef; }
interface SetModelAck { model: ModelRef; }

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
interface SetThinkingLevelCmd { sessionId: string; thinkingLevel: ThinkingLevel; }
interface SetThinkingLevelAck { thinkingLevel: ThinkingLevel; }

type ApprovalResponse =
  | { kind: "confirm"; accepted: boolean }
  | { kind: "select"; optionId: string }
  | { kind: "input"; text: string }
  | { kind: "editor"; text: string }
  | { kind: "deny" };
interface RespondToApprovalCmd { sessionId: string; approvalId: string; response: ApprovalResponse; }
interface RespondToApprovalAck { approvalId: string; }

interface CompactCmd { sessionId: string; }
interface CompactAck { compactionSeq: number; }
```

---

## 3. Content blocks and message structure

All message/tool-result content is `ContentBlock[]`. `type` discriminated union:

```ts
interface BlobRef {
  blob: string;              // matches /^sha256:[0-9a-f]+$/
  sizeBytes: number;
  mimeType?: string;
  preview?: string;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; toolCallId: string; name: string; args: unknown }
  | { type: "image"; ref: BlobRef; alt?: string }
  | { type: "file"; ref: BlobRef; path?: string };

interface ModelRef { provider: string; id: string; }

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}
```

Assistant message lifecycle: `message.assistant.started` → streamed via
`message.assistant.text.delta` frames (per blockIndex) and `tool.call.*` events → exactly one
terminal event: `message.assistant.completed` (full final `content: ContentBlock[]`),
`.aborted` (`partialContent`), or `.failed` (`partialContent` + error). The terminal event's
content array is authoritative — replace anything accumulated from frames with it. `toolCall`
blocks inside assistant content link to `tool.call.*` events via `toolCallId`.

---

## 4. Durable events

Wire shape (`AgenaEvent`): the `type` field is **open** — new types are additive; render
unknown types as a generic row. `KnownAgenaEvent` is the strict discriminated union over the
catalog below.

```ts
interface AgenaEvent {
  sessionId: string;
  branchId: string;
  seq: number;          // per-session monotonic, positive, gap-free per subscription
  v: number;            // payload schema version for this type (all known types: 1)
  createdAt: string;    // ISO timestamp
  source: EventSource;
  type: string;
  payload: unknown;     // per-type payload below
}

interface EventSource {
  kind: "user" | "daemon" | "runtime" | "terminal" | "filesystem" | "importer";
  runtime?: "pi";       // set when kind === "runtime"
  clientId?: string;    // set when kind === "user"
}
```

### 4.1 Session

| type | payload |
|---|---|
| `session.created` | `{ workspaceId: string; title?: string; runtime: "pi"; origin: "native" \| "import.claude" \| "import.codex" \| "control"; scope: "project" \| "global" \| "control"; projectId?: string; projectRoot?: string; cwd: string; hostCwdHint?: string; rootBranchId: string }` — `projectId`/`projectRoot` required when `scope === "project"` |
| `session.title.changed` | `{ title: string }` (1–80 chars) |

### 4.2 Message

| type | payload |
|---|---|
| `message.user.created` | `{ messageId: string; content: ContentBlock[]; queued?: "steer" \| "followUp" }` — `queued` absent for a plain prompt |
| `message.assistant.started` | `{ messageId: string; runId: string; turnId: string; model: ModelRef; inResponseTo: string }` — `inResponseTo` is the user messageId |
| `message.assistant.completed` | `{ messageId: string; content: ContentBlock[]; model: ModelRef; stopReason: "end_turn" \| "tool_use" \| "max_tokens"; usage?: UsageTotals }` |
| `message.assistant.aborted` | `{ messageId: string; partialContent: ContentBlock[]; reason: "user_abort" \| "daemon_shutdown" }` |
| `message.assistant.failed` | `{ messageId: string; partialContent: ContentBlock[]; error: { code: string; message: string }; recovered?: boolean }` |
| `message.runtime.created` | `{ messageId: string; runtimeType: "custom" \| "bash" \| "branch-summary"; role?: string; content: ContentBlock[]; meta?: { command?: string; exitCode?: number \| null; customType?: string } }` |

### 4.3 Run

| type | payload |
|---|---|
| `run.started` | `{ runId: string; trigger: "prompt" \| "steer" \| "followUp"; triggerMessageId: string }` |
| `run.completed` | `{ runId: string; usage?: UsageTotals }` |
| `run.aborted` | `{ runId: string; reason: "user_abort" \| "daemon_shutdown" }` |
| `run.failed` | `{ runId: string; error: { code: string; message?: string }; phase?: "dispatch" \| "runtime" \| "recovery"; triggerMessageId?: string }` |

### 4.4 Tool calls

| type | payload |
|---|---|
| `tool.call.started` | `{ toolCallId: string; messageId: string; runId: string; turnId: string; name: string; args: unknown; runtimeToolCallId?: string }` |
| `tool.call.completed` | `{ toolCallId: string; result: ContentBlock[]; durationMs: number }` |
| `tool.call.failed` | `{ toolCallId: string; error: { code: string; message: string }; partialOutput?: ContentBlock[]; durationMs?: number }` |
| `tool.call.aborted` | `{ toolCallId: string; partialOutput: ContentBlock[]; reason: "user_abort" \| "daemon_shutdown" \| "daemon_restart" \| "runtime_error" }` |
| `tool.call.denied` | `{ toolCallId: string; approvalId?: string; reason: "user_denied" \| "approval_expired" \| "policy" \| "hook_denied" }` |

### 4.5 Approvals

| type | payload |
|---|---|
| `approval.requested` | `ApprovalRequested` (below) |
| `approval.responded` | `{ approvalId: string; response: ApprovalResponse; respondedBy: string }` |
| `approval.expired` | `{ approvalId: string }` |
| `approval.cancelled` | `{ approvalId: string; reason: "turn_aborted" \| "daemon_shutdown" \| "daemon_restart" \| "runtime_cancelled" }` |

```ts
interface ApprovalRequested {
  approvalId: string;
  kind: "confirm" | "select" | "input" | "editor";
  title?: string;
  message: string;
  options?: Array<{ id: string; label: string; description?: string }>;  // for kind "select"
  defaultValue?: string;
  subject?: {
    toolName?: string;
    args?: unknown;
    cwd?: string;
    command?: string;
    action?: string;
  };
  toolCallId?: string;
  expiresAt?: string;
}
```

The UI answers via the `respondToApproval` command; `{ kind: "deny" }` is valid for any
approval kind, otherwise `response.kind` should match the request's `kind`.

### 4.6 Terminal

| type | payload |
|---|---|
| `terminal.session.started` | `{ terminalId: string; shell: string; cols: number; rows: number }` |
| `terminal.session.ended` | `{ terminalId: string; exitCode: number \| null; reason: "exit" \| "killed" \| "daemon_restart" }` |

### 4.7 Model / thinking / compaction

| type | payload |
|---|---|
| `model.changed` | `{ from?: ModelRef; to: ModelRef; reason: "user_selected" \| "fallback" \| "auto" }` |
| `thinking.level.changed` | `{ from: string; to: string }` |
| `compaction.created` | `{ compactionId: string; summary: ContentBlock[]; replacesUpToSeq: number; tokensBefore?: number; tokensAfter?: number; trigger: "user" \| "auto" }` |
| `compaction.failed` | `{ compactionId: string; error: { code: string; message: string } }` |

### 4.8 Snapshots (workspace file snapshots)

| type | payload |
|---|---|
| `snapshot.created` | `{ snapshotId: string; workspaceId: string; name?: string; kind: "manual" \| "auto" \| "pre_tool" \| "pre_restore"; storage: { backend: "tar"; path: string; sha256: string; sizeBytes: number }; fileCount?: number; triggeredBySessionId?: string }` |
| `snapshot.restored` | `{ snapshotId: string; safetySnapshotId: string; triggeredBySessionId?: string }` |
| `snapshot.restore_failed` | `{ snapshotId: string; safetySnapshotId?: string; error: { code: string; message: string } }` |
| `snapshot.deleted` | `{ snapshotId: string }` |

That is the complete durable catalog (31 types). Anything else on the wire is a
forward-compatible unknown → generic row.

---

## 5. Ephemeral frames

Frames are never persisted; the daemon may drop or coalesce them under backpressure. Frame
envelope:

```ts
interface AgenaFrame {
  sessionId: string;
  branchId: string;
  afterSeq: number;    // highest committed durable seq at emit time
  emittedAt: string;
  type: string;        // open, like events
  payload: unknown;
}
```

Known frame types (v1 subset — more land later; ignore unknown frame types):

| type | payload | coalescing key | coalesce rule |
|---|---|---|---|
| `message.assistant.text.delta` | `{ messageId: string; blockIndex: number; delta: string }` | `sessionId + messageId + blockIndex` | concatenate `delta` in arrival order |
| `tool.call.output.delta` | `{ toolCallId: string; delta: string; reset?: boolean }` | `sessionId + toolCallId` | concatenate `delta`; if `reset === true`, clear accumulated output first |

Because frames are droppable, never rely on them for final content — the terminal durable
event (`message.assistant.completed`/`aborted`/`failed`, `tool.call.completed`/etc.) carries
the authoritative content and replaces the streamed accumulation.

---

## 6. Errors, close codes, limits

```ts
type ErrorCode =
  | "UNAUTHORIZED" | "PROTOCOL_MISMATCH" | "NOT_READY" | "TIMEOUT"
  | "INVALID_PAYLOAD" | "PAYLOAD_TOO_LARGE" | "PATH_ESCAPES_WORKSPACE"
  | "SESSION_NOT_FOUND" | "SESSION_BUSY" | "SESSION_READ_ONLY" | "TURN_NOT_ACTIVE"
  | "APPROVAL_NOT_FOUND" | "APPROVAL_NOT_PENDING" | "MODEL_UNAVAILABLE"
  | "NOT_FOUND" | "RUNTIME_UNAVAILABLE" | "ALREADY_SUBSCRIBED"
  | "SUBSCRIPTION_LIMIT" | "INTERNAL";

interface AgenaError {           // same shape is the HTTP error body
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
}
```

WS close codes (`WS_CLOSE_CODES`):

| code | name | meaning |
|---|---|---|
| 1000 | normal | |
| 1001 | goingAway | daemon shutdown / missed heartbeats |
| 4400 | protocolViolation | repeated malformed input or version mismatch |
| 4401 | authInvalidated | reserved (upgrade-time auth failure is a plain HTTP 401, never a close code) |
| 4408 | handshakeTimeout | no hello within `HELLO_TIMEOUT_MS` |
| 4409 | ptyAlreadyAttached | PTY WS already has an attached client |
| 4413 | messageTooLarge | repeated envelopes over `MAX_ENVELOPE_BYTES` |
| 4429 | slowConsumer | backpressure disconnect |

Limits (`limits.ts`):

```ts
MAX_ENVELOPE_BYTES = 1_048_576         // 1 MiB max wire envelope
MAX_PROMPT_BYTES = 262_144             // 256 KiB prompt text cap
MAX_SUBSCRIPTIONS = 64
HELLO_TIMEOUT_MS = 10_000
PING_INTERVAL_MS = 15_000              // 2 missed pongs → close 1001
COMMAND_ACK_TIMEOUT_MS = 30_000        // client-side per-command timeout
REQUEST_DEDUPE_TTL_MS = 300_000
FRAME_COALESCE_BUFFERED_BYTES = 1_048_576
FRAME_DROP_BUFFERED_BYTES = 4_194_304
DURABLE_BACKLOG_LIMIT_BYTES = 16_777_216
SOCKET_STALL_TIMEOUT_MS = 15_000
PTY_IDLE_TIMEOUT_MS = 900_000
PTY_SCROLLBACK_BYTES = 262_144
PTY_PAUSE_BUFFERED_BYTES = 1_048_576
PTY_RESUME_BUFFERED_BYTES = 262_144

interface WireLimits {                 // sent in welcome; DEFAULT_WIRE_LIMITS mirrors the constants
  maxEnvelopeBytes: number;
  maxPromptBytes: number;
  maxSubscriptions: number;
}
```

---

## 7. PTY WebSocket

Attach via `GET /v1/ptys/:id/ws` (one client at a time; second attach → close 4409).

- **Binary frames** in both directions are raw PTY bytes (not schematized).
- **Text frames** are JSON control frames:

```ts
// client → daemon (only control the client may send):
interface PtyResizeControlFrame { type: "resize"; cols: number; rows: number; }

// daemon → client (only control the daemon sends):
interface PtyExitControlFrame { type: "exit"; exitCode: number | null; signal: string | null; }
```

---

## 8. HTTP API

All error responses use the `AgenaError` body shape. Routes below are `/v1/*` on the daemon.
`http.ts` exports a route table `PTY_HTTP_ROUTES` binding methods/paths to the schemas —
prefer importing it. Query booleans accept `true | "true" | "1" | false | "false" | "0"`.

### 8.1 Sessions

| route | request | response |
|---|---|---|
| `POST /v1/sessions` | `CreateSessionRequest` | `{ sessionId: string }` |
| `GET /v1/sessions` | query `ListSessionsQuery` | `{ sessions: SessionSummary[] }` |
| `PATCH /v1/sessions/:id` | `{ status: SessionStatus }` | — |
| `GET /v1/search` | query `SearchQuery` | `{ hits: SearchHit[] }` |

```ts
type SessionScope = "project" | "global" | "control";
type SessionStatus = "active" | "idle" | "archived";

interface CreateSessionRequest {
  title?: string;
  scope?: SessionScope;          // defaults to "project"
  projectId?: string;            // required (with projectRoot) when scope === "project"
  projectRoot?: string;
  cwd?: string;
  hostCwdHint?: string;
}

interface ListSessionsQuery {
  projectId?: string;
  scope?: SessionScope;
  status?: SessionStatus;
  allProjects?: boolean;
  includeArchived?: boolean;
}

interface SessionSummary {
  sessionId: string;
  workspaceId: string;
  title?: string;
  rootBranchId: string;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
  scope: SessionScope;
  status: SessionStatus;
  projectId?: string;
  projectRoot?: string;
  cwd: string;
  hostCwdHint?: string;
}

interface SearchQuery {
  q: string;
  projectId?: string;
  sessionId?: string;
  allProjects?: boolean;
  limit?: number;                // 1–100, default 20
}
interface SearchHit {
  sessionId: string;
  messageId?: string;
  snippet: string;
  rank: number;
  seq?: number;
}
```

### 8.2 PTYs

| route | request | response |
|---|---|---|
| `POST /v1/ptys` | `CreatePtyRequest` | `{ ptyId: string; wsPath: string }` |
| `GET /v1/ptys` | — | `{ ptys: PtySummary[] }` |
| `DELETE /v1/ptys/:id` | — | — |
| `GET /v1/ptys/:id/ws` | WS upgrade (see §7) | — |

```ts
interface CreatePtyRequest {
  cols: number;
  rows: number;
  cwd?: string;
  sessionId?: string;
  command?: string;
  args?: string[];
}
interface PtySummary {
  ptyId: string;
  cols: number;
  rows: number;
  cwd: string;
  sessionId?: string;
  attached: boolean;
  createdAt: string;
  lastAttachedAt: string | null;
}
```

### 8.3 Approvals

| route | request | response |
|---|---|---|
| `GET /v1/approvals` | query `{ pending?: boolean }` | `{ approvals: PendingApprovalSummary[] }` |

```ts
interface PendingApprovalSummary {
  sessionId: string;
  branchId: string;
  seq: number;
  approvalId: string;
  requestedAt: string;
  payload: ApprovalRequested;    // same shape as the approval.requested event payload
}
```

### 8.4 Snapshots

| route | request | response |
|---|---|---|
| `GET /v1/snapshots` | — | `{ snapshots: SnapshotSummary[] }` |
| `POST /v1/snapshots` | `{ name?: string; sessionId?: string }` | `{ snapshot: SnapshotSummary }` |
| `POST /v1/snapshots/:id/restore` | `{ sessionId?: string }` | `{ snapshotId: string; safetySnapshotId: string }` |
| `DELETE /v1/snapshots/:id` | — | — |

```ts
interface SnapshotSummary {
  snapshotId: string;
  workspaceId: string;
  sessionId?: string;
  name?: string;
  kind: "manual" | "auto" | "pre_tool" | "pre_restore";
  storagePath: string;
  sha256: string;
  sizeBytes: number;
  status: "available" | "deleted";
  createdAt: string;
}
```

### 8.5 Files

| route | request | response |
|---|---|---|
| `GET /v1/files` | query `{ path?: string ("." default); depth?: number (max 1, default 1); cursor?: string }` | `{ entries: FileEntry[]; nextCursor: string \| null }` |
| `GET /v1/files/content` | query `{ path: string }` | raw file bytes |
| `GET /v1/files/archive` | query `{ path: string }` | tar stream |
| `POST /v1/files/upload` | query `{ path: string; format: "tar" }`, body = tar stream | `{ path: string; fileCount: number }` |

```ts
interface FileEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: string;
  mode: number;
}
```

### 8.6 Projects

| route | request | response |
|---|---|---|
| `POST /v1/projects` | `{ name: string }` | `{ name: string; projectId: string; projectRoot: string; cwd: string }` |
| `DELETE /v1/projects/:id` | — | `{ projectId: string; deletedSessions: number }` (full teardown: rows, workspace files, pi sessions, snapshots) |

### 8.7 Session import

| route | request | response |
|---|---|---|
| `POST /v1/imports/session` | `ImportSessionRequest` | `ImportSessionResponse` |
| `GET /v1/imports` | query `{ machineId?: string }` | `{ imports: ImportLedgerEntry[] }` |

```ts
type Harness = "claude" | "codex" | "pi";

interface SourceFingerprint {
  harness: Harness;
  machineId: string;
  sourcePath: string;
  sourceSessionId: string;
  mtimeMs: number;
  size: number;
}

interface ImportSessionRequest {
  projectId: string;
  projectRoot: string;
  title?: string;
  sourceFingerprint: SourceFingerprint;
  piSession: string;             // pi v3 JSONL, converted client-side; ≤ ~13 MB, plain JSON body
}

interface ImportSessionResponse {
  sessionId: string;
  seededEvents: number;
  alreadyImported: boolean;      // ledger already had (machineId, harness, sourceSessionId)
}

interface ImportLedgerEntry {
  id: string;
  sessionId?: string;            // absent for project-only (harness "files") imports
  projectId: string;
  machineId: string;
  harness: "claude" | "codex" | "pi" | "files";   // note: wider than Harness
  sourcePath: string;
  sourceSessionId?: string;
  sourceMtimeMs?: number;
  sourceSize?: number;
  importedAt: string;
}
```

### 8.8 Skills

Routes (from the daemon; not in `PTY_HTTP_ROUTES`):
`GET /v1/skills` → `{ skills: SkillSummary[] }`
`POST /v1/skills/import` → `ImportSkillRequest` → `{ skill: SkillSummary }`
`POST /v1/skills/check-updates` → `{ skills: SkillSummary[] }`
`POST /v1/skills/:id/update` → `{ skill: SkillSummary }`

```ts
interface ImportSkillRequest {
  identity: string;                        // 1–2048 chars
  name: string;                            // kebab-case: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, ≤64
  description: string;                     // 1–1024 chars
  source?: {
    url: string;                           // valid URL
    path?: string;
    revision?: string;                     // ≤256
  };
  files: Array<{                           // 1–500 files
    path: string;                          // ≤512 chars
    contentBase64: string;                 // ≤ 14 MiB per file
  }>;
}

interface SkillSummary {
  id: string;
  identity: string;
  name: string;
  description?: string;
  contentHash: string;                     // /^[a-f0-9]{64}$/ (sha256 hex)
  sourceUrl?: string;
  sourcePath?: string;
  sourceRevision?: string;
  status: "ready" | "update_available" | "error";
  importedAt: string;
  updatedAt: string;
}
```

### 8.9 MCPs

Routes: `GET /v1/mcps` → `{ mcps: McpSummary[] }`
`POST /v1/mcps/import` → `ImportMcpRequest` → `{ mcp: McpSummary }`
`POST /v1/mcps/:id/oauth/start` → `{ authorizationUrl: string }` (StartMcpOAuthResponse)
`POST /v1/mcps/:id/oauth/complete` → `{ redirectUrl: string }` (must be a valid URL) → `{ mcp: McpSummary }`

```ts
type McpTransport = "stdio" | "http" | "sse";
type McpAuthKind = "none" | "oauth" | "api_key";
type McpStatus = "imported" | "needs_auth" | "connected" | "error";   // mcpStatusSchema

interface ImportMcpRequest {
  identity: string;                        // 1–2048
  name: string;                            // 1–128
  transport: McpTransport;
  command?: string;                        // REQUIRED when transport === "stdio"
  args?: string[];
  url?: string;                            // REQUIRED (valid URL) when transport !== "stdio"
  env?: Record<string, string>;
  headers?: Record<string, string>;
  auth: {
    kind: McpAuthKind;
    secretValues?: Record<string, string>;
  };
}

interface McpSummary {
  id: string;
  identity: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  authKind: McpAuthKind;
  status: McpStatus;
  importedAt: string;
  updatedAt: string;
}
```

OAuth flow: `oauth/start` returns `authorizationUrl`; the client opens it (typically via the
daemon-initiated `visibleBrowserRequest { action: "openExternalOAuth" }` or directly), then
posts the final redirect URL to `oauth/complete`, which returns the updated `McpSummary`
(status transitions `needs_auth` → `connected`).

### 8.10 Misc

| route | response |
|---|---|
| `GET /v1/diagnostics` | `DiagnosticsResponse` |
| `GET /v1/sessions/:id/events` | durable event list for a session (daemon route; shape = `AgenaEvent[]` semantics) |
| `GET /health` | daemon health |
| tunnel WS | `tunnelWsPath(port)` → `` `/v1/tunnels/${port}/ws` `` |

```ts
interface DiagnosticsResponse {
  daemon: { version: string; uptimeMs: number };
  protocol: { version: number };
  workspace: { path: string };
  discovery: {
    entries: Array<{
      kind: "tool" | "skill" | "hook";
      name: string;
      file: string;
      status: "ok" | "invalid" | "collision";
      reason?: string;
    }>;
  };
}
```

---

## 9. Renderer-critical invariants (recap)

1. `subscribe.fromSeq` is **exclusive** (`seq > fromSeq`); `fromSeq: 0` replays everything.
   Replay ends with a `sync` envelope (`upToSeq`); `EventEnvelope.replayed === true` during replay.
2. Events per subscription arrive in strict, gap-free `seq` order. Persist the last seen `seq`
   per session and resume with it on reconnect.
3. Frames are droppable/coalescible; final content always comes from the terminal durable event.
4. Unknown event/frame `type`s must not crash the renderer — render generic/ignore.
5. Exactly one `ack` or `error` per `requestId`; correlate by `requestId` (client-minted ULID).
6. WS prompt/steer/followUp content is text-only in v1 (`{ type: "text" }` blocks only).
7. `clientId` in `hello` must be a stable per-install ULID — it becomes `source.clientId` and
   is how a client recognizes its own echoed user events.
