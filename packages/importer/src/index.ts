// @agena/importer — local-session import (docs/settings_import_plan.md §4-§7).
// Parsers/converters are pure (string in, string out) so the Electron main scanner,
// the daemon's event seeding, and unit tests all consume the same functions.
// Converter core vendored from agent-session-bridge (MIT) with the plan §2 fixes:
// zero-message sources return null, cwd is never realpath'd, and Codex bootstrap
// preambles are stripped per text block even when mixed with real user text.
import { createHash } from "node:crypto";
import type {
  ContentBlock,
  DurableEventType,
  EventSource,
  Harness,
  ModelRef,
  SourceFingerprint,
} from "@agena/protocol";

export type { Harness, SourceFingerprint } from "@agena/protocol";

// ---- scan shapes (plan §4) --------------------------------------------------

export type ScanIndex = {
  scannedAt: string;
  /** Keyed by absolute source file path. */
  files: Record<
    string,
    {
      mtimeMs: number;
      size: number;
      harness: Harness;
      cwd: string;
      sessionId: string;
      title: string;
      messageCount: number;
    }
  >;
};

export type ProjectGroup = {
  cwd: string;
  exists: boolean;
  /** Sum of git-tracked file sizes; null for non-git or deleted cwds. */
  codebaseBytes: number | null;
  byHarness: Record<Harness, { count: number; bytes: number }>;
};

// ---- normalized source model (parser → converter) ---------------------------
// Maps 1:1 onto the §7 event-synthesis table; bootstrap preambles are already
// stripped by the parsers.

/**
 * Cache-aware token counts. Claude reports most context via cacheReadTokens —
 * dropping it made pi's compaction threshold see ~0 context on huge imports
 * and 400 the resume instead of auto-compacting.
 */
export type UsageCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type SourceEntry =
  | {
      kind: "message";
      role: "user" | "assistant" | "toolResult";
      content: ContentBlock[];
      timestamp?: string;
      /** role === "toolResult" only. */
      toolCallId?: string;
      isError?: boolean;
      /** role === "assistant" only, when the source recorded them. */
      model?: ModelRef;
      usage?: UsageCounts;
    }
  | { kind: "modelChange"; to: ModelRef; from?: ModelRef; timestamp?: string }
  | {
      kind: "thinkingLevelChange";
      from: string;
      to: string;
      timestamp?: string;
    };

export type SourceSession = {
  harness: Harness;
  /** For merged codex threads: the earliest rollout file. */
  sourcePath: string;
  sourceSessionId: string;
  /** Opaque string — never realpath'd (plan §2 fix 3). */
  cwd: string;
  /** ISO time of the source header / first entry. */
  timestamp: string;
  entries: SourceEntry[];
  /** Unknown/unmappable source entries dropped by the parser. */
  skippedEntries: number;
  mtimeMs: number;
  size: number;
  /** pi sources only: original JSONL, so convertToPi is a cwd rewrite (plan §5). */
  piJsonl?: string;
};

export type ConvertedSession = {
  /** pi session header id. */
  sessionId: string;
  title: string;
  /** The rewritten container cwd (opts.targetCwd). */
  cwd: string;
  /** pi v3 JSONL — the importSessionRequest.piSession body, verbatim. */
  jsonl: string;
  messageCount: number;
  /** machineId is desktop-known; the caller adds it before POSTing. */
  sourceFingerprint: Omit<SourceFingerprint, "machineId">;
};

// ---- shared helpers ----------------------------------------------------------

const EPOCH = new Date(0).toISOString();

function parseJsonLines(content: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // truncated/corrupt line — never fatal (plan §11)
    }
  }
  return out;
}

function hashHex(seed: string, length: number): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, length);
}

