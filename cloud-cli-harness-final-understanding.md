# Agena — Final Understanding and Product Direction

## 1. Final Product Goal

Build **Agena**, a personal-first cloud CLI harness for AI coding and real-world work.

The product should feel like using a local terminal and local filesystem, but the actual runtime, files, sessions, tools, plugins, and agent state live in a persistent cloud workspace.

The main user flow should be:

```bash
agena open <repo-or-workspace>
agena new "task description"
agena resume
agena attach
agena files
agena share <path>
agena sync
```

The goal is **not** to build a cloud clone of every existing AI coding tool. The goal is to build one reliable cloud-native harness that the user can live inside every day, while importing old context from existing tools and optionally adapting other runtimes later.

---

## 2. Main Decision

The final direction is:

```text
Build your own cloud harness core.
Use Pi-style session and extension ideas as the main design reference.
Use Claude and Codex only as one-time import/backfill sources.
Use OpenCode later as a server/API/runtime adapter reference.
CLI first. Desktop and phone apps later.
```

This means the platform should not depend on Claude, Codex, Pi, or OpenCode as the permanent source of truth.

Your own system should own:

- session history
- message events
- model switches
- tool calls
- shell commands
- file changes
- branches/forks
- compactions/summaries
- workspace snapshots
- plugins
- cloud filesystem
- sharing links
- device sync

---

## 3. What This Is Not

This should **not** be:

```text
A Claude cloud clone
A Codex cloud clone
An OpenCode cloud clone
A Pi cloud clone
A universal harness marketplace on day one
A raw AI SDK-only agent loop
A desktop app-first product
```

The product is better described as:

```text
A persistent cloud terminal + AI harness with full session memory, cloud filesystem, plugins, and device-independent access.
```

---

## 4. Why Pi-Style Core Fits Best

Pi is the better design reference for the core because the most important requirements are:

- rich session history
- session branching/forking
- model change tracking
- compaction/summarization
- extensibility
- custom commands
- tool hooks
- context injection
- persistent extension state
- CLI-first usage

The desired harness should borrow the following Pi-style ideas:

```text
append-only session events
JSONL-like session portability
branchable session trees
model_change events
thinking/config change events
compaction events
custom extension events
custom tools
custom commands
context hooks
session import/export
```

Pi should be treated as the **session and plugin architecture inspiration**.

It may also become a runtime adapter, but the product should not rely on Pi’s local files as the long-term database.

---

## 5. Where OpenCode Fits

OpenCode is still useful, but not as the first source of truth.

OpenCode’s biggest strength is that it is already shaped like a server/runtime:

- headless server mode
- HTTP API
- OpenAPI surface
- SSE/event streaming
- session APIs
- message APIs
- file APIs
- diff APIs
- shell/command APIs
- provider/model routing
- agent/subagent support
- MCP support

This makes OpenCode useful later when building app UIs or adding a remote runtime adapter.

The right role for OpenCode is:

```text
OpenCode = server/API/runtime reference and optional adapter
Pi = session/plugin architecture reference
Your harness = source of truth and daily product
```

---

## 6. Role of Claude and Codex

Claude and Codex should be treated as **legacy session sources**, not runtime dependencies.

The user mostly uses Claude and Codex today, so the first migration step should be a one-time backfill:

```bash
agena import claude
agena import codex
```

After import, old Claude/Codex sessions become searchable, resumable historical context inside the new harness.

They should be imported into your canonical format, not kept as live external dependencies.

Recommended behavior:

```text
Raw Claude/Codex data is archived as-is.
A normalized session is created in your database.
A resume-ready summary is generated.
The original imported session remains read-only.
Future work continues inside your harness.
```

---

## 7. Backfill Architecture

Backfill should have three layers.

### 7.1 Raw Archive Layer

Store exact original data before transforming it.

```text
raw_imports/
  claude/
    <machine-id>/
      <imported-at>/
  codex/
    <machine-id>/
      <imported-at>/
```

This layer is never mutated. It exists for safety, debugging, and future re-imports.

### 7.2 Normalized Event Layer

Convert Claude/Codex/Pi/OpenCode events into your canonical event format.

Example event types:

