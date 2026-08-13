import type { SessionSummary } from "@agena/protocol";

export function sideChatRootSessionId(
  byId: Readonly<Record<string, SessionSummary>>,
  sessionId: string,
): string {
  let current = byId[sessionId];
  const seen = new Set<string>();
  while (current?.purpose === "quick_chat" && current.parentSessionId) {
    if (seen.has(current.sessionId)) return sessionId;
    seen.add(current.sessionId);
    const parent = byId[current.parentSessionId];
    if (!parent) return current.parentSessionId;
    current = parent;
  }
  return current?.sessionId ?? sessionId;
}

export function sideChatsForRoot(
  byId: Readonly<Record<string, SessionSummary>>,
  rootSessionId: string,
): SessionSummary[] {
  return allSideChatsForRoot(byId, rootSessionId).filter(
    (session) => session.status !== "archived",
  );
}

export function sideChatTitle(
  byId: Readonly<Record<string, SessionSummary>>,
  sessionId: string,
): string {
  const session = byId[sessionId];
  if (session?.title && session.title !== "Quick Chat") return session.title;
  const rootSessionId = sideChatRootSessionId(byId, sessionId);
  const index = allSideChatsForRoot(byId, rootSessionId).findIndex(
    (candidate) => candidate.sessionId === sessionId,
  );
  return `Quick Chat ${Math.max(1, index + 1)}`;
}

function allSideChatsForRoot(
  byId: Readonly<Record<string, SessionSummary>>,
  rootSessionId: string,
): SessionSummary[] {
  return Object.values(byId)
    .filter(
      (session) =>
        session.purpose === "quick_chat" &&
        sideChatRootSessionId(byId, session.sessionId) === rootSessionId,
    )
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        a.sessionId.localeCompare(b.sessionId),
    );
}
