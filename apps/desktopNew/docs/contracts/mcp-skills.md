# Contract: MCP import, Skill import, Session import (commit e4338e1)

Audience: builders of the new renderer (`apps/desktopNew`). You will NOT read the
old sources — this document is the complete reference for these three features.

Architecture in one paragraph: the **renderer never talks to the daemon**. It
calls typed bridge methods (Electron `contextBridge` → main process). The main
process owns (a) local-machine scanning (config files, session JSONLs, skill
folders), (b) the daemon HTTP client, and (c) the OAuth loopback server + system
browser. Secrets (API keys, env values, skill source URLs) exist only in the
main process and the daemon; every shape the renderer sees is deliberately
secret-free.

```
renderer (React)  ──bridge──▶  Electron main  ──HTTP──▶  daemon (/v1/*)
  join by `identity`            scans local FS,           persists to SQLite,
  render statuses               caches scan index,        encrypts secrets,
                                runs OAuth loopback       writes pi adapter cfg
```

---

## 1. Daemon HTTP API

All routes live under `/v1`. Error envelope everywhere:

```ts
{ code: string; message: string; retryable: boolean; details?: ZodIssue[] }
```

Codes used by these features: `INVALID_PAYLOAD` (400), `NOT_FOUND` (404),
`MCP_AUTH_FAILED` (400), `SKILL_UPDATE_FAILED` (400, retryable: true),
`NOT_SUPPORTED` (501 — daemon running without SQLite), `INTERNAL` (500).

| Method | Path | Request | Response |
|---|---|---|---|
| GET  | `/v1/mcps` | — | `{ mcps: McpSummary[] }` |
| POST | `/v1/mcps/import` | `ImportMcpRequest` | `{ mcp: McpSummary }` |
| POST | `/v1/mcps/:id/oauth/start` | — | `{ authorizationUrl: string }` |
| POST | `/v1/mcps/:id/oauth/complete` | `{ redirectUrl: string (url) }` | `{ mcp: McpSummary }` |
| GET  | `/v1/skills` | — | `{ skills: SkillSummary[] }` |
| POST | `/v1/skills/import` | `ImportSkillRequest` | `{ skill: SkillSummary }` |
| POST | `/v1/skills/check-updates` | — | `{ skills: SkillSummary[] }` |
| POST | `/v1/skills/:id/update` | — | `{ skill: SkillSummary }` |
| POST | `/v1/imports/session` | `ImportSessionRequest` | `ImportSessionResponse` (201 on new, 200 on dedupe) |
| GET  | `/v1/imports?machineId=` | query | `{ imports: ImportLedgerEntry[] }` |

After a successful skill import, skill update, or MCP import the daemon calls
`adapter.reloadExtensions?.()` so the running pi adapter picks the change up.

### 1.1 Protocol schemas (verbatim from `packages/protocol/src/http.ts`, zod)