```text
session.created
message.user.created
message.assistant.started
message.assistant.delta
message.assistant.completed
tool.call.created
tool.call.completed
tool.result.created
command.started
command.completed
file.created
file.updated
file.deleted
model.changed
branch.created
compaction.created
summary.created
workspace.snapshot.created
runtime.attached
runtime.detached
```

### 7.3 Resume-Ready Layer

For every imported session, generate:

```text
title
source harness
repo/workspace path
main goal
important decisions
important files touched
commands run
models used
final state
open TODOs
continuation prompt
```

This layer is what makes imported sessions useful later.

Do not try to perfectly replay every old Claude/Codex tool trace. Import the useful history, summarize the state, and continue from there.

---

## 8. Canonical Session Model

Your system should use its own canonical session model.

A session should not be a flat chat. It should be a branchable event graph.

Recommended model:

```text
Session
  ├─ Branch
  │   ├─ Event
  │   ├─ Event
  │   └─ Event
  ├─ Branch
  │   ├─ Event
  │   └─ Event
  └─ Summary / Compaction
```

Core tables or collections:

```text
sessions
session_branches
session_events
messages
tool_calls
command_runs
file_events
model_switches
compactions
summaries
workspace_snapshots
share_links
devices
runtime_connections
```

Every important action should be stored as an append-only event.

This makes it possible to:

- resume from any device
- fork old sessions
- inspect what happened
- rebuild UI state
- sync across clients
- import/export sessions
- support multiple runtimes later

---

## 9. Model Switching Behavior

Model switching should be represented explicitly as a first-class event.

Example:

```json
{
  "type": "model.changed",
  "from": "claude-sonnet",
  "to": "gpt-5.5-thinking",
  "reason": "user_selected",
  "timestamp": "..."
}
```

A session should be able to contain multiple models over time.

The session should preserve:

- which model produced each assistant message
- which model planned
- which model executed
- which model reviewed
- when the user manually switched models
- when the router automatically selected another model

Model switching should not require starting a new session.

---

## 10. Cloud Workspace and Filesystem UX

The cloud workspace should be canonical.

The user should feel like they are working on a normal local filesystem, but the files live in a persistent cloud workspace.

Recommended layout:

```text
/workspaces/<user>/<workspace>
  ├─ repo/
  ├─ .agena/
  │   ├─ sessions/
  │   ├─ plugins/
  │   ├─ snapshots/
  │   ├─ artifacts/
  │   └─ config.json
  └─ shared/
```

CLI commands should make file movement simple:

```bash
agena cp ./local-file.ts workspace:/repo/src/file.ts
agena cp workspace:/repo/output.zip .
agena sync ./local-folder workspace:/repo
agena share workspace:/repo/report.md
agena snapshot create "before refactor"
agena snapshot restore <snapshot-id>
```

For v1, simple copy/sync/share is enough.

Later, add:

- FUSE mount
- local folder mirroring
- Mutagen-style sync
- desktop file browser
- mobile file previews

---

## 11. CLI-First UX

The first version should be CLI-first.

The CLI should hide cloud complexity. The user should not feel like they are manually managing SSH, containers, ports, object storage, or sync daemons.

Important commands:

```bash
agena login
agena init
agena open <repo>
agena new "task"
agena resume
agena sessions
agena search "query"
agena attach
agena files
agena cp <src> <dest>
agena sync
agena share <path>
agena snapshot create <name>
agena import claude
agena import codex
agena plugins list
agena plugins install <plugin>
```

The core experience should be:

```text
Same session.
Same files.
Same tools.
Same cloud machine.
Accessible from any device.
```

---

## 12. Cloud Daemon / Runtime Architecture

The v1 runtime can be a daemon running inside a persistent cloud devbox.

Recommended architecture:

```text
Local CLI
  ↓
Cloud Gateway
  ↓
Workspace Daemon
  ├─ session manager
  ├─ runtime manager
  ├─ plugin manager
  ├─ file manager
  ├─ terminal manager
  ├─ event emitter
  └─ sandbox/process supervisor
  ↓
Persistent Workspace Filesystem
  ↓
Object Storage / Snapshots / Git
```

The local CLI connects to the daemon using:

