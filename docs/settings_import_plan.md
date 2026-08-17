# Settings Panel — Local Session & Project Import

Plan for a comprehensive Settings panel whose first feature imports the user's local
**Claude Code**, **Codex**, and **pi** sessions (plus the project folders they belong to)
into the Agena workspace, converted to pi format, seeded into the event log, and
resumable like any native session.

Status: **planned** · Validated by a local spike on 2026-07-09 (see §2).

---

## 1. What the user sees

Settings opens as a modal (⌘, and a ⌘K palette entry — no settings surface exists in the
renderer today, this creates it). First tab: **Import**.

```
Import from this machine                                    [Refresh]

[ ] ~/Desktop/Rough/zonko/luf          codex 99 · claude 68 · pi 12   proj 48 MB · sess 53 MB
      [ ] Codex (99 sessions, 31 MB)
      [ ] Claude Code (68 sessions, 20 MB)
      [ ] Pi (12 sessions, 2 MB)
[ ] ~/Desktop/Rough/agena              codex 31 · claude 44 · pi 0    proj 71 KB · sess 18 MB
      ...
[✓] ~/Desktop/Rough/openwork  — imported 2026-07-09 (project + claude)   [Import new]

                                          [Import project only]  [Import selected]
```

- One row per **project** (unique session cwd), expandable to per-harness checkboxes.
  v1 granularity is per-harness-per-project; per-individual-session checkboxes are a
  follow-up (the tree and import pipeline don't change, only the UI leaf level).
- Selecting a project with zero harnesses ticked = **project files only** (explicitly
  supported).
- Rows remember migration state ("imported", "partially imported", "N new sessions since
  import") from the daemon's import ledger (§6).
- **Refresh** is differential: only files whose `(path, mtime, size)` changed since the
  cached scan are re-read (§4).

## 2. What the spike proved (2026-07-09)

We converted this machine's entire local history with the
[agent-session-bridge](https://github.com/bohdanpodvirnyi/agent-session-bridge) core
(MIT) and verified the output against the exact pi build Agena embeds
(`@earendil-works/pi-coding-agent@0.80.3`):

- 221 Claude + 363 Codex source files → 563 imported → **410 pi session files**
  (Codex rollout files sharing a thread id correctly merge into one pi session).
- **392/410 open and walk to a leaf** via `SessionManager.open()` — the same call
  `packages/runtime-pi/src/adapter.ts:184` makes on resume. The 18 failures are
  header-only artifacts from empty sources (fix: skip before writing).
- pi session layout Agena's runtime reads: `<piDir>/sessions/--<cwd-dashes>--/
  <timestamp>_<sessionId>.jsonl`, header `{"type":"session","version":3,id,timestamp,cwd}`,
  entries as an id/parentId tree. `piDir` is `$AGENA_STATE_DIR/pi` in the container and is
  selected via `PI_CODING_AGENT_DIR` (`adapter.ts:48,134-148`).
- Known converter fixes found in the spike, to carry into ours:
  1. skip sources with zero convertible messages (don't create header-only mirrors);
  2. Claude subagent/workflow `journal.jsonl` files are noise — exclude `*/subagents/**`;
  3. don't `realpath` the recorded cwd (3 sessions failed on deleted dirs) — treat cwd as
     an opaque string;
  4. strip Codex bootstrap preambles (`<permissions instructions>`, `<environment_context>`,
     …) even when mixed with real user text in one message (bridge only drops all-bootstrap
     messages, which leaks preambles into first-message titles).

Spike scripts (throwaway, reference only): `/tmp/agent-session-bridge/import-all-test.mjs`,
`verify-pi.mjs`, `generate-report.mjs`.

## 3. Architecture

Conversion happens **client-side** (Electron main process); the daemon only ever receives
pi-native JSONL + events. The daemon never learns Claude/Codex formats — when those tools
change their formats (they do), only the app updates.

```
┌────────────────── Electron main ──────────────────┐   ┌───────────── daemon ─────────────┐
│ scanner  ~/.claude/projects, ~/.codex/sessions,   │   │ POST /v1/projects   (exists)      │
│          ~/.pi/agent/sessions, ~/.pi/sessions     │   │ POST /v1/files/upload (exists)    │
│ scan cache  userData/import-index.json            │   │ POST /v1/imports/session (NEW)    │
│ converter  claude|codex → pi v3 JSONL             │──►│   • write pi JSONL under piDir    │
│            pi → pi (cwd rewrite only)             │   │   • create session row            │
│ IPC: one new case in electron/bridge.mjs call()   │   │   • seed events (projection free) │
└───────────────────────────────────────────────────┘   │ imports ledger table (NEW)        │
        ▲ typed bridge (no new plumbing —                └──────────────────────────────────┘
          generic invoke channel, apps/desktopChamber/src/renderer/lib/bridge.ts:93-112)
```

### Why these placements

- **Scanner/converter in Electron main**: it already has Node fs (`electron/bridge.mjs:4-17`),
  a folder-walk precedent (`main.mjs:63-96`), and the sources live in the user's home dir.
  Renderer stays sandboxed.
- **Scan cache on the desktop, ledger on the daemon**: the scan describes *this machine*
  (cache it locally, `userData/import-index.json`); the ledger describes *what's in the
  container* (belongs in the daemon SQLite, survives app reinstall, consistent if a second
  client connects).
- **Events are truth**: imported transcripts are synthesized into durable events, so
  transcript, FTS search, and timeline work identically to native sessions — no second
  render path. The store's `#applyProjection` (`packages/storage-sqlite/src/store.ts:699-793`)
  gives us messages/tool_calls/FTS for free on append.

## 4. Scanner + differential refresh (Electron main)

New module `apps/desktopChamber/electron/importer/scan.mjs`.

Sources (all under `os.homedir()`):

| harness | root | session file | cwd from | session id from |
|---|---|---|---|---|
| claude | `~/.claude/projects/*/` | `*.jsonl` (top level only — exclude `*/subagents/**`) | first line with `cwd` | first `sessionId` field, else deterministic hash of path |
| codex | `~/.codex/sessions/YYYY/MM/DD/` | `rollout-*.jsonl` | `session_meta.payload.cwd` | `session_meta.payload.id` (thread id — multiple files may share it; group before counting) |
| pi | `~/.pi/agent/sessions/*/` **and** `~/.pi/sessions/*/` | `*_<uuid>.jsonl` | header `cwd` | header `id` |

Scan output, grouped by cwd:

```ts
type ScanIndex = {
  scannedAt: string;
  files: Record<string, { mtimeMs: number; size: number; harness: Harness;
                          cwd: string; sessionId: string; title: string;
                          messageCount: number }>;   // keyed by absolute path
};
type ProjectGroup = { cwd: string; exists: boolean; codebaseBytes: number | null;
                      byHarness: Record<Harness, { count: number; bytes: number }> };
```

- **Differential refresh**: full `readdir` of the roots every time (cheap — directory
  listings only), but a file is **re-parsed** (open + read cwd/id/title/counts) only when
  its `(mtimeMs, size)` differs from the cache. First scan parses everything (~600 files,
  seconds); refreshes touch only new/changed files.
- **Codebase size** = sum of `git ls-files` sizes (spike lesson: a JS directory walk hangs
  on iCloud-backed home dirs and grinds on vendored mega-trees; tracked-file sum is honest
  and returns in ms). Non-git or deleted cwds → `null`, rendered as "—", and file copy is
  disabled for them (sessions can still be imported).
- Cache lives at `userData/import-index.json` — **not** in `persisted.json` (that file is
  shallow-merged renderer state, `electron/bridge.mjs:56-77`; a multi-hundred-KB scan
  index doesn't belong there).

## 5. Converter (Electron main)

New package `packages/importer` (shared, so the TUI can reuse it later), vendoring the
bridge's converter/parser core (~650 lines MIT — `converters.ts`, `parsers.ts`, cwd
encoding from `path-utils.ts`) with the §2 fixes applied. We do **not** take the bridge's
registry/sync/daemon — that solves two-way live mirroring; ours is one-shot import.

- `claude → pi`, `codex → pi`: as in the bridge (normalized message model → pi v3 entries,
  linear parentId chain), plus `model.changed`-relevant metadata preserved
  (`model_change` / `thinking_level_change` entries when the source recorded them).
- `pi → pi`: no content conversion — parse, **rewrite header cwd**, re-emit.
- All converted sessions get their header cwd rewritten to the container path
  (`/workspace/<slug>`), since the local path is meaningless in the container.
- Codex thread-id groups (N rollout files, one thread) are merged into one pi session,
  ordered by timestamp.

## 6. Daemon: one new route + one new table

### `POST /v1/imports/session` (new, `packages/protocol/src/http.ts` route registry + handler in `apps/daemon/src/server.ts`)

Request (JSON): `{ projectId, projectRoot, title, sourceFingerprint: { harness, machineId,
sourcePath, sourceSessionId, mtimeMs, size }, piSession: <JSONL string> }`.
Sessions max ~13 MB on this corpus — a JSON body is fine; no chunked upload needed.

Handler steps (single logical operation):
1. Parse + validate the pi JSONL (header version 3, entries form a rooted tree).
2. Write it to `<piDir>/sessions/--<container-cwd-dashes>--/<timestamp>_<id>.jsonl`.
   `piDir` comes from the same config the runtime adapter uses.
3. `store.createSession` (project scope) → agena sessionId, then set
   `pi_session_path` to the file from step 2 (reuses `updateRuntimeSessionRef`,
   `store.ts:357-372`) so the orchestrator's lazy `#runtime` path
   (`packages/core/src/sessions/orchestrator.ts:347-370`) resumes it with zero changes.
4. Synthesize durable events from the pi branch and `store.appendEvents` them (§7).
5. Insert into the `imports` ledger; respond `{ sessionId, seededEvents }`.

Idempotency: the ledger has a UNIQUE key on `(machine_id, harness, source_session_id)`;
a re-import of the same source returns the existing sessionId (200, `alreadyImported: true`)
instead of duplicating. (The `NewEvent.id` dedupe hook anticipated in
`packages/core/src/events/store.ts:2-3` is not needed for v1 — one-shot semantics.)

### `imports` table (new, in `SqliteEventStore` ctor + a `#migrateSessionColumns`-style migration)

```sql
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,            -- ulid
  session_id TEXT,                -- NULL for project-only imports
  project_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,       -- desktop client-id (electron/bridge.mjs:79-92)
  harness TEXT NOT NULL,          -- claude | codex | pi | files
  source_path TEXT NOT NULL,
  source_session_id TEXT,
  source_mtime_ms INTEGER, source_size INTEGER,
  imported_at TEXT NOT NULL,
  UNIQUE (machine_id, harness, source_session_id)
);
```

Plus `GET /v1/imports?machineId=` so the Settings panel can render "imported ✓ /
N new since import" (join the scan index against the ledger client-side).
Project-only imports write a `harness='files'` row keyed by the project cwd.

## 7. Event synthesis (the "no events" answer)

Walk the pi session's main branch (`SessionManager`-compatible ordering: root → leaf) and
map entries to `durableEventSchemas` types (`packages/protocol/src/events.ts:330-363`):

| pi entry | durable event(s) |
|---|---|
| header | `session.created` (emitted by `store.createSession` already) + `session.title.changed` (derived title) |
| `model_change` | `model.changed` |
| `thinking_level_change` | `thinking.level.changed` |
| message `role:user` | `message.user.created` |
| message `role:assistant` | `message.assistant.completed` (text + thinking blocks; usage if present); each `toolCall` block → `tool.call.started` |
| message `role:toolResult` | `tool.call.completed` (or `.failed` when `isError`) |
| other/unknown entries | skipped (log count) |

Payloads must conform exactly to the existing schemas — imported sessions are
indistinguishable to clients. All synthesized events carry the source timestamps in their
payload timestamp fields; `seq` is assigned normally by `appendEvents`
(`store.ts:433-475`). Wrap per-session seeding in batched appends (500/batch) — the
largest session here is ~3.7k messages.

Anything the mapping can't represent stays available in the pi JSONL (which *is* the
runtime context on resume) — the event log is the UI/search projection, pi is the model
context, and both come from the same source file, so resume and transcript agree.

## 8. Import orchestration (Electron main, `importer/run.mjs`)

Per selected project, in order:

1. **Project**: `client.createProject(name)` (`packages/client/src/client.ts:425-429`) —
   derive the name from the cwd basename; on slug collision let the daemon 409 and surface
   a rename prompt.
2. **Files** (if requested and cwd exists): tar the local cwd with the existing in-process
   tar builder (`electron/bridge.mjs:485-560`, same skip-list) → `client.uploadFiles`.
   Constraint: `uploadTar` requires the target directory empty/absent
   (`server.ts:1016-1026` `ensureReplaceableDirectory`) — so files can only be copied into
   a **new** project. Importing sessions into an existing project is fine; adding files to
   one is out of scope for v1 (surface "project already has files" instead).
3. **Sessions** (per ticked harness): convert (§5) → `POST /v1/imports/session` each,
   sequentially with progress events streamed to the renderer (session i/N, bytes).
4. On completion, refresh the ledger + scan index; the sessions rail picks up the new
   sessions through the normal `listSessionSummaries` path.

Failure model: each session import is independent; one failure doesn't abort the batch.
The result panel lists per-session ok/skip(empty)/error.

## 9. Wiring (all the plumbing, exhaustively)

Desktop:
- `apps/desktopChamber/src/shared/bridge.ts` — extend `AgenaBridge`:
  `importScan(refresh?: boolean)`, `importRun(plan)`, `importStatus()` (ledger fetch),
  progress via the existing `onBatch`-style listener or a dedicated `onImportProgress`.
- `apps/desktopChamber/electron/bridge.mjs` — new `case`s in the `call()` switch (`:339-431`)
  delegating to `electron/importer/{scan,run}.mjs`. This is the only required IPC edit —
  preload/main/renderer proxies are generic (`lib/bridge.ts:93-112`).
- `apps/desktopChamber/src/renderer/mock/bridge.ts` — mock impls (fixture scan data) so
  `AGENA_MOCK=1` and browser dev keep working.
- Renderer: `features/settings/settings-modal.tsx` (radix `ui/modal.tsx` pattern),
  `useUi` boolean + `settings.toggle` command (⌘,) registered in
  `features/palette/global-hotkeys.tsx` alongside `BASE_COMMANDS`.

Shared/daemon:
- `packages/importer` — parsers/converters + event-synthesis mapping (pure; unit-testable).
- `packages/protocol/src/http.ts` — `importSessionRequest/Response` schemas + route
  registry entries (`PTY_HTTP_ROUTES`, `:306-414`); same for `GET /v1/imports`.
- `apps/daemon/src/server.ts` — handlers behind the existing bearer-auth middleware
  (`:358-366`).
- `packages/storage-sqlite/src/store.ts` — `imports` table + insert/query methods.
- `packages/client/src/client.ts` — `importSession()`, `listImports()`.

## 10. Milestones

1. **M1 — converter package**: vendor + fix converters, unit tests against fixture files
   drawn from real local sessions (claude, codex incl. multi-file thread, pi both stores,
   empty file, bootstrap-heavy codex, deleted cwd). Exit: fixtures round-trip and open via
   `SessionManager.open` in a temp `PI_CODING_AGENT_DIR` (the spike's verify, as a test).
2. **M2 — daemon import route + ledger**: schema, route, event synthesis. Exit: curl a
   converted JSONL in, see the session in the rail, transcript renders, FTS finds it,
   **prompting it resumes the pi context** (the real end-to-end proof).
3. **M3 — scanner + cache + diff refresh**: scan module + `import-index.json`. Exit: cold
   scan of this machine < 10 s, warm refresh < 1 s, new session appears after refresh.
4. **M4 — Settings UI**: modal, command, checklist tree, progress, ledger badges, mock.
   Exit: the §1 flow works end-to-end against local Docker and Modal.

## 11. Risks / open questions

- **Source formats drift** (Claude Code and Codex change JSONL shapes regularly). Contained:
  converter is client-side and versioned with the app; unknown entry types are skipped and
  counted, never fatal.
- **Local pi has two stores** (`~/.pi/agent/sessions` old encoding, `~/.pi/sessions` newer
  relative-to-home encoding, both present on this machine). Scan both; if the same session
  id appears in both, prefer the newer mtime.
- **Event payload fidelity**: `message.assistant.completed` etc. have required fields
  (ids, usage) the source may lack — synthesize deterministic ids from pi entry ids and
  zero usage when absent. Validate against `durableEventSchemas` in M1 tests, not at
  runtime-first-contact.
- **Large batches over Modal ingress**: uploads are buffered (no chunked transfer,
  `bridge.mjs:451-454`); per-session POSTs keep bodies ≤ ~13 MB. Fine.
- **v1 non-goals**: per-individual-session checkboxes (UI leaf level only), re-sync of a
  session that grew after import (ledger shows "changed since import"; re-import creates
  nothing new until we add append semantics), adding files to non-empty projects,
  reverse export (agena → local).