```ts
// ---- MCP ----
export const mcpTransportSchema = z.enum(["stdio", "http", "sse"]);
export const mcpAuthKindSchema = z.enum(["none", "oauth", "api_key"]);
export const mcpStatusSchema = z.enum(["imported", "needs_auth", "connected", "error"]);
const mcpStringMapSchema = z.record(z.string(), z.string());

export const importMcpRequestSchema = z
  .object({
    identity: z.string().min(1).max(2048),
    name: z.string().min(1).max(128),
    transport: mcpTransportSchema,
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    url: z.string().url().optional(),
    env: mcpStringMapSchema.optional(),
    headers: mcpStringMapSchema.optional(),
    auth: z.object({
      kind: mcpAuthKindSchema,
      secretValues: mcpStringMapSchema.optional(),
    }),
  })
  .superRefine((value, ctx) => {
    // transport === "stdio"  → command required
    // transport !== "stdio"  → url required
  });
export type ImportMcpRequest = z.infer<typeof importMcpRequestSchema>;

export const mcpSummarySchema = z.object({
  id: z.string().min(1),
  identity: z.string().min(1),
  name: z.string().min(1),
  transport: mcpTransportSchema,
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  authKind: mcpAuthKindSchema,
  status: mcpStatusSchema,
  importedAt: z.string(),
  updatedAt: z.string(),
});
export type McpSummary = z.infer<typeof mcpSummarySchema>;
// NOTE: McpSummary deliberately omits env/headers — they can reference secrets.

export const startMcpOAuthResponseSchema = z.object({ authorizationUrl: z.string() });
export const completeMcpOAuthRequestSchema = z.object({ redirectUrl: z.string().url() });

// ---- Skills ----
export const importSkillRequestSchema = z.object({
  identity: z.string().min(1).max(2048),
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  description: z.string().min(1).max(1024),
  source: z.object({
    url: z.string().url(),
    path: z.string().min(1).optional(),
    revision: z.string().min(1).max(256).optional(),
  }).optional(),
  files: z.array(z.object({
    path: z.string().min(1).max(512),
    contentBase64: z.string().max(14 * 1024 * 1024),
  })).min(1).max(500),
});
export type ImportSkillRequest = z.infer<typeof importSkillRequestSchema>;

export const skillSummarySchema = z.object({
  id: z.string().min(1),                       // "skill_" + sha256(identity)[0..24)
  identity: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUrl: z.string().optional(),
  sourcePath: z.string().optional(),
  sourceRevision: z.string().optional(),
  status: z.enum(["ready", "update_available", "error"]),
  importedAt: z.string(),
  updatedAt: z.string(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;

// ---- Session import ----
export const importHarnessSchema = z.enum(["claude", "codex", "pi"]);
export type Harness = z.infer<typeof importHarnessSchema>;

export const sourceFingerprintSchema = z.object({
  harness: importHarnessSchema,
  machineId: z.string().min(1),
  sourcePath: z.string().min(1),
  sourceSessionId: z.string().min(1),
  mtimeMs: z.number().nonnegative(),
  size: z.number().int().nonnegative(),
});
export type SourceFingerprint = z.infer<typeof sourceFingerprintSchema>;

export const importSessionRequestSchema = z.object({
  projectId: z.string().min(1),
  projectRoot: z.string().min(1),
  title: z.string().optional(),
  sourceFingerprint: sourceFingerprintSchema,
  /** pi v3 JSONL, converted client-side. ≤ ~13 MB per session — plain JSON body. */
  piSession: z.string().min(1),
});

export const importSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  seededEvents: z.number().int().nonnegative(),
  /** True when the ledger already had (machineId, harness, sourceSessionId). */
  alreadyImported: z.boolean(),
});

// Mirrors the daemon `imports` ledger table row.
export const importLedgerEntrySchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1).optional(),   // absent for project-only ("files") rows
  projectId: z.string().min(1),
  machineId: z.string().min(1),
  harness: z.enum(["claude", "codex", "pi", "files"]),
  sourcePath: z.string().min(1),
  sourceSessionId: z.string().min(1).optional(),
  sourceMtimeMs: z.number().optional(),
  sourceSize: z.number().int().optional(),
  importedAt: z.string(),
});
export type ImportLedgerEntry = z.infer<typeof importLedgerEntrySchema>;
```

---

## 2. Daemon MCP semantics (`McpService`)

- **Registry**: SQLite table keyed by `identity`; `upsertMcp` means re-importing
  the same identity updates in place (idempotent).
- **Initial status**: `auth.kind === "oauth"` → `"needs_auth"`, otherwise
  `"imported"`. `"connected"` is set only by the OAuth completion path.
  `"imported"` means "persisted, never verified" — MCPs connect lazily on first
  use, the daemon never test-connects at import time.
- **Secrets**: for each `auth.secretValues[key]`:
  - a deterministic env name is derived:
    `AGENA_MCP_` + uppercase(sha256(`${serverName}\0${key}`).hex[0..20))
  - the plaintext is stored in `stateDir/config/mcp-secrets.enc` — AES-256-GCM
    envelope `{ iv, tag, ciphertext }` (base64), file mode `0600`, written
    atomically (tmp + rename). Key file `stateDir/config/mcp-secrets.key` is 32
    random bytes, mode `0600`, created once with `wx` (EEXIST → re-read).
  - every occurrence of the secret in `env`/`headers` (by key name, by literal
    value, or as `${key}` reference) is rewritten to `${AGENA_MCP_…}`. If the
    key appears in neither map, `env[key] = "${AGENA_MCP_…}"` is added.
  - on daemon start, `initialize()` decrypts the file and exports each secret
    into `process.env` so `${…}` references resolve at runtime.
  - **invariant (tested)**: the plaintext secret never appears in `list()`
    output, in `pi/mcp.json`, or in the `.enc` file bytes.
