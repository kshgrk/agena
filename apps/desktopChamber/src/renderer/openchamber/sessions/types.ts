export type SessionActivity = "idle" | "active" | "unread";

export type OpenChamberSessionNode = {
  id: string;
  title: string;
  context?: string;
  time?: string;
  activity?: SessionActivity;
  elapsed?: string;
  disabled?: boolean;
  readOnly?: boolean;
  children?: readonly OpenChamberSessionNode[];
};

export type OpenChamberProjectNode = {
  id: string;
  label: string;
  sessions: readonly OpenChamberSessionNode[];
  activity?: Exclude<SessionActivity, "idle">;
};

export type SessionSidebarActions = {
  selectSession: (sessionId: string) => void;
  createSession?: (projectId: string | null) => void;
  renameSession?: (sessionId: string) => void;
  archiveSession?: (sessionId: string) => void;
  deleteSession?: (sessionId: string) => void;
  openSettings?: () => void;
  openShortcuts?: () => void;
  openAbout?: () => void;
};

export const PROJECT_SESSION_PREVIEW_LIMIT = 5;

export function projectSessionPreview(
  sessions: readonly OpenChamberSessionNode[],
  showAll: boolean,
  query: string,
): readonly OpenChamberSessionNode[] {
  return showAll || query.trim()
    ? sessions
    : sessions.slice(0, PROJECT_SESSION_PREVIEW_LIMIT);
}

export function sessionTreeContains(
  sessions: readonly OpenChamberSessionNode[],
  sessionId: string,
): boolean {
  return sessions.some(
    (session) =>
      session.id === sessionId ||
      (session.children
        ? sessionTreeContains(session.children, sessionId)
        : false),
  );
}

export function aggregateActivity(
  sessions: readonly OpenChamberSessionNode[],
): Exclude<SessionActivity, "idle"> | null {
  let unread = false;
  const visit = (node: OpenChamberSessionNode): boolean => {
    if (node.activity === "active") return true;
    if (node.activity === "unread") unread = true;
    return node.children?.some(visit) ?? false;
  };
  return sessions.some(visit) ? "active" : unread ? "unread" : null;
}

export function filterSessionTree(
  sessions: readonly OpenChamberSessionNode[],
  query: string,
): OpenChamberSessionNode[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...sessions];
  const filter = (
    node: OpenChamberSessionNode,
  ): OpenChamberSessionNode | null => {
    const children = node.children
      ?.map(filter)
      .filter((child) => child !== null);
    const matches = `${node.title}\n${node.context ?? ""}\n${node.id}`
      .toLowerCase()
      .includes(normalized);
    return matches || children?.length
      ? { ...node, ...(children === undefined ? {} : { children }) }
      : null;
  };
  return sessions.map(filter).filter((node) => node !== null);
}
