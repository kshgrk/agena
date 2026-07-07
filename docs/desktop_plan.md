# Agena Desktop v1 — Architecture Plan

> Companion to `final_plan.md` (the daemon/protocol plan). This document is the single authoritative plan for the Agena desktop app. It changes **nothing** about the daemon: the desktop app is the second client of the existing protocol, exactly as anticipated by `final_plan.md` §17 Non-Goal 3 ("the protocol is designed for them; the clients are not built"). Where this document names a daemon surface, the name comes from `final_plan.md` and `packages/protocol`; if they disagree, this document is wrong.

## Table of Contents

1. [Executive Summary & Product Shape](#1-executive-summary--product-shape)
2. [Framework Decision: Electron](#2-framework-decision-electron)
3. [Non-Negotiable Invariants](#3-non-negotiable-invariants)
4. [System Architecture](#4-system-architecture)
5. [Process Model & IPC Contract](#5-process-model--ipc-contract)
6. [Repo Structure & Dependency Rules](#6-repo-structure--dependency-rules)
7. [UI Blueprint](#7-ui-blueprint)
8. [State Model](#8-state-model)
9. [Feature Inventory × Daemon Surface](#9-feature-inventory--daemon-surface)
10. [Tech Stack (decided)](#10-tech-stack-decided)
11. [Packaging & Distribution](#11-packaging--distribution)
12. [Testing Strategy](#12-testing-strategy)
13. [Build Milestones & Acceptance Criteria](#13-build-milestones--acceptance-criteria)
14. [V1 Non-Goals](#14-v1-non-goals)
15. [Open Decisions with Recommendations](#15-open-decisions-with-recommendations)
16. [Risk Register](#16-risk-register)

---

# 1. Executive Summary & Product Shape

## 1.1 One-liner and promise

**Agena Desktop is a session-first coding cockpit over the existing Agena daemon: session list on the left, live event transcript in the center, terminals and tools in dockable panes — every command, tool call, approval, model switch, snapshot, and shell attach visible, replayable, and trusted, because the durable event log already is the trace.**

The promise inherits FL-1…FL-9 from `final_plan.md` §1.4 and adds nothing to the daemon: kill the app mid-stream, reopen it (or open the TUI, or open it on another laptop) — same session, same seq-ordered history, live frames resume in under a second. The desktop app is a *view*; the daemon stays the single arbiter (INV-14).

## 1.2 What it is NOT

Not a browser IDE, not a VS Code fork, not file-first. Files, editor, terminals, ports are tools *inside* a session; the transcript/timeline is the center of gravity. The moment a PR makes the file tree the default view, the product has been inverted (see R4).

## 1.3 Daily flow

1. Launch → last-used profile, cursor, drafts, and layout paint before the WS opens; transcript fills from daemon replay.
2. New task: `⌘N` → prompt composer → live streaming transcript with tool calls unfolding.
3. Agent requests approval → trusted modal renders the canonical payload → approve once / deny / switch stance.
4. `⌘\`` drops into a real terminal in the session cwd (xterm.js over the dedicated PTY WS).
5. `⌘K` palette does everything D1-D3 owns: resume, search, snapshot, terminal, change model. Ports/imports/fork appear only when their daemon surfaces land.
6. Close the laptop. Open the TUI on the server. Same session. Nothing was lost because nothing lived in the client.

## 1.4 Feels-native requirements (FN-1 … FN-9)

Product acceptance requirements; milestone criteria (§13) cite them. They mirror FL-1…FL-9 where a daemon behavior already guarantees the substance.

| # | Requirement | Concrete target |
|---|---|---|
| FN-1 | Instant open | Window chrome, last profile, session rail cache, cursor, drafts, and layout paint < 400 ms; connection state lives in the status bar, never a blocking spinner. Cached transcript pages are a later optimization, not a D1 requirement. |
| FN-2 | Live streaming | Frames drive the in-flight tail with a 40 ms render throttle (§3.2 of final_plan: client render tick). No layout shift while streaming. |
| FN-3 | Invisible reconnect | Quit mid-stream, relaunch: durable replay from cursor + `snapshot` envelope + live frames < 1 s. Never a forever-pending block (INV-4 makes this possible; the UI must not undo it). |
| FN-4 | Real terminal | xterm.js over `GET /v1/ptys/:id/ws` is byte-for-byte the same experience as `agena shell`: same PTY, resize control frames, exit codes surfaced. |
| FN-5 | Trusted approvals | The approval modal renders **only** the canonical `approval.requested` payload — command, cwd, tool args — never agent prose. |
| FN-6 | Nothing hidden | Every durable event type has a visible representation in the transcript or timeline filter; unknown future event types render as a neutral marker row, never crash (mirrors `packages/tui/src/store.ts` §11.7 behavior). |
| FN-7 | Fail fast | Daemon unreachable ⇒ actionable error within 2 s (`daemon unreachable at <url> — is the container running?`), with a retry affordance. |
| FN-8 | Keyboard-first | Every UI action is palette-addressable (`⌘K`) and most have direct chords. Mouse is optional. |
| FN-9 | Client is a view | Uninstall/reinstall loses only layout, drafts, and cursors. All truth is daemon-side (INV-14). |

---

# 2. Framework Decision: Electron

The question "should we use anything else instead of Electron?" gets a real answer, not a default.

## 2.1 The constraint that decides it

Two hard constraints come from the existing system, not from taste:

1. **INV-12 / F62: WS auth is `Authorization` header on upgrade, and that is the *only* WS auth path.** A browser `WebSocket` cannot set headers. Therefore the process that opens sockets to the daemon must be a Node-capable process (Node's `WebSocket`/undici and the `ws` package both accept headers; `packages/client/src/client.ts` already has the `createSocket` seam and the `WsInit.headers` type for exactly this).
2. **The desktop app must absorb the CLI's local-machine responsibilities**: read `~/.config/agena/` profiles + credentials (shared with the CLI — one auth story), read `~/.claude` / `~/.codex` for imports (M6), and eventually drive `docker compose` for `workspace init`. That is filesystem + child-process access.

Any framework that gives us a real Node main process satisfies both natively. Anything else needs a sidecar.

## 2.2 Options considered

| Option | Verdict | Why |
|---|---|---|
| **Electron** | **✅ Chosen** | Node main process satisfies both constraints with zero extra moving parts. `@agena/client` runs unmodified in main (inject `ws` via the existing `createSocket` seam). xterm.js + Monaco are first-class. The team already writes TypeScript everywhere; no new toolchain. Cost: ~250 MB installed, ~150 MB RAM baseline — acceptable for a developer cockpit that hosts terminals and an editor anyway. |
| Tauri 2 | ❌ Rejected for v1 | Smaller binaries and RAM, but the core is Rust; `@agena/client` would need either a Rust rewrite (absurd — protocol churn would then hit two implementations) or a Node sidecar process managed by Tauri, which reintroduces Electron's architecture with more parts and two languages. Revisit only if footprint becomes a real user complaint (OD-D6). |
| Pure web app (browser → daemon) | ❌ Blocked by protocol | Header-only WS auth (F62 deleted the first-message-token variant), no `~/.claude` access, no local provisioning. Would require a protocol change (token query param or ticket endpoint) — that is a daemon conversation for a post-v1 web client, not a reason to distort v1. |
| Neutralino / NW.js / Wails | ❌ | Same sidecar problem as Tauri (Wails/Neutralino) or a smaller ecosystem than Electron for zero architectural gain (NW.js). |
| Native (SwiftUI/WinUI) | ❌ | Three platforms × a from-scratch terminal + editor + transcript renderer. Not a serious option for a solo/small team. |

**Decision: Electron, recorded as ADR-D001.** The renderer is plain web tech (React), so if a browser client ever becomes desirable, the renderer layer ports; only the main-process bridge is Electron-specific. That is the cheapest hedge available.

## 2.3 Electron baseline

- Electron ≥ latest stable at D1 start, pinned exact (same `save-exact` discipline as the monorepo).
- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` for the renderer. All privileged work in main, exposed through one typed `contextBridge` API (§5).
- Main process injects `ws` into `AgenaClient` via `createSocket`/`createPtySocket` rather than relying on the bundled Node's native `WebSocket` header behavior — one less thing coupled to Electron's Node version (OD-D1).

---

# 3. Non-Negotiable Invariants

**D-INV-1 — Protocol client only.** `@agena/desktop` in `apps/desktop` depends on `@agena/client` and `@agena/protocol` and nothing else internal. It never imports core, storage-sqlite, runtime-pi, tui, or cli. `scripts/check-boundaries.mjs` enforces the future edge before the package exists. Every feature maps to a protocol surface; missing data means a daemon/protocol PR first, never a client-side workaround (no scraping, no side channels).

**D-INV-2 — The token never enters the renderer.** All daemon traffic (HTTP, main WS, PTY WSs) originates in the Electron main process. The renderer receives events/frames/bytes over IPC and issues commands over IPC. `credentials.json` is read only in main. A compromised renderer (XSS via rendered markdown, a malicious preview page) must not be able to speak to the daemon directly.

**D-INV-3 — Approvals render canonical payloads.** The approval modal is built from the `approval.requested` event payload fields verbatim (tool name, args, command, cwd, kind). Assistant text may appear *near* the modal for context, visually distinct, but the thing being approved is always the daemon's payload. (Consent-integrity: what you approve is what executes.)

**D-INV-4 — Session-first.** The default view is always a session transcript. Files, editor, terminals, ports, snapshots are panes/tabs within the workspace, opened on demand. No "open folder" entry point exists.

**D-INV-5 — Renderer state = pure reducers over the wire.** View state is derived exclusively by pure functions `applyEvent / applyFrame / applySnapshot` (same contract as `packages/tui/src/store.ts`, richer output). Durable events finalize; frames touch only in-flight tails; `replayed: true` renders without animation. Client persists only: cursors (`sessionId → {branchId, seq}`), draft inputs, pane layout, window geometry, active profile.

**D-INV-6 — Unknown never crashes.** Unknown event/frame types render as neutral markers or are ignored (frames); malformed known payloads render an inline error row (mirrors §11.7). The desktop app must survive a newer daemon gracefully up to the `PROTOCOL_MISMATCH` gate.

**D-INV-7 — Works against an unmodified daemon.** No desktop-special routes, headers, or env flags. If the TUI and the desktop app ever disagree about state, one of them has a bug — the protocol is the arbiter.

**D-INV-8 — Destructive actions confirm with daemon truth.** Snapshot restore shows the safety-snapshot mechanism (`pre_restore`) and requires typed/explicit confirmation; session archive, snapshot delete, PTY kill confirm with the target's real identity fetched at confirm time.

---

# 4. System Architecture

## 4.1 Diagram

```
┌──────────────────────────── Agena Desktop (Electron) ────────────────────────────┐
│                                                                                  │
│  Renderer (Chromium, sandboxed, no Node)          Main process (Node)            │
│  ┌───────────────────────────────────┐            ┌───────────────────────────┐  │
│  │ React app                         │            │ bridge/                   │  │
│  │  store/  pure reducers            │  typed IPC │  AgenaClient (1 per       │  │
│  │   applyEvent/applyFrame/          │◄──────────►│   active profile)         │  │
│  │   applySnapshot                   │ contextBridge  ws injected via         │  │
│  │  features/                        │            │   createSocket seam       │  │
│  │   sessions/ transcript/ composer/ │            │  profiles/                │  │
│  │   approvals/ terminal/ files/     │  MessagePort│  ~/.config/agena reader  │  │
│  │   search/ snapshots/ ports/       │  per PTY   │  (shared with CLI)        │  │
│  │   timeline/ palette/ statusbar/   │◄──────────►│  pty-bridge/              │  │
│  │  xterm.js  Monaco  Dockview       │  raw bytes │  importers/ (M6: ~/.claude)│ │
│  └───────────────────────────────────┘            │  updater/ menu/ windows   │  │
│                                                   └────────────┬──────────────┘  │
└────────────────────────────────────────────────────────────────┼─────────────────┘
                                                                 │ Authorization: Bearer <token>
                                                                 ▼
                                              Agena daemon (unchanged)
                                              1× main WS /v1/ws · Hono HTTP /v1/*
                                              N× binary PTY WS /v1/ptys/:id/ws
```

## 4.2 Where things run

| Concern | Process | Note |
|---|---|---|
| `AgenaClient` (main WS, HTTP, reconnect, cursors-in-motion) | main | One instance per active profile. The SDK's auto-reconnect, requestId retry, and seq-gap healing are reused as-is. |
| PTY sockets | main | Bytes forwarded to the renderer over a dedicated `MessagePort` per terminal (§5.3). |
| Event/frame fan-in to UI | main → renderer | Batched per animation frame; frames coalesced per (sessionId, target) before crossing IPC (the SDK deliberately doesn't coalesce — the consumer does, per the `ponytail:` note in `client.ts`). |
| Profiles & credentials | main | Reads the same `~/.config/agena/config.json` + `credentials.json` the CLI writes. D1 needs either a read-only helper implemented in `apps/desktop` or a helper exposed from `@agena/client`; it must not import `apps/cli`. Desktop never invents its own auth store. |
| Cursors, drafts, layout | renderer-owned, persisted via main | Stored in the Electron `userData` dir; cursors interoperable in shape with the CLI's `cursors.json` (`sessionId → {branchId, seq}`). |
| Imports (M6) | main | Reads `~/.claude`/`~/.codex`, streams tar to `POST /v1/imports` — same code path shape as the CLI. |
| Workspace provisioning (`docker compose`) | main (post-D5, OD-D7) | Until then, `agena workspace init` in a terminal is the documented path. |

## 4.3 Connection lifecycle

Mirrors the CLI: main creates `AgenaClient` with the profile's URL + token + persisted `clientId` (a desktop-installation ULID, distinct from the CLI's, so `EventSource.clientId` correctly attributes which client issued a command — INV-9). Status transitions (`connecting/connected/reconnecting/closed`) stream to the status bar. Close code `1001` renders "daemon restarting — reconnecting" (the SDK already slows backoff for it). `PROTOCOL_MISMATCH` renders a blocking upgrade screen with both versions (exit-code-7 equivalent).

---

# 5. Process Model & IPC Contract

## 5.1 One bridge, mirroring the SDK

The preload script exposes exactly one API, `window.agena`, whose shape mirrors `AgenaClient` so renderer code reads like SDK code. It is the desktop equivalent of the wire contract — defined once, in `apps/desktop/src/shared/bridge.ts`, imported by main, preload, and renderer.

```ts
type AgenaBridge = {
  // lifecycle
  connect(profileName?: string): Promise<WelcomeInfo>;
  disconnect(): Promise<void>;
  listProfiles(): Promise<ProfileSummary[]>;          // from ~/.config/agena

  // commands — thin passthroughs to AgenaClient, same names, same acks
  prompt(sessionId: string, text: string): Promise<PromptAck>;
  steer(...): Promise<PromptAck>;  followUp(...): Promise<PromptAck>;
  abort(...): Promise<EmptyAck>;   respondToApproval(...): Promise<RespondToApprovalAck>;
  setModel(...): Promise<SetModelAck>;  setThinkingLevel(...): Promise<SetThinkingLevelAck>;
  compact(...): Promise<CompactAck>;    subscribe(sessionId: string, fromSeq: number): Promise<SubscribeAck>;

  // HTTP — same names as the SDK
  createSession(...); listSessionSummaries(...); updateSessionStatus(...);
  search(...); listApprovals(); listFiles(...); readFile(...); archiveFiles(...);
  listSnapshots(); createSnapshot(...); restoreSnapshot(...); deleteSnapshot(...);
  diagnostics(); readEvents(sessionId, fromSeq, limit);   // GET /v1/sessions/:id/events

  // streams — one subscription surface, batched delivery
  onBatch(cb: (batch: UiBatch) => void): Unsubscribe;
  onStatus(cb: (state: ConnectionState, detail?: string) => void): Unsubscribe;

  // terminals — returns a MessagePort carrying raw bytes + control frames
  openPty(opts: OpenPtyOptions): Promise<{ ptyId: string; port: MessagePort }>;
};
```

Rules:

- **Typed end to end.** The bridge types are derived from `@agena/protocol` types; `ipcMain.handle`/`invoke` payloads are validated with the same Zod schemas at the main-process boundary (a renderer is untrusted input — D-INV-2).
- **Exactly one stream channel.** Events, frames, sync, and snapshot envelopes cross IPC as one ordered `UiBatch { events: [...], frames: [...], syncs: [...], snapshots: [...] }` flushed at most once per animation frame (~16 ms) per window. Ordering within a session is preserved; the renderer applies events before frames within a batch (frames only touch in-flight state, so this is always safe).
- **Backpressure stance:** frames in an unflushed batch are coalesced keep-latest per `(sessionId, messageId|toolCallId)`; durable events are never dropped (mirrors the daemon's own two-valve policy §6.4).

## 5.2 Error mapping

`AgenaClientError` crosses IPC as `{code, message, retryable}` and is rethrown typed in the renderer. `SESSION_BUSY`, `TURN_NOT_ACTIVE`, `APPROVAL_NOT_PENDING`, `SESSION_READ_ONLY` are *expected* codes with specific UI behaviors (§7.6); everything else routes to a toast with the daemon's message.

## 5.3 PTY bridging

`openPty` in main calls the SDK (`POST /v1/ptys` → dedicated binary WS with bearer header), then transfers one end of a `MessageChannel` to the renderer. Bytes flow `PTY WS ↔ main ↔ MessagePort ↔ xterm.js` as `ArrayBuffer`s (transferable — no copy on the IPC hop). Control frames (resize, exit — `protocol/src/pty.ts` shapes) travel the same port as JSON messages, distinguished by type. The terminal component sends resize on container resize (Dockview pane events + xterm fit addon). Expected throughput is far below MessagePort limits; if a pathological case appears, OD-D2 holds the fallback (renderer-direct WS via header injection).

---

# 6. Repo Structure & Dependency Rules

## 6.1 Tree

```text
apps/desktop/                       # the Agena Desktop app (Electron)
├── package.json
├── electron.vite.config.ts         # electron-vite: main/preload/renderer builds
├── electron-builder.yml            # packaging (§11)
└── src/
    ├── shared/
    │   ├── bridge.ts               # AgenaBridge type + IPC channel names + UiBatch
    │   └── persisted.ts            # cursors/drafts/layout schemas (Zod)
    ├── main/
    │   ├── index.ts                # app lifecycle, single-instance lock, window mgmt
    │   ├── bridge.ts               # ipcMain.handle registry → AgenaClient calls
    │   ├── client-host.ts          # AgenaClient construction (ws injection), status relay
    │   ├── batcher.ts              # event/frame → UiBatch coalescing (§5.1)
    │   ├── pty-bridge.ts           # PTY WS ↔ MessagePort forwarding (§5.3)
    │   ├── profiles.ts             # ~/.config/agena reader (read-only in v1)
    │   ├── persistence.ts          # userData: cursors, drafts, layout, window state
    │   └── menu.ts                 # native menu; every item = a palette command id
    ├── preload/
    │   └── index.ts                # contextBridge.exposeInMainWorld("agena", …)
    └── renderer/
        ├── index.html  main.tsx  app.tsx
        ├── store/                  # PURE reducers + zustand containers (§8)
        │   ├── transcript.ts       # applyEvent/applyFrame/applySnapshot → rich blocks
        │   ├── sessions.ts  approvals.ts  connection.ts  timeline.ts
        │   └── layout.ts
        ├── features/
        │   ├── sessions/           # left rail: list, cards, picker, new-session
        │   ├── transcript/         # center: virtualized block list, in-flight tail
        │   ├── composer/           # input, mode (prompt/steer/followUp), model/thinking
        │   ├── approvals/          # modal + pending chips (D-INV-3)
        │   ├── inspector/          # right pane: raw event payload, provenance, timings
        │   ├── terminal/           # xterm tabs in bottom dock
        │   ├── timeline/           # filter strip + event density bar
        │   ├── files/              # tree + Monaco viewer (D3)
        │   ├── search/             # ⌘⇧F: FTS hits → jump-to-seq (D3)
        │   ├── snapshots/          # cards, create/restore/delete (D3)
        │   ├── ports/              # drawer + preview (D4, gated on M5.5)
        │   ├── imports/            # wizard (D5, gated on M6)
        │   ├── palette/            # cmdk; the command registry (§7.8)
        │   └── statusbar/
        └── ui/                     # shared primitives (Radix-based), theme tokens
```

## 6.2 Dependency rule (addition to final_plan §4.2)

| Package | May depend on (workspace) | External notes |
|---|---|---|
| `@agena/desktop` (`apps/desktop`) | client, protocol | Electron, React, Dockview, xterm.js, Monaco live here. Never imports core, storage-sqlite, runtime-pi, or tui. |

`check-boundaries.mjs` additions: `@agena/desktop` may depend only on `@agena/client` and `@agena/protocol`, and any `electron` import must live under `apps/desktop`.

## 6.3 Reducer reuse — the honest version

`packages/tui/src/store.ts` proves the reducer discipline (durable finalizes, frames touch in-flight only, malformed → marker row) but its output is TUI-lossy: content flattened to joined text. The desktop needs structured blocks (markdown source, tool args/results as data, thinking separated, blob refs). So the desktop **rewrites the reducers richer under the same contract and the same test style**, in `renderer/store/transcript.ts`. When both clients are mature and the shapes converge, extracting `@agena/view-store` is OD-D4 — not before (no shared package for a single consumer).

---

# 7. UI Blueprint

## 7.1 Window layout

Dockview workbench; default layout below. Every pane is closable/movable; layout persists per workspace.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⌘K Command Palette (overlay)                              [profile ▾] [—□×] │
├────────────┬──────────────────────────────────────────────┬─────────────────┤
│ SESSIONS   │  TRANSCRIPT — session title            [⑂][⋯] │ INSPECTOR       │
│ ┌────────┐ │  ┌────────────────────────────────────────┐  │ (selected event)│
│ │● fix-auth│ │  │ user     Fix the flaky auth test      │  │ type: tool.call.│
│ │  main    │ │  │ ▼ tool   bash: pnpm test auth   ✓ 3.2s│  │   completed     │
│ │  2m ago  │ │  │ assistant The failure is a race in…   │  │ seq: 143        │
│ ├────────┤ │  │ ▼ tool   edit: src/auth/session.ts ✓  │  │ source: runtime │
│ │○ import- │ │  │ ⚠ APPROVAL  bash: git push …  [view]  │  │ (pi)            │
│ │  codex   │ │  │ assistant ▌streaming tail…            │  │ duration: 3.2s  │
│ │  read-only│ │  └────────────────────────────────────────┘  │ payload {…}     │
│ ├────────┤ │  TIMELINE  [All][Agent][Tools][Term][Appr]   │ [copy] [raw]    │
│ │+ New ⌘N │ │  ────●──●───●●───⚠───●────────────────────  │                 │
├────────────┤──────────────────────────────────────────────┴─────────────────┤
│ ⌘⇧F Search │  COMPOSER  [prompt ▾] [model: pi/… ▾] [think: med ▾]  [Send ⏎] │
├────────────┴─────────────────────────────────────────────────────────────────┤
│ TERMINAL  [shell ×][tests ×][+]                        PORTS(2) · DIAG       │
│ $ pnpm test auth …                                                            │
├───────────────────────────────────────────────────────────────────────────────┤
│ ● connected · ws-7f3a · /workspace/repo-a · session: fix-auth · pi/sonnet ·   │
│   thinking: medium · 1 pending approval                                       │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 7.2 Left rail — sessions

Backed by `GET /v1/sessions` (`SessionSummary`) + live `session.status.updated` frames. Card fields, v1-honest (only what the projection carries): title, status dot (`active/idle/archived`), source badge (`native/claude/codex`; imported ⇒ read-only badge), project scope, relative last-activity (ULID-derived), model chip once a `model.changed` has been seen. Grouped by project (M4 scope filters); `--global` sessions under a separate group; archived behind a toggle. Context-menu: resume, archive, copy id. **No changed-files count, no cost column** — projections don't carry them (see §15 OD-D5).

## 7.3 Center — transcript

The product. A virtualized list of blocks derived from durable events; one in-flight tail driven by frames.

| Event(s) | Block rendering |
|---|---|
| `message.user.created` | Right-aligned user block; markdown. |
| `message.assistant.started` → deltas → `completed` | Streaming tail (monospace-safe markdown, thinking collapsed by default behind a disclosure) → finalized block replaces tail with authoritative content (P12: completed content wins over accumulated deltas — reducer already guarantees this). |
| `message.assistant.aborted / failed` | Finalized partial content + a status chip (`aborted — user`, `failed — daemon_restart`), styled but never hidden. |
| `tool.call.started/…output.delta…/completed/failed/aborted/denied` | Collapsible tool block: header = tool name + one-line arg summary + status + duration; body = args (pretty JSON) and output (streamed, ANSI-stripped, truncated at fold with "show all"); `denied` shows denier (approval or hook, from payload). |
| `approval.requested/responded/expired/cancelled` | Inline approval card: requested = live card with respond buttons (same action path as the modal); terminal states render the outcome + who (`respondedBy` clientId). |
| `model.changed`, `thinking.level.changed`, `compaction.*` | Thin marker rows (`model → pi/x`, `compacted: 84 messages replaced`). |
| `terminal.session.started/ended` | Marker row with a "open terminal" affordance while live. |
| `snapshot.created/restored/…` (control session) | Marker row in affected sessions' timeline view + snapshot pane cards. |
| `run.*`, `message.runtime.created` | Timeline-only by default (visible under the All/Agent filters); `message.runtime.created` renders as a system block. |
| Unknown type | Neutral marker `event <type> (seq N)` (D-INV-6). |

Behaviors: `replayed: true` renders instantly with no animation; auto-scroll pins to bottom only when already at bottom; jump-to-seq (from search/timeline) scrolls and flash-highlights; long sessions page backward through `GET /v1/sessions/:id/events` rather than holding everything (the reducer is fed oldest-first per page; virtualization handles the rest).

## 7.4 Timeline strip

A horizontal density bar over the full seq range with filter chips: `All · Agent · Tools · Terminal · Approvals · Snapshots · Errors`. Chips filter the transcript; clicking a dot jumps to that seq. This is the Langfuse/replay idea collapsed to its useful core — no separate "trace product," because the event log already is one (INV-2).

## 7.5 Right inspector

Opens on block/dot selection: full canonical payload (pretty JSON, blob refs lazy-fetchable when `GET /v1/blobs/:hash` lands — M7), provenance (`source.kind/runtime/clientId`), seq/branch, timings derived from adjacent events, copy-as-JSON. This pane is also the debugging story for Agena itself.

## 7.6 Composer

- Mode select is implicit: session idle ⇒ `prompt`; turn active ⇒ input becomes `steer` with an explicit `followUp` toggle (queued indicator from the `queued` ack field). The §5.4 legality matrix maps to UI state — `SESSION_BUSY` on prompt is *prevented* by mode, not surfaced as an error; a race that still yields `SESSION_BUSY` converts the draft to steer with a one-line notice; `TURN_NOT_ACTIVE` reverts to prompt.
- `Esc` = abort (with confirm while streaming). Model picker (`setModel`, between turns per matrix) and thinking picker (`setThinkingLevel`) live under the input; `compact` in the overflow menu + palette.
- Read-only (imported) sessions: composer is replaced by "imported session — resume as native" (M6 semantics).
- Draft persists per session (FN-9 scope).

## 7.7 Approval modal (D-INV-3)

Triggered by `approval.requested` on any subscribed session (+ chips in the status bar from `GET /v1/approvals?pending=1` at connect, so pending approvals surface even for unsubscribed sessions).

```
┌─ Approval requested — session fix-auth ────────────────────┐
│ Tool: bash                                                 │
│ Command: git push origin main                              │
│ cwd: /workspace/repo-a                                     │
│ (every field verbatim from the approval.requested payload) │
│                                                            │
│ kind=options: [option buttons from payload]                │
│ kind=input:   [text field]                                 │
│ kind=editor:  [Monaco buffer]  (the --input-file kind)     │
│                                                            │
│              [Deny]                [Approve]               │
└────────────────────────────────────────────────────────────┘
```

First-write-wins is daemon truth: a losing respond (`APPROVAL_NOT_PENDING`) closes the modal with "answered by <client> from replay". Disconnect/reconnect re-derives pending from replayed events (P14) — the modal reappears by state, not by memory. **No "always allow" in v1** — allowlist policy is daemon-side work that doesn't exist yet (§14-6).

## 7.8 Command palette & keys

cmdk overlay; one command registry (id, title, scope, chord, enablement predicate) that also drives the native menu — the registry is the single owner, menus are a projection of it. v1 chords: `⌘K` palette · `⌘N` new session · `⌘P` session picker · `⌘⇧F` search · `` ⌘` `` terminal · `⌘I` inspector · `⌘1..9` session hotlist · `Esc` abort/close.

## 7.9 Bottom dock

- **Terminals:** xterm tabs (fit + webgl + search addons). Tab title = cwd tail or user label; session-linked PTYs (opened from a session) badge the session and emit the durable lifecycle events; standalone ones don't (per §1.5). Exit code shown on close; idle-reaped PTYs (15 min) render as closed with reason. "Send selection to composer" is the one cross-pane affordance in v1 (the rest of the Devin-style terminal-AI interplay is post-v1).
- **Ports (D4/M5.5):** detected + exposed ports, copy preview URL, open external, open in preview pane, hide. Private-by-default visibility mirrored exactly; no "make it feel local" language (non-goal).
- **Diagnostics:** rendered `GET /v1/diagnostics` — daemon health, versions, event counts, `.agena/` discovery report with per-descriptor errors.

## 7.10 Status bar

`connection state · workspace id · project/cwd · session status · model · thinking level · pending approvals (n) · daemon version`. Anything red is clickable to the relevant pane. No context-%/cost segments in D1-D3; optional raw usage exists on some events, but product meters wait for stable coverage and pricing semantics (OD-D5).

## 7.11 First-run & profiles

First launch with no `~/.config/agena`: a setup screen points at the CLI (`agena workspace init` / `agena login`). Manual URL+token entry is allowed only once the profile config helper can write the shared files safely; otherwise D1 stays read-only. Profile switcher in the title bar; switching profiles swaps the `AgenaClient` in main (one active profile per window in v1 — OD-D8 for multi-window).

---

# 8. State Model

Zustand stores as thin containers; **all** mutation goes through the pure reducers (D-INV-5). Store slices: `connection` (status/welcome/profile), `sessions` (summaries + status frames), `transcript` (per-subscribed-session `TranscriptState`, LRU-bounded — unsubscribe evicts), `approvals` (pending map derived from events + the connect-time HTTP scan), `timeline` (per-session event index for the density bar), `layout` (Dockview serialized + persisted via main).

Subscription flow on session open: read cursor → render the selected session shell immediately (FN-1) → `subscribe {sessionId, fromSeq: cursor}` → replayed events apply (no animation) → `sync` marks live → `snapshot` seeds in-flight tail + pending approvals → frames animate. Cached transcript pages can be added in D3+ after paging and eviction behavior are proven.

---

# 9. Feature Inventory × Daemon Surface

What the desktop can ship, keyed to what the daemon serves. "Route/command exists" means the current codebase exposes the surface; "Desktop-ready" names the first desktop milestone that may build the UX.

| Desktop feature | Daemon/client surface | Route/command exists | Desktop-ready |
|---|---|---:|---|
| Connect/handshake/reconnect | `GET /v1/ws`, hello/welcome, subscribe/sync/snapshot | yes | D1 |
| Profile selection | shared `~/.config/agena` files | files exist by CLI convention | D1 only after helper exists or is implemented locally |
| Session list/create/archive | `GET/POST /v1/sessions`, `PATCH /v1/sessions/:id` | yes | D1 |
| Transcript live + replay | events over WS, `GET /v1/sessions/:id/events` | yes | D1 |
| Backward paging for long transcripts | `GET /v1/sessions/:id/events?fromSeq&limit` | yes | D3 |
| Cached transcript pages | local desktop cache only | no daemon need | D3+ after paging works |
| Composer: prompt/abort | `prompt`, `abort` | yes | D1 |
| Composer: steer/followUp | `steer`, `followUp` | yes | D2 |
| Model/thinking/compact controls | `runtimeInfo`, `setModel`, `setThinkingLevel`, `compact` | yes | D2 |
| Approvals modal + pending chips | `approval.*`, `respondToApproval`, `GET /v1/approvals` | yes | D2 |
| Terminals | `POST /v1/ptys`, `GET /v1/ptys/:id/ws`, control frames | yes | D2 |
| Search + jump-to-seq | `GET /v1/search` | yes | D3 |
| File tree + Monaco viewer | `GET /v1/files`, `/content`, `/archive` | yes | D3 read-only |
| File editing/save | upload/write route | no | later; not D3 |
| Snapshots create/restore/delete | `/v1/snapshots*` | yes | D3 |
| Diagnostics pane | `GET /v1/diagnostics` | yes | D1 |
| Ports drawer + preview pane | M5.5 registry + ingress | no current route | D4 |
| Imports wizard | `POST /v1/imports` | no current route | D5 |
| Blob lazy-fetch in inspector | `GET /v1/blobs/:hash` | no current route | later/M7 |
| Fork session | `POST /v1/sessions/:id/fork` | no current route | later/stretch |
| Usage meters | optional raw usage fields, no stable product meter contract | partial | later/OD-D5 |

The consequence: the current daemon/client surfaces are enough for a useful D1-D3 desktop, but route existence is not the same as desktop readiness. The "start after M5.5" decision buys stability (acceptance suites green, surfaces frozen), not a need to change the daemon.

---

# 10. Tech Stack (decided)

| Layer | Choice | One-line why |
|---|---|---|
| Shell | **Electron** (pinned exact) | §2. ADR-D001. |
| Build | **electron-vite** | Standard main/preload/renderer pipeline; Vite HMR in renderer. |
| UI framework | **React 19 + TypeScript strict** | Team language; ecosystem for every pane below. |
| Docking | **Dockview** | VS Code-grade dock/split/tabs/persist without forking an IDE. |
| Terminal | **@xterm/xterm** + fit/webgl/search addons | The PTY WS is its native diet. |
| Editor/diff | **Monaco** | Viewer + built-in DiffEditor (snapshot compare later). |
| Transcript virtualization | **@tanstack/react-virtual** | Long sessions. |
| Markdown/code | **react-markdown + shiki** | Assistant/user blocks. |
| Palette | **cmdk** | §7.8 registry front-end. |
| Primitives | **Radix UI** + Tailwind | Modals/menus/tooltips, accessibility included; dark theme first. |
| State | **zustand** (containers) + hand-written pure reducers | D-INV-5; reducers are the tested core, the store is plumbing. |
| Validation | **zod** via `@agena/protocol` | Same schemas at the IPC boundary. |
| Lint/format/test | **Biome + Vitest** (monorepo standard), **Playwright** for e2e | §12. |
| Packaging | **electron-builder** (+ notarization) | §11. |

No Redux, no GraphQL, no ORM, no CSS-in-JS runtime, no custom docking, no custom terminal emulator, no state-sync library — the daemon's event log is the state-sync library.

---

# 11. Packaging & Distribution

- `electron-builder`: dmg + zip (macOS arm64/x64), nsis (Windows), AppImage + deb (Linux). CI builds on tag.
- macOS: hardened runtime, Developer ID signing, notarization from the first public build (the CLI's ad-hoc stance doesn't transfer — Gatekeeper treats apps harsher than CLIs).
- Auto-update: **deferred to post-D5** (OD-D3). v1 ships manual downloads + an in-app "new version" notice from a static JSON feed. Auto-update infra before product-market fit is inverted priorities.
- Version/protocol coupling: the About screen and the `PROTOCOL_MISMATCH` screen both show app version, protocol version, daemon version — support triage in one screenshot.

---

# 12. Testing Strategy

Reuses the daemon plan's central trick: **`FakeRuntimeAdapter` + a real daemon = full-stack tests with zero model calls** (P16).

1. **Reducer suite (Vitest, pure):** `applyEvent/applyFrame/applySnapshot` against protocol-valid event sequences — including every §5.6 crash payload, malformed-known-payload (marker row), unknown-type (ignored), replay idempotence (same events twice by seq ⇒ same state). This is the desktop twin of the TUI store tests.
2. **Bridge contract suite (Vitest, Node):** `client-host` + `batcher` against a fake `AgenaClient` (the SDK's `createSocket` seam): batching order (events before frames), keep-latest frame coalescing, status relay, error mapping.
3. **E2E (Playwright + Electron):** spawn the real daemon (fake runtime mode) in a temp dir; drive the app: connect → new session → prompt → streamed tail → kill window mid-stream → relaunch → replay <1 s (FN-3); approval modal round-trip; terminal echo + resize; `SESSION_BUSY` composer conversion. These mirror the daemon's own milestone demo scripts so a regression points at the right layer.
4. **CI:** the desktop jobs join the existing pipeline; `check-boundaries.mjs` extensions (§6.2) block on the first commit.

---

# 13. Build Milestones & Acceptance Criteria

Same discipline as final_plan §14: each milestone = a human demo + green suites, criteria cite FN/FL numbers. Daemon prerequisites are stated; per §9 most already exist — the plan assumes desktop work starts after M5.5 per the standing decision, but D0 can run any time.

### D0 — Spike (≤2 days, can run now)

Throwaway: Electron window + `AgenaClient` in main with `ws` injected + xterm.js over a real PTY WS + one MessagePort bridge. Proves the only two integration unknowns (header auth from main; PTY bytes over IPC at typing/scroll rates).
**Acceptance:** interactive shell with correct resize against a real daemon; input latency indistinguishable from `agena shell` by feel.

### D1 — Cockpit Skeleton

**Prerequisite:** profile config access is solved without importing `apps/cli`: either a read-only helper exists in `@agena/client`, or `apps/desktop` implements the minimal XDG reader itself.

**Scope:** profiles reader; connect/handshake/status bar; session rail (list/create/archive); diagnostics pane; transcript with replay + live streaming + in-flight tail + unknown-event markers; composer (prompt/abort only); palette skeleton; cursor/draft/layout persistence; CI + boundary checks. No cached transcript pages yet.
**Acceptance:**
1. Launch → window, last profile, rail shell, cursor, draft, and layout paint < 400 ms; WS connects after paint. *(FN-1)*
2. Prompt → streamed tail → finalized block matches TUI rendering of the same session. *(FN-2, D-INV-7)*
3. Quit mid-stream; relaunch: replay + snapshot + live frames < 1 s; no pending spinner. *(FN-3)*
4. Desktop and TUI subscribed to the same session render identical seq streams. *(FL-6)*
5. Daemon down ⇒ actionable error < 2 s with retry. *(FN-7)*
6. Reducer + bridge suites green; boundary check green.

### D2 — Terminals, Approvals, Turn Controls

**Scope:** terminal dock (xterm tabs, session-linked + standalone, resize/exit); approval modal + pending chips (D-INV-3, all three kinds); composer modes (steer/followUp + `SESSION_BUSY` conversion); model/thinking pickers; `compact`; inspector pane v1.
**Acceptance:**
1. `touch /workspace/hello.txt` in a desktop terminal; the agent sees it; `terminal.session.*` markers appear in the transcript. *(FL-4, FN-6)*
2. Approval round-trip from the modal; disconnect while pending → relaunch → modal reappears from replayed state. *(FN-5, P14)*
3. Desktop aborts a turn the TUI started: both clients render aborted-with-partial identically. *(FL-6)*
4. Two clients prompt simultaneously: one turn runs; the desktop converts the loser's draft to steer with a notice. *(§7.6)*
5. E2E suite covers 1–4 with the fake runtime.

### D3 — Files, Search, Snapshots, Timeline

**Scope:** file tree + Monaco viewer (read-only); search pane with jump-to-seq + flash; snapshot cards (create/restore with pre_restore confirm, delete); timeline strip + filters; backward paging for long transcripts. Optional cached transcript pages may start here only after paging is stable; file editing waits for a write/upload route.
**Acceptance:**
1. Search hit in another session → opens it at that seq with highlight. *(FN-8 path)*
2. Snapshot restore: files revert, transcript history visibly does not; the `snapshot.restored` marker renders. *(FL-9 / P1, D-INV-8)*
3. A 10k-event session scrolls at 60 fps and pages backward without eviction glitches.
4. Timeline filter to Approvals shows exactly the approval events; clicking one selects it in the inspector.
5. File viewer opens a workspace file via the read route and offers no save action.

### D4 — Ports & Preview *(daemon ≥ M5.5)*

**Scope:** ports drawer (list/expose/hide, copy URL, visibility); preview pane via `WebContentsView` for preview URLs; localhost-detection hints from terminal output (hint only, confirm to expose — mirrors M5.5).
**Acceptance:** dev server in a desktop terminal → expose → preview renders in-pane and on a phone browser; hide kills external access, not the process; local-Docker behavior matches whatever OD-D9 decided.

### D5 — Imports, Polish, First Release *(daemon ≥ M6)*

**Scope:** import wizard (main-process `~/.claude`/`~/.codex` → `POST /v1/imports`, progress, idempotent re-run); read-only session rendering + "resume as native"; first-run/setup screen final; packaging + signing + notarization; static-feed update notice; docs.
**Acceptance:** fresh machine → download → setup screen → connect → import Claude history → search it → resume as native session. The whole demo without touching a terminal except by choice.

---

# 14. V1 Non-Goals

Each is a decision, not an omission — most inherit directly from final_plan §17.

1. **Browser build** — blocked by header-only WS auth (F62); becomes a protocol conversation post-v1. The React renderer keeps the option cheap.
2. **IDE ambitions** — no extension host, no LSP, no multi-file refactoring UI, no git pane (the terminal is the git UI in v1). Monaco stays a viewer/light editor.
3. **Localhost forwarding, VPN, callback/webhook inbox** — daemon non-goals 13/14; the desktop must not fake them in UI copy.
4. **Cost/token/context meters** — some events may carry optional raw usage, but desktop product meters need stable coverage and pricing semantics; OD-D5 first.
5. **Share links, multi-user presence** — parked with P9.
6. **Approval allowlists / "always allow"** — needs daemon-side policy that doesn't exist; the modal ships allow-once/deny only.
7. **Terminal-AI deep integration** (auto "fix this error", @-mention terminals) — one affordance ships (send selection to composer); the rest waits for real usage.
8. **Mobile companion** — the protocol supports it; a different client, a different plan.
9. **Workspace provisioning UI** — `agena workspace init` in a terminal remains the v1 path (OD-D7 revisits post-D5).
10. **Auto-update infrastructure** — static-feed notice only (OD-D3).
11. **Multi-window / simultaneous multi-profile** — one window, one active profile (OD-D8).
12. **Custom themes/plugins for the desktop app itself** — `.agena/` extensibility is daemon-side; the desktop renders its results and ships one dark + one light theme.

---

# 15. Open Decisions with Recommendations

1. **OD-D1 — WS construction in main.** Native Node `WebSocket` (undici, headers work on Node ≥22) vs injecting `ws` via the SDK's `createSocket` seam. *Recommendation:* inject `ws` — decouples from Electron's bundled Node version; one dependency, zero SDK changes. Decide at D0.
2. **OD-D2 — PTY transport fallback.** If MessagePort forwarding ever measurably lags: renderer-direct PTY WS with `session.webRequest.onBeforeSendHeaders` header injection (token stays out of renderer JS but is attached by the network layer). *Recommendation:* don't build until D0 measurements demand it.
3. **OD-D3 — Auto-update.** electron-updater + a release bucket vs static-feed notice. *Recommendation:* static feed through D5; revisit at first public release feedback.
4. **OD-D4 — Shared view-store package.** Extract `@agena/view-store` (reducers) for TUI + desktop convergence. *Recommendation:* only when the desktop reducers stabilize AND the TUI wants richer blocks; two consumers is the trigger (same rule as OD7 in final_plan).
5. **OD-D5 — Usage/cost meters.** Optional usage fields exist on some completion/run events, but the desktop should not turn them into status-bar meters until coverage and pricing semantics are reliable. *Recommendation:* render raw usage in the inspector when present; add meters later. Client never estimates costs itself (D-INV-1 spirit).
6. **OD-D6 — Tauri revisit trigger.** *Recommendation:* only if installed-size/RAM becomes a top-3 user complaint post-release; the renderer ports, the bridge rewrites.
7. **OD-D7 — Workspace provisioning in-app** (`docker compose` from main). *Recommendation:* post-D5; the setup screen's "point me at a workspace" copy covers v1.
8. **OD-D8 — Multi-window.** One `AgenaClient` per window vs shared main-process pool. *Recommendation:* defer; the batcher and client-host are written per-window-ready (no globals) so this is additive later.
9. **OD-D9 — Local-Docker preview access** (the standing pre-decision from the M5.5 planning note): local ingress vs daemon proxy route vs "remote-only previews in v1". *Recommendation:* decide inside M5.5's design as already agreed; D4 consumes whatever it decides.

---

# 16. Risk Register

| # | Risk | L | I | Mitigation | Early-warning signal |
|---|---|---|---|---|---|
| R1 | **Transcript renderer scope creep** — the 80%-of-effort pane absorbs the schedule | H | M | Block table in §7.3 is the spec; anything not in it is post-v1; virtualization from day one | D1 slips on "one more block type" |
| R2 | **IPC batching subtly reorders events/frames** | M | H | One ordered UiBatch channel; events-before-frames rule; bridge contract suite asserts ordering | Transcript flicker or stale tails in D1 e2e |
| R3 | **Dockview doesn't fit some pane behavior** | L | M | It's contained in `layout.ts` + feature shells; worst case swap for FlexLayout behind the same layout store | Fighting the library in D1 |
| R4 | **Product inversion to file-first IDE** | M | H | D-INV-4; non-goal 2; review gate: no "open folder" affordance ever merges | A PR adding a folder-open dialog |
| R5 | **Daemon surface drift before desktop starts** (post-M5.5 start) | M | M | Protocol conformance tests + integer version gate already exist; D0 spike is rerunnable cheaply | `PROTOCOL_MISMATCH` in D0 rerun |
| R6 | **Electron security misconfig** (renderer privilege leak) | L | H | D-INV-2 checklist: sandbox on, contextIsolation on, one preload API, Zod at IPC boundary, CSP on renderer, preview pane in isolated `WebContentsView` | Any `nodeIntegration: true` or direct-fetch-from-renderer diff |
| R7 | **PTY-over-IPC latency feels non-native** | L | M | D0 measures it first; OD-D2 fallback exists | D0 typing feel |
| R8 | **Two clients diverge in rendering semantics** (TUI vs desktop) | M | M | Both consume the same fixtures in reducer tests; FL-6 cross-client acceptance in D1/D2 | Same session looks different in the two clients |

---

## Appendix A — What the desktop app deliberately reuses vs rebuilds

| Reuses as-is | Rebuilds richer | Never builds |
|---|---|---|
| `@agena/client` (sockets, reconnect, requestId retry, seq healing, PTY attach) | Transcript reducers (structured blocks vs TUI's flattened text, same contract + test style) | Terminal emulator (xterm.js) |
| `@agena/protocol` (schemas at every boundary incl. IPC) | Session/approval/timeline view stores | Editor (Monaco) |
| `~/.config/agena` profiles + credentials (CLI-shared) | Command registry (palette + menu from one table) | Docking system (Dockview) |
| Daemon acceptance semantics (FL-*) as FN-* targets | First-run/setup flow | State sync (the event log is the sync) |