/** Deterministic uuid-shaped id (pi header ids are uuids). */
function deriveUuid(seed: string): string {
  const h = hashHex(seed, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

// User messages that are harness artifacts, not something the user typed —
// useless as titles (plan follow-up: real names come from the harness indexes).
const TITLE_SKIP_PREFIXES = [
  "<local-command-caveat>",
  "<command-name>",
  "Caveat: The messages below",
  "[Image #",
];

export function titleFromEntries(entries: SourceEntry[]): string {
  for (const entry of entries) {
    if (entry.kind !== "message" || entry.role !== "user") continue;
    const text = textOf(entry.content).trim();
    if (!text) continue;
    if (TITLE_SKIP_PREFIXES.some((p) => text.startsWith(p))) continue;
    return (text.split("\n", 1)[0] ?? "").trim().slice(0, 80);
  }
  return "";
}

/** Loose content → protocol ContentBlock[]. Unrepresentable blocks (images, files) are dropped. */
function normalizeContentList(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      if (item) out.push({ type: "text", text: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const type = c.type;
    if (
      (type === "text" || type === "input_text" || type === "output_text") &&
      typeof c.text === "string"
    ) {
      if (c.text) out.push({ type: "text", text: c.text });
    } else if (type === "thinking" && typeof c.thinking === "string") {
      out.push({ type: "thinking", text: c.thinking });
    } else if (type === "reasoning" && typeof c.text === "string") {
      out.push({ type: "thinking", text: c.text });
    } else if (
      (type === "toolCall" || type === "tool_use") &&
      typeof c.id === "string" &&
      typeof c.name === "string" &&
      c.name !== ""
    ) {
      out.push({
        type: "toolCall",
        // "" fails toolCallBlockSchema's min(1); derive a stable fallback
        toolCallId: c.id || hashHex(JSON.stringify(c), 12),
        name: c.name,
        args: (type === "toolCall" ? c.arguments : c.input) ?? {},
      });
    }
    // image/tool_result and unknown block types: handled by callers or dropped
  }
  return out;
}

/** tool_result content (string | block list) → plain text blocks. */
function toolOutputBlocks(output: unknown): ContentBlock[] {
  if (typeof output === "string") {
    return [{ type: "text", text: output }];
  }
  const blocks = normalizeContentList(output);
  if (blocks.length > 0) return blocks;
  const serialized = JSON.stringify(output ?? "");
  return [
    { type: "text", text: typeof serialized === "string" ? serialized : "" },
  ];
}

// ---- parsers (plan §4 table) -------------------------------------------------
// Each takes raw file content plus its absolute path (for fingerprint/id fallback)
// and returns null for empty/header-only/unusable sources.
// mtimeMs is unknowable from content — parsers set 0; the scanner overwrites it
// from fs.stat before fingerprinting.

export function messageCountOf(entries: SourceEntry[]): number {
  return entries.filter(
    (e) =>
      e.kind === "message" && (e.role === "user" || e.role === "assistant"),
  ).length;
}

/**
 * One `~/.claude/projects/<slug>/<uuid>.jsonl` file. Callers must exclude
 * files under any `subagents/` directory (journal noise, plan §2 fix 2) —
 * this function only sees top-level session files. Sidechain (embedded
 * subagent) and meta lines are skipped.
 */
export function parseClaudeSession(
  content: string,
  sourcePath: string,
): SourceSession | null {
  const lines = parseJsonLines(content);
  if (lines.length === 0) return null;

  let cwd: string | undefined;
  let sessionId: string | undefined;
  let timestamp: string | undefined;
  const entries: SourceEntry[] = [];
  let skipped = 0;
  // Claude Code splits one assistant API turn across multiple JSONL lines (one
  // per content block, same message.id). They must merge back into ONE message
  // or tool_use/tool_result pairing breaks on resume (Anthropic requires each
  // tool_result's tool_use in the immediately preceding message).
  let lastAssistantApiId: string | undefined;

  for (const line of lines) {
    cwd ??= asString(line.cwd);
    sessionId ??= asString(line.sessionId);
    timestamp ??= asString(line.timestamp);

    if (line.type !== "user" && line.type !== "assistant") {
      skipped += 1;
      continue;
    }
    if (line.isSidechain === true || line.isMeta === true) {
      skipped += 1;
      continue;
    }
    const message = line.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") {
      skipped += 1;
      continue;
    }
    const ts = asString(line.timestamp);
    const tsProp = ts ? { timestamp: ts } : {};

    if (line.type === "assistant") {
      const blocks = normalizeContentList(message.content);
      if (blocks.length === 0) {
        skipped += 1;
        continue;
      }
      const usage = message.usage as Record<string, unknown> | undefined;
      const usageProp = usage
        ? {
            usage: {
              inputTokens: asNumber(usage.input_tokens),
              outputTokens: asNumber(usage.output_tokens),
              cacheReadTokens: asNumber(usage.cache_read_input_tokens),
              cacheWriteTokens: asNumber(usage.cache_creation_input_tokens),
            },
          }
        : {};
      const apiId = asString(message.id);
      const last = entries.at(-1);
      if (
        apiId &&
        apiId === lastAssistantApiId &&
        last?.kind === "message" &&
        last.role === "assistant"
      ) {
        last.content.push(...blocks);
        Object.assign(last, usageProp); // per-line usage repeats; keep latest
      } else {
        entries.push({
          kind: "message",
          role: "assistant",
          content: blocks,
          model: {
            provider: "anthropic",
            id: asString(message.model) || "claude",
          },
          ...usageProp,
          ...tsProp,
        });
      }
      lastAssistantApiId = apiId;
      continue;
    }
    lastAssistantApiId = undefined;

    // user line: tool_result blocks become toolResult entries (pi's native shape),
    // remaining blocks a plain user message.
    const raw = Array.isArray(message.content)
      ? message.content
      : [message.content];
    const rest: unknown[] = [];
    for (const item of raw) {
      const c = item as Record<string, unknown> | null;
      if (c && typeof c === "object" && c.type === "tool_result") {
        entries.push({
          kind: "message",
          role: "toolResult",
          toolCallId: asString(c.tool_use_id) ?? "",
          isError: c.is_error === true,
          content: toolOutputBlocks(c.content),
          ...tsProp,
        });
      } else {
        rest.push(item);
      }
    }
    const blocks = normalizeContentList(cleanUserTextItems(rest));
    if (blocks.length > 0) {
      entries.push({
        kind: "message",
        role: "user",
        content: blocks,
        ...tsProp,
      });
    }
  }

  if (messageCountOf(entries) === 0) return null; // plan §2 fix 1

  return {
    harness: "claude",
    sourcePath,
    sourceSessionId: sessionId || hashHex(sourcePath, 16),
    cwd: cwd ?? "",
    timestamp: timestamp ?? EPOCH,
    entries,
    skippedEntries: skipped,
    mtimeMs: 0,
    size: Buffer.byteLength(content),
  };
}

// Codex bootstrap preambles (plan §2 fix 4): dropped per text block, so a user
// message mixing bootstrap with real text keeps the real text.
const CODEX_BOOTSTRAP_PREFIXES = [
  "<permissions instructions>",
  "<app-context>",
  "<collaboration_mode>",
  "<apps_instructions>",
  "<skills_instructions>",
  "<plugins_instructions>",
  "# AGENTS.md instructions", // seen both with and without a trailing " for <path>"
  "# Files mentioned by the user",
  "<environment_context>",
  "<turn_aborted>",
  "<user_instructions>",
  // memory-folder preamble (newer Codex builds, seen with both heading depths);
  // matched on the full sentence, not the "# Memory" heading, so a user message
  // that starts with that heading survives.
  "# Memory\n\nYou have access to a memory folder",
  "## Memory\n\nYou have access to a memory folder",
  "When you write or edit a git commit message, ensure the message ends with this trailer exactly once:",
];

function unwrapStructuredText(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.type === "input_text" || parsed.type === "output_text") &&
      typeof parsed.text === "string"
    ) {
      return parsed.text;
    }
  } catch {
    // plain text
  }
  return text;
}

