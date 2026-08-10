// Pure session-rail projections: project grouping, archived bucketing,
// filter-as-you-type matching, cycle order, and create-session inputs.
// Ported from apps/desktop sessions-rail.tsx and extended per design.md §5
// (archived sessions live in one collapsed group at the bottom of the rail).
import type { CreateSessionRequest, SessionSummary } from "@agena/protocol";

/** Last two path segments — enough context for a dense rail. */
export function pathTail(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/") || path;
}

function pathName(path: string | undefined): string | undefined {
  return path?.split("/").filter(Boolean).pop();
}

export function sessionGroupLabel(session: SessionSummary): string {
  return (
    pathName(session.hostCwdHint) ??
    pathName(session.projectRoot) ??
    session.projectId ??
    "Global"
  );
}

export type ProjectGroup = {
  key: string;
  label: string;
  /** null when the summary carries no projectId (no project actions). */
  projectId: string | null;
  ids: string[];
};

export type SessionSections = {
  projectGroups: ProjectGroup[];
  globalIds: string[];
  /** All archived sessions (project + global), newest-first. */
  archivedIds: string[];
  visibleCount: number;
};

/** Case-insensitive substring match over title / cwd / group label / id. */
export function matchesQuery(
  session: SessionSummary,
  label: string,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    session.title ?? "",
    session.cwd,
    session.hostCwdHint ?? "",
    label,
    session.sessionId,
  ].some((text) => text.toLowerCase().includes(q));
}

/**
 * Newest-first order preserved within groups; control sessions never listed;
 * archived sessions land in their own bottom bucket (design.md §5).
 */
export function splitSessionSections(
  byId: Readonly<Record<string, SessionSummary>>,
  order: readonly string[],
  query = "",
): SessionSections {
  const projectGroups: ProjectGroup[] = [];
  const index = new Map<string, ProjectGroup>();
  const globalIds: string[] = [];
  const archivedIds: string[] = [];
  let visibleCount = 0;
  for (const id of order) {
    const s = byId[id];
    if (!s || s.scope === "control") continue;
    const label = s.scope === "global" ? "Global" : sessionGroupLabel(s);
    if (!matchesQuery(s, label, query)) continue;
    visibleCount++;
    if (s.status === "archived") {
      archivedIds.push(id);
      continue;
    }
    if (s.scope === "global") {
      globalIds.push(id);
      continue;
    }
    const key = s.projectId ?? `project:${s.sessionId}`;
    let g = index.get(key);
    if (!g) {
      g = { key, label, projectId: s.projectId ?? null, ids: [] };
      index.set(key, g);
      projectGroups.push(g);
    }
    g.ids.push(id);
  }
  return { projectGroups, globalIds, archivedIds, visibleCount };
}

/** Flattened id order for session.next / session.prev (archived excluded). */
export function cycleOrder(sections: SessionSections): string[] {
  return [
    ...sections.projectGroups.flatMap((g) => g.ids),
    ...sections.globalIds,
  ];
}

export function createGlobalSessionInput(): Partial<CreateSessionRequest> {
  return { scope: "global", cwd: "." };
}

/** null when the seed summary is missing project metadata (caller toasts). */
export function createProjectSessionInput(
  session: SessionSummary,
): Partial<CreateSessionRequest> | null {
  if (!session.projectId || !session.projectRoot) return null;
  return {
    scope: "project",
    projectId: session.projectId,
    projectRoot: session.projectRoot,
    cwd: session.projectRoot,
  };
}
