# Subagents and workflows plan

Status: proposed; research validation pending.

## Decision

Agena will start with Pi Cohort-style dynamic subagents, not a general workflow
engine. The model may decide when and how to delegate, while users can request a
specific role, task split, model, or execution mode. Agena owns every child
session, event, approval, permission, cancellation, and recovery record.

Pi Cohort is an implementation reference and source of reusable role/schema
behavior. It must not create an independent session store or invisible child Pi
processes beside Agena's runtime.

Saved workflow DAGs, agent teams, direct child-to-child messaging, recursive
delegation, and parallel writable agents are deferred until durable child
sessions work end to end.

## Dynamic behavior

Delegation has three entry points:

1. The parent model calls a `subagent` tool when a bounded task benefits from an
   isolated context.
2. The user explicitly requests an agent, model, task split, or parallelism.
3. Project instructions or a trusted agent role require a delegation step.

The model may create task descriptions and a one-run single, parallel, or
sequential plan. Creating a permanent agent role or saved workflow requires
explicit user confirmation.

Model resolution is deterministic:

1. User-selected model for this task.
2. Model requested by the parent delegation call.
3. Role-preferred model.
4. Parent session model.
5. Authenticated fallback configured for the role.

The resolved model must be connected and available. The UI always displays the
resolved model, including fallback changes.

## Cohort integration boundary

Reuse or adapt from Pi Cohort:

- agent Markdown/frontmatter and built-in roles;
- single, parallel, and chain request schemas;
- fresh/fork context semantics;
- concurrency and output bounds;
- structured result validation and summarization;
- cancellation propagation;
- saved-chain parsing and worktree helpers when those phases arrive.

Replace with Agena-owned implementations:

- child process and session ownership;
- run storage, recovery, and transcript persistence;
- approval and permission routing;
- lifecycle events and client fanout;
- UI state, controls, and cost aggregation.

The likely integration is a small audited fork/adapter around Cohort behavior,
not an opaque installation of its npm extension.

## Architecture

The parent Pi session receives one `subagent` tool. The tool calls a core-owned
`AgentOrchestrator`. The orchestrator creates ordinary Agena child sessions
through `RuntimeAdapter`, starts them, and returns bounded summaries to the
parent.

```text
Parent Pi session
  -> subagent tool
  -> AgentOrchestrator
     -> child Agena session -> Pi RuntimeSession -> event store
     -> child Agena session -> Pi RuntimeSession -> event store
  <- bounded child summaries
```

The daemon composes the orchestrator with the event store, runtime adapter,
session registry, approval service, and provider registry. `runtime-pi` remains
the only package importing Pi and continues mapping Pi events into the
runtime-neutral event stream.

## Core service

`AgentOrchestrator` owns:

- delegation validation and idempotency;
- role and model resolution;
- concurrency and nesting limits;
- atomic parent-task/child-session creation;
- foreground/background execution;
- result collection and bounded parent handoff;
- steering, cancellation, and recovery;
- permission policy and write isolation.

Initial limits:

- maximum four running children per parent;
- maximum eight tasks in one delegation;
- parent-to-child depth only;
- parallel read-only tasks;
- at most one writer in the shared checkout;
- no loops or automatic retry loops.

## Protocol and durable events

Add a small `agent.task.*` family. The parent session stores task lifecycle and
summaries; detailed child activity stays in the child session.

```ts
type AgentTaskCreated = {
  taskId: string;
  parentSessionId: string;
  childSessionId: string;
  parentRunId: string;
  parentMessageId: string;
  parentToolCallId: string;
  role: string;
  task: string;
  execution: "foreground" | "background";
  context: "fresh" | "fork";
  workspaceMode: "shared_readonly" | "shared_serial_writer" | "isolated_worktree";
  requestedModel?: ModelRef;
  resolvedModel: ModelRef;
  retryOfTaskId?: string;
};

type AgentTaskStarted = { taskId: string; startedAt: string };

type AgentTaskCompleted = {
  taskId: string;
  resultMessageId: string;
  summary: ContentBlock[];
  usage?: UsageTotals;
};

type AgentTaskFailed = {
  taskId: string;
  error: { code: string; message: string };
  summary?: ContentBlock[];
};

type AgentTaskCancelled = {
  taskId: string;
  reason: "user" | "parent_aborted" | "daemon_shutdown" | "daemon_restart";
};

type AgentTaskMessageSent = {
  taskId: string;
  direction: "parent_to_child" | "child_to_parent";
  messageId: string;
};
```

The existing replay/fanout contract applies unchanged. Clients never receive Pi
types or Cohort-private state.

## Database

Every child is a normal `sessions` row with its own branch, event sequence, Pi
session reference, model, and lifecycle. Add identity fields:

```sql
parent_session_id TEXT REFERENCES sessions(id),
parent_task_id    TEXT,
session_kind      TEXT NOT NULL DEFAULT 'primary'
                    CHECK (session_kind IN ('primary', 'subagent'))
```

Add a rebuildable `agent_tasks` projection derived from `agent.task.*` events:

```sql
CREATE TABLE agent_tasks (
  id                 TEXT PRIMARY KEY,
  parent_session_id  TEXT NOT NULL,
  child_session_id   TEXT NOT NULL,
  parent_run_id      TEXT,
  parent_message_id  TEXT NOT NULL,
  parent_tool_call_id TEXT NOT NULL,
  role               TEXT NOT NULL,
  task               TEXT NOT NULL,
  execution          TEXT NOT NULL,
  context_mode       TEXT NOT NULL,
  workspace_mode     TEXT NOT NULL,
  requested_model    TEXT,
  resolved_model     TEXT NOT NULL,
  retry_of_task_id   TEXT,
  status             TEXT NOT NULL,
  summary            TEXT,
  error              TEXT,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cost_usd           REAL,
  created_at         TEXT NOT NULL,
  started_at         TEXT,
  finished_at        TEXT
);
```

Index parent, child, and active-status lookups. A dedicated store operation
creates the child identity/root branch and parent task event in one transaction,
so a crash cannot leave an unlinked child session.

## Persistence and context

The Agena event history remains in `/var/lib/agena/db/agena.db`. Each child Pi
JSONL lives under the existing persisted Pi root and is referenced by
`sessions.pi_session_path`. SQLite is the product truth; Pi JSONL only
rehydrates model context.

Fresh context is the first supported mode. It contains the role prompt, task,
project rules, cwd, approved skills/tools, a bounded parent handoff, and optional
explicit files. Full parent transcript inheritance is excluded.

Forked context follows only after Pi branching, restart, and cost behavior are
verified. A fork request must fail explicitly rather than silently downgrade to
fresh context.

## Permissions and files

- Effective child permissions are the intersection of workspace policy,
  parent-delegable permissions, role policy, task-requested permissions, and
  workspace mode. Children cannot gain tools unavailable at any layer.
- Permission to use a tool is distinct from permission to delegate that tool to
  a child. Recursive delegation remains denied unless a later role explicitly
  receives it.
- Read-only roles receive read/search tools only.
- Writable tools use the existing durable approval flow.
- Background work never bypasses a required approval.
- Project-local agent definitions require trust confirmation.
- Recursive delegation is disabled initially.
- Read-only children may share a cwd.
- One writable child may use the current checkout.
- Parallel writable children require isolated Git worktrees in a later phase.
- Agena never automatically merges child worktrees.

`workspaceMode` is part of every task request and is enforced by the
orchestrator. Unknown writable scope defaults to isolation once isolated writers
are supported; until then it is rejected rather than silently sharing a
checkout.

## UI

Use two surfaces, both driven by durable events/projections.

### Parent conversation receipt

The transcript keeps the delegation causal but sparse: the originating
`subagent` tool call renders one collapsed receipt, correlated by
`parentToolCallId`. It shows delegation/completion counts, duration, cost, and
expands on demand for child summaries, status, and open/stop controls. Full
child output never becomes a permanent parent-transcript card.

### Agents activity panel

A compact, active-only panel near the composer lists at most three running
children and folds the remainder into a count. It disappears when all children
settle; failed and approval-needed children remain visible until resolved.
Selecting one opens its normal Agena transcript. The child header links back to
the parent, explains that its normal composer can continue the conversation,
and offers steer, stop, archive, and (later) worktree controls.

Primary sessions remain top-level in the session list. Subagent sessions appear
nested beneath their parent and collapsed by default. Search results include
child messages but label the parent session and role.

The client subscribes to the parent lifecycle stream and opens a normal child
session subscription only when its transcript is viewed. Aggregate activity can
use ephemeral frames, but terminal state and summaries are durable.

## Steering, approvals, and recovery

The parent tool supports starting, inspecting, messaging, and stopping a task.
Child clarification uses the existing durable approval mechanism and is labeled
with the child role/session in every client.

On daemon restart:

- completed and idle children remain reopenable;
- dangling running tasks receive truthful restart terminal events;
- the parent receives a durable failed/interrupted summary;
- automatic restart is deferred;
- Retry creates a new attempt and child session linked to the original task.

Terminal task transition and parent result delivery are idempotent by `taskId`.
`resultMessageId` is minted deterministically for the task, so replay, reconnect,
or recovery cannot inject the same completion into the parent twice. A retry is
a new task and child session carrying `retryOfTaskId`; a separate attempt/lease
subsystem is deferred until Agena actually distributes execution across workers.

## Dynamic chains versus workflows