function isCodexBootstrapText(text: string): boolean {
  const normalized = unwrapStructuredText(text).trimStart();
  return CODEX_BOOTSTRAP_PREFIXES.some((p) => normalized.startsWith(p));
}

// Shape-based scaffolding classifier — complements the prefix list above, which
// rots as harnesses rename their injections. Harness envelope tags contain _ or
// - (user_instructions, environment_context, command-name, system-reminder, …);
// HTML/code a user pastes essentially never wraps an ENTIRE block in such a tag,
// so plain <div>…</div> content survives.
const LEADING_ENVELOPE_RE = /^<([a-zA-Z][\w-]*)>[\s\S]*?<\/\1>\s*/;

/**
 * Strip harness-injected envelopes (leading, possibly several in a row — e.g.
 * Claude's <command-name>/<command-message>/<command-args> triple) and
 * <system-reminder> spans anywhere. Returns "" for pure scaffolding.
 */
export function stripScaffolding(text: string): string {
  let out = text.trimStart();
  for (;;) {
    const m = LEADING_ENVELOPE_RE.exec(out);
    if (!m?.[1] || !/[_-]/.test(m[1])) break;
    out = out.slice(m[0].length).trimStart();
  }
  return out
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

// Claude injections that aren't tag-wrapped: skill bodies pasted as user text.
const CLAUDE_SCAFFOLD_PREFIXES = ["Base directory for this skill:"];

/** Text blocks → scaffolding-stripped text blocks; non-text passes through. */
function cleanUserTextItems(items: unknown[]): unknown[] {
  return items.flatMap((item) => {
    const c = item as Record<string, unknown> | null;
    const raw =
      typeof item === "string"
        ? item
        : c && typeof c === "object" && typeof c.text === "string"
          ? c.text
          : undefined;
    if (raw === undefined) return [item];
    const text = stripScaffolding(unwrapStructuredText(raw));
    if (!text || CLAUDE_SCAFFOLD_PREFIXES.some((p) => text.startsWith(p))) {
      return [];
    }
    return [{ type: "text", text }];
  });
}

/** One rollout file. Files sharing a thread id merge via groupCodexThreads. */
export function parseCodexRollout(
  content: string,
  sourcePath: string,
): SourceSession | null {
  const lines = parseJsonLines(content);
  if (lines.length === 0) return null;

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let timestamp: string | undefined;
  let currentModel = "gpt-5";
  const entries: SourceEntry[] = [];
  let skipped = 0;

  for (const line of lines) {
    const payload = line.payload as Record<string, unknown> | undefined;
    if (line.type === "session_meta" && payload) {
      sessionId ??= asString(payload.id);
      cwd ??= asString(payload.cwd);
      timestamp ??= asString(payload.timestamp) ?? asString(line.timestamp);
      continue;
    }
    if (line.type === "turn_context" && payload) {
      currentModel = asString(payload.model) || currentModel;
      continue;
    }
    if (line.type !== "response_item" || !payload) {
      skipped += 1;
      continue;
    }
    const ts = asString(line.timestamp);
    const tsProp = ts ? { timestamp: ts } : {};

    if (payload.type === "message") {
      // developer-role messages are pure harness scaffolding: system prompt,
      // permissions, the skills catalog, collaboration mode. Never user-typed.
      if (payload.role === "developer") {
        skipped += 1;
        continue;
      }
      const role = payload.role === "assistant" ? "assistant" : "user";
      let raw = Array.isArray(payload.content)
        ? payload.content
        : [payload.content];
      if (role === "user") {
        raw = cleanUserTextItems(
          raw.filter((item) => {
            const c = item as Record<string, unknown> | null;
            const text =
              c && typeof c === "object" ? asString(c.text) : asString(item);
            return !(text !== undefined && isCodexBootstrapText(text));
          }),
        );
      }
      const blocks = normalizeContentList(raw);
      if (blocks.length === 0) {
        skipped += 1;
        continue;
      }
      entries.push({
        kind: "message",
        role,
        content: blocks,
        ...(role === "assistant"
          ? { model: { provider: "openai", id: currentModel } }
          : {}),
        ...tsProp,
      });
      continue;
    }
    if (payload.type === "function_call" && typeof payload.name === "string") {
      let args: unknown = payload.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = { raw: args };
        }
      }
      entries.push({
        kind: "message",
        role: "assistant",
        content: [
          {
            type: "toolCall",
            toolCallId:
              asString(payload.call_id) || hashHex(JSON.stringify(payload), 12),
            name: payload.name,
            args,
          },
        ],
        model: { provider: "openai", id: currentModel },
        ...tsProp,
      });
      continue;
    }
    if (payload.type === "function_call_output") {
      entries.push({
        kind: "message",
        role: "toolResult",
        toolCallId: asString(payload.call_id) ?? "",
        content: toolOutputBlocks(payload.output),
        ...tsProp,
      });
      continue;
    }
    skipped += 1; // reasoning (encrypted), web_search_call, …
  }

  if (messageCountOf(entries) === 0) return null; // plan §2 fix 1

  return {
    harness: "codex",
    sourcePath,
    sourceSessionId: sessionId || hashHex(sourcePath, 16),
    cwd: cwd ?? "",
    timestamp: timestamp ?? EPOCH,
    entries: coalesceAssistantRuns(entries),
    skippedEntries: skipped,
    mtimeMs: 0,
    size: Buffer.byteLength(content),
  };
}