- **pi adapter config**: after every import the full registry is written
  secret-free to `stateDir/pi/mcp.json` as
  `{ mcpServers: { [name]: PiMcpServerEntry } }` where each entry is
  `{ command?, args?, url?, env?, headers?, auth?, oauth?, lifecycle: "lazy" }`;
  `authKind === "oauth"` adds
  `auth: "oauth", oauth: { redirectUri: "http://127.0.0.1:19876/callback" }`;
  `authKind === "none"` adds `auth: false`. `MCP_OAUTH_DIR` env is pointed at
  `stateDir/config/mcp-oauth`.
- **`startOAuth(id)`**: throws `"MCP does not use OAuth"` unless
  `authKind === "oauth" && url`. Calls pi's `startAuth(name, url, entry)`. If pi
  returns no `authorizationUrl` (already has a token cached), the daemon flips
  status straight to `"connected"` and returns an empty/undefined URL.
- **`completeOAuth(id, redirectUrl)`**: hands the full redirect URL (with
  `?code=…&state=…`) to pi's `completeAuthFromInput`, then sets status
  `"connected"`.

## 3. Daemon skill semantics (`SkillService`)

Helpers live in `@agena/importer/skills` and are shared verbatim by the daemon
and the Electron scanner. Copy these rules exactly:

```ts
export type SkillPackageFile = { path: string; contentBase64: string };
export type SkillManifest = { name: string; description: string; version?: string; source?: string };
```

- **`parseSkillManifest(markdown)`**: SKILL.md must start with `---` YAML
  frontmatter. `name`: required, `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, ≤64 chars.
  `description`: required, ≤1024 chars. Supports quoted values and `>`/`|`
  block scalars. Throws on violation.
- **`normalizeSkillFiles(files)`**: 1–500 files; posix-normalizes paths
  (`\` → `/`); rejects empty paths, NUL bytes, `.`/`../…`, absolute paths, and
  duplicates (`invalid skill file path: <p>`); total decoded bytes ≤ 10 MiB
  (`skill package exceeds the 10 MiB limit`); requires a `SKILL.md` entry;
  returns files **sorted by path** (localeCompare).
- **`skillContentHash(files)`**: sha256 over sorted `(path, "\0", rawBytes, "\0")`.
- **`skillIdentity({ contentHash, sourceUrl?, sourcePath? })`**:
  no source → `content:<hash>`; with source →
  `git:<url stripped of creds/hash/trailing-slash/.git>#<normalized path or "">`.

`SkillService.import(input)` validation (all → HTTP 400 with the thrown
message):
1. recompute identity from the package; must equal `input.identity`
   (`"skill identity does not match package"`).
2. manifest `name`/`description` must equal `input.name`/`input.description`.
3. another installed skill with the same `name` but different identity →
   `` `skill name "X" is already installed` ``.

**Install is atomic** (tested): files staged into
`stateDir/skills/.<id>.<uuid>.tmp` (dirs 0700; files 0600 except paths starting
`scripts/` which get 0700), existing target renamed to a backup, stage renamed
into place, registry row upserted; any failure rolls the target back and cleans
the stage — a failed registry write leaves the skills dir empty.
`id = "skill_" + sha256(identity).hex[0..24)`.

**`checkAll()`** (`POST /v1/skills/check-updates`): groups installed skills by
`sourceUrl` (skills without one are skipped and stay as-is), runs
`git ls-remote -- <url> HEAD` once per remote, sets each skill's status to
`"update_available"` if remote HEAD ≠ `sourceRevision`, else `"ready"`;
`git` failure sets the whole group to `"error"`. Returns the full list.

**`update(id)`** (`POST /v1/skills/:id/update`): requires `sourceUrl`
(`"skill has no Git source"`). Shallow-clones (`--depth 1 --no-tags`) to a temp
dir, resolves `sourcePath` inside the checkout with `realpath` and rejects
escapes — including symlink tricks — with `"skill source path escapes checkout"`
(tested). Re-reads the package (skips `.git`, `node_modules`, nested dirs that
contain their own SKILL.md, rejects symlinks, same 500-file/10 MiB caps),
requires the updated manifest name to still match, then does the same atomic
install with the new `contentHash`/`sourceRevision` and status `"ready"`.