Initial dynamic orchestration supports single tasks, parallel groups, sequential
chains, and a parallel-then-reduce pattern. Every task is durable, but the plan
is not a reusable workflow definition.

A later workflow layer may add named DAGs, dependencies, retries, conditions,
approval nodes, budgets, and cross-restart continuation on top of the same
child-session primitives. It must not introduce a second transcript or task
store.

## Delivery phases

1. **Runtime spike:** audit/pin Cohort; prove role parsing, child creation,
   complete streaming, abort, and model selection through Agena.
2. **Durable single child:** protocol events, atomic store operation, projection,
   orchestrator, recovery, and FakeRuntime coverage.
3. **UI:** parent task card, activity panel, nested navigation, child transcript,
   steering, stop, and approvals.
4. **Parallel reads:** bounded concurrency, group results, cost totals, and
   partial failure.
5. **Chains:** sequential/parallel-reduce handoffs, structured output, and fresh
   context summaries.
6. **Writers:** one shared-checkout writer, then reviewed worktree isolation for
   parallel writers.
7. **Workflows:** only after the above is stable.

## Acceptance criteria

- A parent can spawn two children concurrently and both appear immediately.
- Child streams survive client disconnect/reconnect.
- Every child has an independently inspectable durable transcript.
- Relationships and completed state survive container replacement.
- Stopping one child does not stop its parent or siblings.
- Approvals identify the correct child.
- Parent context receives bounded summaries, not full transcripts.
- Daemon restart produces truthful terminal states.
- UI reconstruction needs no Cohort temporary files.
- FakeRuntime covers orchestration without model calls.
- No Pi-specific type crosses the Agena protocol.

## Open-harness research validation

Research was performed against pinned source snapshots of OpenCode and Gemini
CLI, plus Goose's subagent handler, with Oracle used for broad comparison and
all adopted claims checked against repository code.

### OpenCode

OpenCode's task tool creates an ordinary child session with a `parentID`, keeps
the full child transcript separate, supports fresh creation or resume by task
ID, narrows child permissions, propagates aborts, and returns a compact result
envelope to the parent. This directly validates Agena's ordinary-child-session
design and the decision not to copy child transcripts into the parent.

Relevant source:

- <https://github.com/anomalyco/opencode/blob/34e58090595d44e3e7cc37498f16753a98627456/packages/opencode/src/tool/task.ts>
- <https://github.com/anomalyco/opencode/blob/34e58090595d44e3e7cc37498f16753a98627456/packages/opencode/src/agent/subagent-permissions.ts>

OpenCode also carries parent session and child session metadata on the exact
task tool call. Agena therefore records `parentToolCallId` and
`parentMessageId`, not only `parentRunId`, so the UI can render and recover the
correct delegation card.

### Gemini CLI

Gemini CLI separates its agent scheduler from local/remote invocation protocols,
passes a `parentCallId`, agent-specific tool registry, message bus, confirmation
plumbing, and `AbortSignal`, and renders grouped subagent progress separately.
This validates keeping Agena's scheduler in core while Pi performs one child
model loop.

Relevant source:

- <https://github.com/google-gemini/gemini-cli/blob/f354eebaf43b25bacb176007e449bb9a638fd101/packages/core/src/agents/agent-scheduler.ts>
- <https://github.com/google-gemini/gemini-cli/tree/f354eebaf43b25bacb176007e449bb9a638fd101/packages/core/src/agents>

### Goose

Goose constructs a fresh child conversation from a dedicated task, gives it a
session ID and cancellation token, and streams messages through callbacks. Its
option to flatten child text and tool output into the parent demonstrates the
context-growth failure Agena should avoid. Agena retains only a bounded,
structured summary plus artifact/session references in the parent.

Relevant source:

- <https://github.com/aaif-goose/goose/blob/858e8de359b6bd585813d25397744feffb50e8db/crates/goose/src/agents/subagent_handler.rs>
- <https://github.com/aaif-goose/goose/blob/858e8de359b6bd585813d25397744feffb50e8db/crates/goose/src/agents/subagent_task_config.rs>

### Changes accepted from the comparison

1. Correlate every task to the exact parent message and tool call.
2. Make permission derivation an explicit narrowing intersection.
3. Put workspace/read-write isolation mode in the durable task contract.
4. Make terminal result delivery idempotent and model retries as linked tasks.

### Changes intentionally rejected for now

- No second authoritative delegation table: the atomic child-session creation
  plus parent durable event preserves Agena's events-as-truth invariant.
- No leases or heartbeats: execution is owned by one daemon in the current
  architecture. Add them only if attempts move to distributed workers.
- No separate task-attempt entity: one task maps to one child session today;
  retries are linked tasks. Split attempts when reattachment or distributed
  execution creates a real need.
- No team mailbox, arbitrary DAG, or recursive delegation before shallow child
  sessions are durable and observable.