/**
 * Codex emits assistant text and each function_call as separate rollout items.
 * One API turn must be ONE message: with parallel calls left split, a
 * tool_result no longer follows the message holding its tool_use and the
 * Anthropic API rejects the whole context on resume (same bug as Claude's
 * per-block lines, fixed there via api message.id merge).
 */
function coalesceAssistantRuns(entries: SourceEntry[]): SourceEntry[] {
  const out: SourceEntry[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    if (
      entry.kind === "message" &&
      entry.role === "assistant" &&
      last?.kind === "message" &&
      last.role === "assistant"
    ) {
      last.content.push(...entry.content);
      if (entry.usage) last.usage = entry.usage;
    } else {
      out.push(entry);
    }
  }
  return out;
}

type PiLine = Record<string, unknown>;

/** Active-branch walk: leaf = last entry with an id, follow parentId to root. */
function piActiveBranch(entries: PiLine[]): PiLine[] {
  const byId = new Map<string, PiLine>();
  let leaf: PiLine | undefined;
  for (const entry of entries) {
    const id = asString(entry.id);
    if (id) {
      byId.set(id, entry);
      leaf = entry;
    }
  }
  if (!leaf) return entries;
  const branch: PiLine[] = [];
  let current: PiLine | undefined = leaf;
  while (current) {
    branch.push(current);
    const parentId = asString(current.parentId);
    current = parentId ? byId.get(parentId) : undefined;
  }
  return branch.reverse();
}