## 4. Daemon session-import semantics (`POST /v1/imports/session`)

- Idempotency key = `(machineId, harness, sourceSessionId)` with a DB UNIQUE
  constraint. If a ledger row with a `sessionId` already exists → 200
  `{ sessionId, seededEvents: 0, alreadyImported: true }` without touching
  anything.
- `piSession` must be pi v3 JSONL whose first line is a session header
  (`{ id, timestamp, cwd, … }`) → else 400
  `"piSession must be pi v3 JSONL with a session header"`.
- The raw JSONL is written to
  `stateDir/pi/sessions/--<cwd with leading slash stripped, [/\\:]→"-">--/<timestamp with [:.]→"-">_<headerId>.jsonl`
  (the exact layout pi's SessionManager uses, so resume works).
- A new Agena session is created with `scope: "project"`,
  `source: { kind: "importer" }`, and `origin` `"import.claude"` /
  `"import.codex"` (pi sources get no origin). `projectRoot` must exist under
  `/workspace` → else 400 `"projectRoot must exist under /workspace"`.
- The ledger row is inserted immediately after session creation; losing a
  concurrent-duplicate race archives the extra session and returns the winner's
  `sessionId` with `alreadyImported: true`.
- Events are synthesized from the JSONL (`synthesizeEvents`) and appended;
  response 201 `{ sessionId, seededEvents: events.length, alreadyImported: false }`.
- `GET /v1/imports?machineId=<id>` returns ledger rows (used by the renderer's
  "imported ✓ / N new since import" badges).

---

## 5. Electron-main local scanning

All scanners keep a module-level in-memory cache; `refresh: true` rebuilds it.
The cache maps a **discovery id** to `{ public, request }` where `request` is
the full daemon payload (with secrets) that never crosses to the renderer.
`*ImportRun({ ids })` looks each id up in that cache — if the id is gone (cache
cleared / different scan) the per-item result is
`status: "error", error: "… is no longer in the discovery index"`.

### 5.1 MCP scan (`scanMcps`)

Sources read, in order (missing/invalid files silently skipped):
1. `~/.claude.json` → `mcpServers` and every `projects.<path>.mcpServers`
2. `<cwd>/.mcp.json` → same claude shape
3. `~/.claude/plugins/installed_plugins.json` → for each install's
   `installPath`, `<installPath>/.mcp.json`
4. `~/.codex/config.toml` and `<cwd>/.codex/config.toml` — a minimal TOML
   parser that only reads `[mcp_servers.<name>]` (and one nesting level
   `[mcp_servers.<name>.<child>]`) `key = value` pairs; values parsed as JSON,
   falling back to `'…'`-unquoting, falling back to raw text; `#` comments
   stripped.

Normalization of a raw entry `(name, raw)`:
- must have string `url` or string `command`, else dropped.
- `url` is cleaned: credentials + hash stripped, trailing `/` removed.
- `transport`: url present → `raw.type === "sse" ? "sse" : "http"`; else `"stdio"`.
- `identity`: `remote:<cleanUrl>` or `stdio:<JSON.stringify([command, ...args])>`.
- discovery `id` = sha256(identity).hex[0..20).
- **token-name collection** (what counts as a secret): every `env`/`headers`
  (or codex `http_headers`) entry — a `${VAR}` reference adds `VAR`, a literal
  string value adds its own key; plus codex `env_vars[]`,
  `bearer_token_env_var`, and the values of `env_http_headers`.
- `authKind`: any token names → `"api_key"`; else remote URL that is not
  loopback (localhost/127.0.0.1/::1) → `"oauth"`; else `"none"`.
- `secretValues`: for each token name, the literal value found in env/headers
  (if not itself a `${…}` reference) else `process.env[name]`; unresolvable
  names are omitted.
- `authStatus`: oauth → `"needs_authorization"`; api_key with fewer resolved
  secrets than token names → `"missing_secret"`; else `"ready"`.
- env/headers in the daemon request are **scrubbed**: secret entries become
  `${KEY}` references; codex `env_http_headers` become `${VAR}` header refs;
  `bearer_token_env_var` becomes `Authorization: Bearer ${VAR}`.
- **dedup across sources** by discovery id; a later duplicate replaces an
  earlier one unless the earlier one already had `authStatus === "ready"`
  (keep the entry whose secrets resolved).

### 5.2 Skill scan (`scanSkills`)

Roots (a skill = a directory containing `SKILL.md`; recursion continues into
non-skill subdirs; symlinked dirs skipped):
- `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`
- the same three under every **existing** session-scan project cwd
  (`projectRoots` — the bridge feeds these from `scanImports`)
- Claude plugins: `installed_plugins.json` → `<installPath>/skills/**`
- Codex plugins: `codex plugin list` (30 s timeout) → rows
  `<plugin>@<marketplace>  installed, enabled  …  <localPath>`; roots are the
  local path (if absolute) and `~/.codex/plugins/cache/<marketplace>/<plugin>`;
  inside each root, dirs whose parent dir is named `skills` and that contain
  SKILL.md (depth ≤ 7).

Packaging a directory mirrors the daemon reader: skip `.git`/`node_modules`
and nested skill dirs, skip symlinks, ≤500 files, ≤10 MiB total, single file
≤10 MB. Source attribution: `git rev-parse --show-toplevel` +
`remote.origin.url` + `HEAD` (path = dir relative to repo root); fallback —
walk up ≤10 levels looking for `.codex-plugin/plugin.json`,
`.claude-plugin/plugin.json`, or `.cursor-plugin/plugin.json` and use its
`repository` field (GitHub `/tree/<branch>/<path>` URLs are split into
url + path; `git@host:path` → `https://host/path`). Identity is then
`skillIdentity({ contentHash, sourceUrl?, sourcePath? })`.

Renderer-facing identity is **hashed**:
`publicSkillIdentity(identity) = "skill:" + sha256(identity).hex[0..24)` —
raw identities can contain private repo URLs. The bridge applies the same
hashing to daemon `listSkills` results (and strips
`sourceUrl`/`sourcePath`/`sourceRevision`), so renderer joins compare
`skill:<hash>` on both sides.

Dedup: by `contentHash` (first directory wins), then keyed by discovery
`id = sha256(identity).hex[0..20)`. Malformed/oversized folders are silently
skipped.

### 5.3 Session scan (`scanImports`) — for the Session-import section

- Index cached at `<userData>/import-index.json`; refresh re-parses only files
  whose `(mtimeMs, size)` changed.
- Sources: Claude — `~/.claude/projects/*/` top-level `*.jsonl` only (no
  recursion; excludes `subagents/`); Codex —
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; pi — both
  `~/.pi/agent/sessions` and `~/.pi/sessions`, files matching
  `_<uuid>.jsonl` inside per-cwd dirs or top-level.
- Each file head-parses to `{ cwd, sessionId, title, messageCount }`; cwd-less
  or zero-message files are dropped.
- Grouping → `ProjectGroup[]` by cwd; codex rollouts sharing a thread id merge
  into one session (bytes summed); pi dual-store duplicates counted once.
  `exists` = cwd is still a directory; `codebaseBytes` = sum of git-tracked
  blob sizes via `git ls-tree -r -l HEAD` (**never** an fs walk — hangs on
  iCloud homes); `null` for non-git.
- Real titles: codex `~/.codex/session_index.jsonl` (`id` → `thread_name`);
  claude `~/.claude/history.jsonl` (earliest non-`/` `display` per session,
  first line, ≤80 chars).

### 5.4 Session import run (`runImport(plan)`)

Per selected project, sequentially: `createProject(name)` (failure recorded,
batch continues) → if `copyFiles`, tar the cwd and `uploadFiles` to
`projectRoot` → parse every indexed file matching `(cwd, ticked harness)` →
drop pi dual-store duplicates (keep newer mtime per `sourceSessionId`) → merge
codex threads → convert each to pi JSONL (`convertToPi`, retargeted to the new
project cwd) → `POST /v1/imports/session`, 4-wide concurrency, 3 retries with
linear backoff. Title preference: harness index name → converted title.
Fingerprint `machineId` comes from the desktop app's persistent client id.
Every session result is independent: `{ sourcePath, status: "ok"|"skipped"|"error", sessionId?, error? }`.

### 5.5 MCP OAuth flow (end to end)

1. Renderer calls `bridge.mcpAuthStart(mcpId)` (daemon MCP id, from
   `mcpImportStatus`, NOT the discovery id).
2. Main: `POST /v1/mcps/:id/oauth/start` → `{ authorizationUrl }`; empty URL →
   throw `"daemon did not return an authorization URL"`.
3. Main starts a one-shot HTTP server on `127.0.0.1:19876` (this port is fixed —
   it matches the `redirectUri` the daemon baked into pi's config). A second
   concurrent authorization throws
   `"another MCP authorization is in progress"`.
4. Main opens `authorizationUrl` in the **system browser**
   (`shell.openExternal`).
5. Provider redirects to `http://127.0.0.1:19876/callback?code=…`; main
   forwards the full URL via `POST /v1/mcps/:id/oauth/complete { redirectUrl }`,
   serves a small "Authorization complete" HTML page (or a 400 text page on
   failure), closes the server.
6. `mcpAuthStart` resolves after the browser is opened — completion is
   fire-and-forget (errors only logged). The old UI closed settings and
   toasted "Authorization opened in Agena's browser."; the renderer learns the
   final `connected` status only by re-fetching `mcpImportStatus`.

---

## 6. Bridge surface (renderer ⇄ main), types verbatim

From `apps/desktop/src/shared/bridge.ts` — reuse these shapes exactly:

```ts
export type ImportPlan = {
  projects: Array<{
    cwd: string;
    name: string;
    /** Only honored for new projects whose cwd still exists. */
    copyFiles: boolean;
    /** Empty = project files only. */
    harnesses: Harness[];
  }>;
};

export type ImportRunResult = {
  sessions: Array<{
    sourcePath: string;
    status: "ok" | "skipped" | "error";
    sessionId?: string;
    error?: string;
  }>;
};

export type McpAuthKind = "none" | "oauth" | "api_key" | "unknown";
export type McpAuthStatus = "ready" | "needs_authorization" | "missing_secret";

/** Source-neutral, secret-free view of one locally discovered MCP server. */
export type DiscoveredMcp = {
  id: string;          // discovery id: sha256(identity)[0..20)
  identity: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  target: string;      // url, or "command arg1 arg2" for stdio — display only
  authKind: McpAuthKind;
  authStatus: McpAuthStatus;
};

export type ImportedMcp = {
  id: string;          // daemon MCP id — use for mcpAuthStart
  identity: string;
  name: string;
  status: "imported" | "ready" | "needs_authorization" | "error";
  error?: string;
};

export type McpImportRunResult = {
  mcps: Array<{
    id: string;        // discovery id echoed back
    status: "imported" | "needs_authorization" | "error";
    mcpId?: string;    // daemon id on success
    error?: string;
  }>;
};

export type DiscoveredSkill = {
  id: string;          // discovery id: sha256(rawIdentity)[0..20)
  identity: string;    // "skill:" + sha256(rawIdentity)[0..24) — hashed, join key
  contentHash: string;
  name: string;
  description?: string;
  fileCount: number;
};

export type ImportedSkill = {
  id: string;          // daemon skill id ("skill_…") — use for skillUpdate
  identity: string;    // same hashed "skill:…" form
  contentHash: string;
  name: string;
  status: "ready" | "update_available" | "error";
  error?: string;
};

export type SkillImportRunResult = {
  skills: Array<{
    id: string;        // discovery id echoed back
    status: "imported" | "error";
    skillId?: string;
    error?: string;
  }>;
};

// from @agena/importer:
export type ProjectGroup = {
  cwd: string;
  exists: boolean;
  /** Sum of git-tracked file sizes; null for non-git or deleted cwds. */
  codebaseBytes: number | null;
  byHarness: Record<Harness, { count: number; bytes: number }>;
};
```

Bridge methods:

```ts
importScan(opts?: { refresh?: boolean }): Promise<{ projects: ProjectGroup[]; scannedAt: string }>;
importRun(plan: ImportPlan): Promise<ImportRunResult>;
importStatus(): Promise<{ imports: ImportLedgerEntry[] }>;   // GET /v1/imports?machineId=<clientId>

mcpImportScan(opts?: { refresh?: boolean }): Promise<{ mcps: DiscoveredMcp[]; scannedAt: string }>;
mcpImportRun(plan: { ids: string[] }): Promise<McpImportRunResult>;
mcpImportStatus(): Promise<{ mcps: ImportedMcp[] }>;
mcpAuthStart(mcpId: string): Promise<void>;

skillImportScan(opts?: { refresh?: boolean }): Promise<{ skills: DiscoveredSkill[]; scannedAt: string }>;
skillImportRun(plan: { ids: string[] }): Promise<SkillImportRunResult>;
skillImportStatus(opts?: { refresh?: boolean }): Promise<{ skills: ImportedSkill[] }>;
skillUpdate(skillId: string): Promise<void>;
```

Bridge-side status mapping (daemon → renderer), do not lose this:

| daemon `McpSummary.status` | renderer `ImportedMcp.status` |
|---|---|
| `needs_auth` | `needs_authorization` |
| `connected` | `ready` |
| `error` | `error` |
| `imported` (anything else) | `imported` |

`skillImportStatus({ refresh: true })` calls `POST /v1/skills/check-updates`
(does the git ls-remote pass); without refresh it's a plain `GET /v1/skills`.
`mcpImportRun` maps daemon `needs_auth` → `needs_authorization` per item.

## 7. Renderer join logic (pure, unit-tested — keep behavior identical)

```ts
// discovered × imported join is ALWAYS by `identity` string equality —
// never by name (rename-safe) and never by id (different id spaces).

mcpImportState(mcp, imported): "not_imported" | "imported" | "ready" | "needs_authorization" | "error"
  // no imported row with same identity → "not_imported"; else the row's status.

skillImportState(skill, imported): "not_imported" | "imported" | "update" | "error"
  // no row → "not_imported"; row.status "error" → "error";
  // row.status "update_available" → "update";
  // else contentHash equal → "imported", different → "update"
  //      (local folder changed since import — offer Update too).

importedCounts(cwd, ledgerRows): Partial<Record<harness, number>>
  // A ledger row belongs to `cwd` when row.sourcePath === cwd (harness "files")
  // OR some whole "/"-separated path segment equals one of:
  //   cwd.replace(/[^a-zA-Z0-9]/g, "-")                      // Claude project dir
  //   `--${cwd.replace(/^\//, "").replace(/[/:]/g, "-")}--`  // old pi store dir
  // Segment EQUALITY, never substring: "-Users-dev-app" must not match "-Users-dev-app2".
  // Known gap: codex rollout paths carry no cwd → codex rows don't attribute.

shortenHome("/Users|/home/<name>/…") → "~/…"
humanBytes(null) → "—"; 512 → "512 B"; 72_704 → "71 KB"; 48_234_496 → "46 MB"
  // (v ≥ 10 → rounded, else one decimal)
```

Derived badge: `fresh = Σ max(0, scannedCount[h] − importedCount[h])`;
`0` → "imported ✓" (ok tone) else "N new since import" (warn tone).

---

## 8. Old settings-modal UX (what it did) + IMPROVE-ON notes

The old UI is one `⌘,` modal (`h-[540px]`, `max-h-[85vh]`, size lg) with a
narrow left nav of three sections: **Session import**, **MCP import**,
**Skill import**. Each section is the same skeleton: header (title + one-line
hint + Refresh button) / scrollable bordered list / transient results strip /
footer with the primary "Import selected (N)" button.

Behavior worth keeping:
- Every section loads on mount with `Promise.all([scan, status])`; Refresh
  passes `refresh: true`. Spinner only when the list is still null; errors
  render inline in the list area; run failures toast.
- **Sessions**: checklist tree — project row (checkbox, chevron-expandable,
  mono `~/`-shortened cwd, struck-through when the cwd no longer exists,
  per-harness counts, `proj <bytes> · sess <bytes>`, imported badge) expanding
  to per-harness checkboxes ("Claude Code (3 sessions, 1.2 MB)"). Ticking a
  project pre-ticks all harnesses that have sessions. Two actions: "Import
  project only" (files, no sessions — sends `harnesses: []`) and "Import
  selected". `copyFiles` is auto-derived: cwd exists AND is a git repo. A
  banner + disabled buttons appear when the connected daemon 404s on
  `/v1/imports` ("Connected daemon doesn't support imports yet…"). After a run,
  selection clears, the list reloads, and a per-source result list
  (ok/skipped/error badges + error text) shows.
- **MCPs**: flat checkbox list; name + mono target; transport badge; state
  badges: "not imported", "imported · not verified", "ready · connects on use",
  "missing API key" (warn, checkbox disabled — nothing to send), error badge;
  an **Authorize** button appears when the imported row is
  `needs_authorization`, which calls `mcpAuthStart(importedRow.id)`, closes the
  modal, and toasts. Already-imported rows have disabled checkboxes.
- **Skills**: flat checkbox list; name + description (falls back to
  "N files"); file count; badges "imported ✓" / "not imported" / error; an
  **Update** button when state is "update" and a daemon row exists (calls
  `skillUpdate(row.id)` then reloads), else a warn "update available" badge.

IMPROVE-ON for the redesign (the old one crams everything into one modal):
1. **Make Settings a full surface, not a 540px modal.** Three data-heavy
   catalog views are squeezed into a fixed box with nested scrollbars; a
   routed settings page (or at least a near-full-height sheet) with room for
   detail panes fixes most of the rest.
2. **OAuth completion is invisible.** Old flow: click Authorize → modal closes
   → toast → user must reopen settings and hit Refresh to see "ready". Keep
   the view open, show a per-row "waiting for browser…" state, and poll
   `mcpImportStatus` (or push over the event stream) until the row flips.
3. **Errors are second-class.** Run results are a transient strip that
   disappears on the next action, and MCP/skill result lines don't even name
   the item (they print status/error only, keyed by opaque id). Attach
   results to the row they belong to and keep the last outcome visible.
4. **No detail view.** You can't see an MCP's command/args/url/env-key names
   or a skill's file list/source repo before importing. Add a row →
   inspector pane (still secret-free: names of env keys, never values).
5. **`missing_secret` is a dead end.** The old UI just disables the checkbox.
   Offer an inline "paste API key" field — `ImportMcpRequest.auth.secretValues`
   already supports supplying the value at import time.
6. **Session tree conflates selection and expansion**; project checkbox is
   tri-state in spirit (some harnesses ticked) but renders binary. Use a real
   indeterminate checkbox, and surface `copyFiles` as a visible (pre-checked)
   option instead of silently deriving it.
7. **Refresh semantics differ per section** (skills refresh also triggers the
   daemon update-check and can be slow on many remotes; MCP refresh is
   instant). Split "Rescan this machine" from "Check for updates" so users
   aren't surprised, and show per-remote progress.
8. **Empty states could act**: "No local MCP servers found" should say where
   it looked (~/.claude.json, .mcp.json, codex config) and offer a manual-add
   form later.
9. Keep all pure helpers (`mcpImportState`, `skillImportState`,
   `importedCounts`, `shortenHome`, `humanBytes`) exported and unit-tested —
   the encoding-match rules in `importedCounts` are subtle and regression-prone.

## 9. Error-case checklist (what the UI must tolerate)

- Daemon without SQLite → 501 `NOT_SUPPORTED` on all MCP/skill routes.
- Daemon predating `/v1/imports` → 404; sessions section stays browsable with
  importing disabled (`importStatus()` rejection ⇒ `daemonSupport = false`).
- `mcpImportRun`/`skillImportRun` after a fresh scan invalidated the cache →
  per-item "… is no longer in the discovery index".
- Skill import 400s: identity mismatch, name/description mismatch with
  SKILL.md, name collision, invalid file path, >10 MiB, missing SKILL.md.
- Skill update 400s (`SKILL_UPDATE_FAILED`, retryable): no Git source, clone
  failure, source path escapes checkout, renamed skill.
- OAuth: `oauth/start` on a non-OAuth or url-less MCP → 400
  `MCP_AUTH_FAILED "MCP does not use OAuth"`; unknown id → 404; concurrent
  authorize → bridge throws "another MCP authorization is in progress".
- Session import: non-pi-v3 payload, `projectRoot` outside `/workspace`,
  duplicate fingerprint (→ success with `alreadyImported: true`, not an error).