- WebSocket/SSE for events
- SSH/Mosh-like terminal attach
- HTTP/gRPC for file/session APIs
- signed URLs for file sharing

---

## 13. Runtime Strategy

Recommended order:

```text
1. Build native minimal runtime + session system.
2. Make it Pi-style in session and plugin behavior.
3. Add Claude importer.
4. Add Codex importer.
5. Add OpenCode adapter later.
6. Add Codex/Claude live adapters only if useful.
```

Do not start by supporting every runtime live.

Start by making one excellent daily workflow.

---

## 14. Plugin System

Plugins are critical because the user wants to use the harness with their own tools, CLIs, MCPs, and workflows installed.

Your plugin layer should be above any one runtime.

Suggested hooks:

```text
onSessionStart
onUserMessage
onBeforeContextBuild
onAfterContextBuild
onModelSelect
onBeforeModelRequest
onAfterModelResponse
onBeforeToolCall
onAfterToolCall
onCommandStart
onCommandComplete
onFileChange
onCompaction
onBranch
onShare
onSessionEnd
```

Plugins should be able to:

- add commands
- add tools
- inject context
- watch files
- transform prompts
- add model routing rules
- add approval rules
- add custom renderers later
- persist plugin state

Plugin state should be stored in your canonical session/workspace store, not only in local files.

---

## 15. Visibility Requirements

The cloud sandbox should be transparent.

The user should be able to inspect:

```text
terminal output
running processes
command history
file changes
diffs
agent actions
tool calls
logs
workspace snapshots
artifacts
ports/previews
background jobs
```

This visibility is one of the main reasons to build your own cloud harness instead of only using existing local tools.

---

## 16. Device Switching

Device switching should work because the cloud workspace and session store are canonical.

From laptop:

```bash
agena new "fix Slack feedback modal"
```

From another laptop or phone later:

```bash
agena resume
```

The second device should reconnect to:

- same session
- same branch
- same workspace
- same terminal if still alive
- same files
- same logs
- same running/background jobs if applicable

Implementation approach:

```text
All clients subscribe to session event stream.
Each device stores only cursor/local UI state.
The cloud event log remains source of truth.
Workspace state lives in cloud filesystem.
```

---

## 17. Suggested MVP

Build the smallest useful version first.

### MVP Scope

```text
cloud daemon
local CLI
persistent workspace
session event store
basic agent runtime
Claude importer
Codex importer
session list/search/resume
terminal attach
file copy/download/share
basic plugin directory
workspace snapshots
```

### MVP Commands

```bash
agena import claude
agena import codex
agena sessions
agena search "query"
agena open <repo>
agena new "task"
agena resume <session>
agena attach
agena files
agena cp
agena share
```

### MVP Non-Goals

```text
desktop app
phone app
team collaboration
marketplace
universal live adapter support
perfect replay of imported sessions
full browser IDE
complex CRDT file editing
```

---

## 18. Later App Direction

After the CLI is reliable, build apps on top of the same backend.

Desktop app:

- session browser
- terminal
- file tree
- diff viewer
- logs
- model switcher
- plugin manager
- workspace snapshots

Phone app:

- resume sessions
- send follow-up prompts
- inspect progress
- view files/diffs/logs
- approve actions
- share/download artifacts

The app should not introduce a separate session model. It should only be another client of the same event stream and workspace APIs.

---

## 19. Final Recommended Positioning

The final Agena product direction is:

```text
Agena is a local-feeling cloud CLI harness for AI coding and work.
It imports your Claude/Codex history once, then becomes your daily source of truth.
It uses Pi-style sessions and plugins, OpenCode-style server ideas later, and your own cloud workspace as the foundation.
```

The product promise:

```text
Start work anywhere.
Resume anywhere.
Keep the same session, files, tools, plugins, and cloud machine.
Share files as easily as local paths.
Inspect everything the agent does inside the sandbox.
```

---

## 20. One-Line Summary

Build **Agena** as a CLI-first personal cloud AI harness with a Pi-style session/plugin core, one-time Claude/Codex backfill, local-like cloud filesystem UX, and OpenCode as a later runtime/API adapter — not as the source of truth.