export function parsePiSession(
  content: string,
  sourcePath: string,
): SourceSession | null {
  const lines = parseJsonLines(content);
  const header = lines[0];
  if (
    header?.type !== "session" ||
    typeof header.id !== "string" ||
    header.id === ""
  ) {
    return null;
  }

  const entries: SourceEntry[] = [];
  let skipped = 0;
  let thinkingLevel = "off";
  for (const entry of piActiveBranch(lines.slice(1))) {
    const ts = asString(entry.timestamp);
    const tsProp = ts ? { timestamp: ts } : {};
    if (
      entry.type === "message" &&
      entry.message &&
      typeof entry.message === "object"
    ) {
      const message = entry.message as Record<string, unknown>;
      const role = message.role;
      if (role === "toolResult") {
        entries.push({
          kind: "message",
          role: "toolResult",
          toolCallId: asString(message.toolCallId) ?? "",
          isError: message.isError === true,
          content: toolOutputBlocks(message.content),
          ...tsProp,
        });
      } else if (role === "user" || role === "assistant") {
        const blocks = normalizeContentList(message.content);
        if (blocks.length === 0) {
          skipped += 1;
          continue;
        }
        const usage = message.usage as Record<string, unknown> | undefined;
        entries.push({
          kind: "message",
          role,
          content: blocks,
          ...(role === "assistant"
            ? {
                model: {
                  provider: asString(message.provider) || "unknown",
                  id: asString(message.model) || "unknown",
                },
                ...(usage
                  ? {
                      usage: {
                        inputTokens: asNumber(usage.input),
                        outputTokens: asNumber(usage.output),
                        cacheReadTokens: asNumber(usage.cacheRead),
                        cacheWriteTokens: asNumber(usage.cacheWrite),
                      },
                    }
                  : {}),
              }
            : {}),
          ...tsProp,
        });
      } else {
        skipped += 1;
      }
    } else if (entry.type === "model_change") {
      entries.push({
        kind: "modelChange",
        to: {
          provider: asString(entry.provider) || "unknown",
          id: asString(entry.modelId) || "unknown",
        },
        ...tsProp,
      });
    } else if (entry.type === "thinking_level_change") {
      const to = asString(entry.thinkingLevel) || "off";
      entries.push({
        kind: "thinkingLevelChange",
        from: thinkingLevel,
        to,
        ...tsProp,
      });
      thinkingLevel = to;
    } else {
      skipped += 1;
    }
  }

  if (messageCountOf(entries) === 0) return null; // plan §2 fix 1

  return {
    harness: "pi",
    sourcePath,
    sourceSessionId: header.id,
    cwd: asString(header.cwd) ?? "",
    timestamp: asString(header.timestamp) ?? EPOCH,
    entries,
    skippedEntries: skipped,
    mtimeMs: 0,
    size: Buffer.byteLength(content),
    piJsonl: content,
  };
}

