import type { SessionSummary } from "@agena/protocol";
import type { Block, ToolBlock, TranscriptState } from "../../store/types.ts";
import { workspaceRelative } from "./files-lib.ts";

export type FileActivityOperation = "read" | "search" | "list" | "write";
export type FileActivityStatus =
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "denied";

export type FileActivity = {
  sessionId: string;
  seq: number;
  at: string;
  toolCallId: string;
  toolName: string;
  operation: FileActivityOperation;
  path: string;
  reportedPath: string;
  status: FileActivityStatus;
  actor: string;
  access?: "read_only" | "full";
};

const TOOL_OPERATIONS: Readonly<
  Record<string, { operation: FileActivityOperation; defaultPath?: string }>
> = {
  read: { operation: "read" },
  edit: { operation: "write" },
  write: { operation: "write" },
  grep: { operation: "search", defaultPath: "." },
  find: { operation: "search", defaultPath: "." },
  ls: { operation: "list", defaultPath: "." },
};

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value === "string") {
    try {
      return stringField(JSON.parse(value), key);
    } catch {
      const escaped = value.match(
        new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`),
      )?.[1];
      if (!escaped) return undefined;
      try {
        return JSON.parse(`"${escaped}"`) as string;
      } catch {
        return undefined;
      }
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

/** Resolve a tool-reported path for display only; daemon file APIs remain the security gate. */
export function displayActivityPath(
  reportedPath: string,
  cwd: string,
): string | null {
  const base = reportedPath.startsWith("/") ? "" : workspaceRelative(cwd);
  const raw = reportedPath.startsWith("/workspace/")
    ? reportedPath.slice("/workspace/".length)
    : reportedPath === "/workspace"
      ? "."
      : reportedPath.startsWith("/")
        ? null
        : base === "."
          ? reportedPath
          : `${base}/${reportedPath}`;
  if (raw === null) return null;

  const parts: string[] = [];
  for (const part of raw.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/") || ".";
}

function actorLabel(session: SessionSummary): string {
  if (session.sessionKind === "subagent") {
    return session.subagent?.role ?? "Subagent";
  }
  if (session.purpose === "quick_chat") {
    return session.title && session.title !== "Quick Chat"
      ? session.title
      : "Side chat";
  }
  return "Main";
}

function toolBlockActivity(
  session: SessionSummary,
  block: ToolBlock,
): FileActivity | null {
  const config = TOOL_OPERATIONS[block.name];
  if (!config) return null;
  const reportedPath = stringField(block.args, "path") ?? config.defaultPath;
  if (!reportedPath) return null;
  const path = displayActivityPath(reportedPath, session.cwd);
  if (!path) return null;
  return {
    sessionId: session.sessionId,
    seq: block.seq,
    at: block.at,
    toolCallId: block.toolCallId,
    toolName: block.name,
    operation: config.operation,
    path,
    reportedPath,
    status: block.status,
    actor: actorLabel(session),
    ...(session.sideChatAccess ? { access: session.sideChatAccess } : {}),
  };
}

export function projectSessionToolActivities(
  session: SessionSummary,
  blocks: readonly Block[],
): FileActivity[] {
  return blocks.flatMap((block) => {
    if (block.kind !== "tool") return [];
    const activity = toolBlockActivity(session, block);
    return activity ? [activity] : [];
  });
}

function rootSessionId(
  sessions: Readonly<Record<string, SessionSummary>>,
  sessionId: string,
): string {
  let current = sessions[sessionId];
  const seen = new Set<string>();
  while (current?.parentSessionId && !seen.has(current.sessionId)) {
    seen.add(current.sessionId);
    const parent = sessions[current.parentSessionId];
    if (!parent) return current.parentSessionId;
    current = parent;
  }
  return current?.sessionId ?? sessionId;
}

export function familySessionIds(
  sessions: Readonly<Record<string, SessionSummary>>,
  sessionId: string,
): string[] {
  const root = rootSessionId(sessions, sessionId);
  return Object.values(sessions)
    .filter((session) => rootSessionId(sessions, session.sessionId) === root)
    .map((session) => session.sessionId);
}

export function projectFamilyFileActivities(
  sessions: Readonly<Record<string, SessionSummary>>,
  transcripts: Readonly<Record<string, TranscriptState>>,
  sessionId: string,
): FileActivity[] {
  return familySessionIds(sessions, sessionId)
    .flatMap((id) => {
      const session = sessions[id];
      const transcript = transcripts[id];
      return session && transcript
        ? projectSessionToolActivities(session, transcript.blocks)
        : [];
    })
    .sort(
      (a, b) =>
        a.at.localeCompare(b.at) ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.seq - b.seq,
    );
}

export function latestActivityByPath(
  activities: readonly FileActivity[],
): Readonly<Record<string, FileActivity>> {
  const latest: Record<string, FileActivity> = {};
  for (const activity of activities) latest[activity.path] = activity;
  return latest;
}