/**
 * Merge codex rollouts sharing a sourceSessionId (thread id) into one session,
 * entries ordered by timestamp; other sessions pass through (plan §5).
 */
export function groupCodexThreads(rollouts: SourceSession[]): SourceSession[] {
  const out: SourceSession[] = [];
  const threads = new Map<string, SourceSession[]>();
  for (const session of rollouts) {
    if (session.harness !== "codex") {
      out.push(session);
      continue;
    }
    const group = threads.get(session.sourceSessionId);
    if (group) group.push(session);
    else threads.set(session.sourceSessionId, [session]);
  }
  for (const group of threads.values()) {
    if (group.length === 1) {
      out.push(group[0] as SourceSession);
      continue;
    }
    group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const first = group[0] as SourceSession;
    out.push({
      ...first,
      // re-coalesce: a turn split across rollout files re-splits on concat
      entries: coalesceAssistantRuns(group.flatMap((s) => s.entries)),
      skippedEntries: group.reduce((n, s) => n + s.skippedEntries, 0),
      mtimeMs: Math.max(...group.map((s) => s.mtimeMs)),
      size: group.reduce((n, s) => n + s.size, 0),
    });
  }
  return out;
}

// ---- converter (plan §5) ------------------------------------------------------

/**
 * pi's pre-prompt auto-compaction needs at least one assistant message with
 * non-zero usage — estimateContextTokens bails when none exists, so a huge
 * usage-less import (codex records no usage) 400s at the provider instead of
 * compacting. Patch the LAST assistant entry with pi's own chars/4 heuristic
 * when real usage is absent; real usage (claude, pi) is never touched.
 */
function ensureContextUsage(entries: SourceEntry[]): void {
  let lastAssistant: Extract<SourceEntry, { kind: "message" }> | undefined;
  let chars = 0;
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    for (const block of entry.content) {
      if (block.type === "text" || block.type === "thinking") {
        chars += block.text.length;
      } else if (block.type === "toolCall") {
        chars += block.name.length + JSON.stringify(block.args ?? {}).length;
      }
    }
    if (entry.role === "assistant") lastAssistant = entry;
  }
  if (!lastAssistant) return;
  const u = lastAssistant.usage;
  const total =
    (u?.inputTokens ?? 0) +
    (u?.outputTokens ?? 0) +
    (u?.cacheReadTokens ?? 0) +
    (u?.cacheWriteTokens ?? 0);
  if (total > 0) return;
  lastAssistant.usage = {
    inputTokens: Math.ceil(chars / 4),
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function toPiContent(blocks: ContentBlock[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (block.type === "text") out.push({ type: "text", text: block.text });
    else if (block.type === "thinking")
      out.push({ type: "thinking", thinking: block.text });
    else if (block.type === "toolCall")
      out.push({
        type: "toolCall",
        id: block.toolCallId,
        name: block.name,
        arguments: block.args ?? {},
      });
    // image/file blocks are blob refs the container can't resolve — dropped
  }
  return out;
}

function fingerprintOf(
  source: SourceSession,
): Omit<SourceFingerprint, "machineId"> {
  return {
    harness: source.harness,
    sourcePath: source.sourcePath,
    sourceSessionId: source.sourceSessionId,
    mtimeMs: source.mtimeMs,
    size: source.size,
  };
}

/**
 * Normalized source → pi v3 JSONL with header cwd = opts.targetCwd
 * (`/workspace/<slug>`). pi sources are re-emitted with only the cwd rewritten.
 * Returns null when the source has zero convertible messages (plan §2 fix 1).
 */
export function convertToPi(
  source: SourceSession,
  opts: { targetCwd: string },
): ConvertedSession | null {
  const messageCount = messageCountOf(source.entries);
  if (messageCount === 0) return null;

  if (source.harness === "pi" && source.piJsonl !== undefined) {
    // pi → pi: rewrite the header cwd, keep every entry line verbatim.
    const lines = source.piJsonl.split(/\r?\n/u).filter((l) => l.trim());
    const header = JSON.parse(lines[0] as string) as Record<string, unknown>;
    header.cwd = opts.targetCwd;
    lines[0] = JSON.stringify(header);
    let title = "";
    for (const line of lines.slice(1)) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "session_info" && typeof entry.name === "string") {
          title = entry.name.slice(0, 80);
          break;
        }
      } catch {
        // keep scanning
      }
    }
    return {
      sessionId: source.sourceSessionId,
      title: title || titleFromEntries(source.entries),
      cwd: opts.targetCwd,
      jsonl: `${lines.join("\n")}\n`,
      messageCount,
      sourceFingerprint: fingerprintOf(source),
    };
  }

  const sessionId = deriveUuid(`${source.harness}:${source.sourceSessionId}`);
  ensureContextUsage(source.entries);
  const piLines: string[] = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: source.timestamp,
      cwd: opts.targetCwd,
    }),
  ];
  let parentId: string | null = null;
  let index = 0;
  for (const entry of source.entries) {
    const id = hashHex(`${sessionId}:${index}`, 8);
    const timestamp = entry.timestamp ?? source.timestamp;
    let line: Record<string, unknown>;
    if (entry.kind === "modelChange") {
      line = {
        type: "model_change",
        id,
        parentId,
        timestamp,
        provider: entry.to.provider,
        modelId: entry.to.id,
      };
    } else if (entry.kind === "thinkingLevelChange") {
      line = {
        type: "thinking_level_change",
        id,
        parentId,
        timestamp,
        thinkingLevel: entry.to,
      };
    } else if (entry.role === "toolResult") {
      line = {
        type: "message",
        id,
        parentId,
        timestamp,
        message: {
          role: "toolResult",
          toolCallId: entry.toolCallId ?? "",
          content: toPiContent(entry.content),
          isError: entry.isError === true,
        },
      };
    } else {
      const content = toPiContent(entry.content);
      if (content.length === 0) continue;
      const u = entry.usage;
      const input = u?.inputTokens ?? 0;
      const output = u?.outputTokens ?? 0;
      const cacheRead = u?.cacheReadTokens ?? 0;
      const cacheWrite = u?.cacheWriteTokens ?? 0;
      line = {
        type: "message",
        id,
        parentId,
        timestamp,
        message: {
          role: entry.role,
          content,
          ...(entry.model
            ? { provider: entry.model.provider, model: entry.model.id }
            : {}),
          // pi requires the full usage/stopReason shape on assistant messages —
          // its context accounting reads usage.totalTokens unguarded on resume,
          // and its pre-prompt auto-compaction threshold trusts these numbers.
          ...(entry.role === "assistant"
            ? {
                stopReason: content.some((c) => c.type === "toolCall")
                  ? "toolUse"
                  : "stop",
                usage: {
                  input,
                  output,
                  cacheRead,
                  cacheWrite,
                  totalTokens: input + output + cacheRead + cacheWrite,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
              }
            : {}),
        },
      };
    }
    piLines.push(JSON.stringify(line));
    parentId = id;
    index += 1;
  }

  return {
    sessionId,
    title: titleFromEntries(source.entries),
    cwd: opts.targetCwd,
    jsonl: `${piLines.join("\n")}\n`,
    messageCount,
    sourceFingerprint: fingerprintOf(source),
  };
}

// ---- event synthesis (plan §7, daemon-side) -----------------------------------

/**
 * Structurally assignable to @agena/core NewEvent; payload conforms to
 * durableEventSchemas[type]. source is always { kind: "importer" }.
 */
export type SynthesizedEvent = {
  type: DurableEventType;
  v: 1;
  source: EventSource;
  payload: unknown;
};

const IMPORTER: EventSource = { kind: "importer" };

function event(type: DurableEventType, payload: unknown): SynthesizedEvent {
  return { type, v: 1, source: IMPORTER, payload };
}

/**
 * Walk the pi session's main branch (root → leaf) and map entries per the §7
 * table. Excludes session.created (store.createSession emits it); includes
 * session.title.changed when a title exists. seq/createdAt are assigned by
 * appendEvents. Unknown entries are skipped, never fatal.
 */
export function synthesizeEvents(
  piJsonl: string,
  sessionMeta: { title?: string },
): SynthesizedEvent[] {
  const lines = parseJsonLines(piJsonl);
  const header = lines[0];
  if (header?.type !== "session") return [];

  const events: SynthesizedEvent[] = [];
  const title = sessionMeta.title?.trim().slice(0, 80);
  if (title) events.push(event("session.title.changed", { title }));

  let thinkingLevel = "off";
  let index = 0;
  for (const entry of piActiveBranch(lines.slice(1))) {
    index += 1;
    const entryId = asString(entry.id) || hashHex(`entry:${index}`, 8);

    if (entry.type === "model_change") {
      events.push(
        event("model.changed", {
          to: {
            provider: asString(entry.provider) || "unknown",
            id: asString(entry.modelId) || "unknown",
          },
          reason: "user_selected",
        }),
      );
      continue;
    }
    if (entry.type === "thinking_level_change") {
      const to = asString(entry.thinkingLevel) || "off";
      events.push(event("thinking.level.changed", { from: thinkingLevel, to }));
      thinkingLevel = to;
      continue;
    }
    if (
      entry.type !== "message" ||
      !entry.message ||
      typeof entry.message !== "object"
    ) {
      continue; // ponytail: unknown pi entry types stay in the JSONL (runtime context), just not projected
    }
    const message = entry.message as Record<string, unknown>;
    const role = message.role;

    if (role === "user") {
      const content = normalizeContentList(message.content);
      if (content.length === 0) continue;
      events.push(
        event("message.user.created", { messageId: entryId, content }),
      );
      continue;
    }
    if (role === "assistant") {
      const content = normalizeContentList(message.content);
      if (content.length === 0) continue;
      const toolCalls = content.filter((b) => b.type === "toolCall");
      const rawStop = asString(message.stopReason);
      const stopReason =
        toolCalls.length > 0
          ? "tool_use"
          : rawStop === "max_tokens" ||
              rawStop === "maxTokens" ||
              rawStop === "length"
            ? "max_tokens"
            : "end_turn";
      const usage = message.usage as Record<string, unknown> | undefined;
      events.push(
        event("message.assistant.completed", {
          messageId: entryId,
          content,
          model: {
            provider: asString(message.provider) || "unknown",
            id: asString(message.model) || "unknown",
          },
          stopReason,
          usage: {
            // cacheRead/cacheWrite ARE consumed context — claude reports most
            // input there; folding them in keeps the transcript meter honest.
            inputTokens:
              asNumber(usage?.input) +
              asNumber(usage?.cacheRead) +
              asNumber(usage?.cacheWrite),
            outputTokens: asNumber(usage?.output),
          },
        }),
      );
      let callIndex = 0;
      for (const call of toolCalls) {
        callIndex += 1;
        events.push(
          event("tool.call.started", {
            toolCallId: call.toolCallId || `${entryId}-tc${callIndex}`,
            messageId: entryId,
            runId: `imp-run-${entryId}`,
            turnId: `imp-turn-${entryId}`,
            name: call.name,
            args: call.args ?? {},
          }),
        );
      }
      continue;
    }
    if (role === "toolResult") {
      const toolCallId = asString(message.toolCallId) || `${entryId}-tc`;
      const result = toolOutputBlocks(message.content);
      if (message.isError === true) {
        events.push(
          event("tool.call.failed", {
            toolCallId,
            error: { code: "tool_error", message: textOf(result) },
          }),
        );
      } else {
        events.push(
          event("tool.call.completed", { toolCallId, result, durationMs: 0 }),
        );
      }
    }
  }
  return events;
}
