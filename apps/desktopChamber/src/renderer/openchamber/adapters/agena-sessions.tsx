import type { SessionSummary } from "@agena/protocol";
import { useCallback, useEffect, useMemo } from "react";
import { projectSidebarAgentTasks } from "../../features/agents/tasks.ts";
import {
  createGlobalSessionInput,
  createProjectSessionInput,
  splitSessionSections,
} from "../../features/sessions/sections.ts";
import { getBridge } from "../../lib/bridge.ts";
import { formatBridgeError } from "../../lib/errors.ts";
import {
  ensureSubscribed,
  pushToast,
  registerCommands,
  useSessions,
  useTranscripts,
  useUi,
} from "../../store/index.ts";
import {
  type OpenChamberProjectNode,
  type OpenChamberSessionNode,
  OpenChamberSessionSidebar,
} from "../sessions/index.ts";

function activity(session: SessionSummary): "active" | "idle" {
  return session.status === "active" ? "active" : "idle";
}

function nodeOf(
  session: SessionSummary,
  children: readonly OpenChamberSessionNode[] = [],
): OpenChamberSessionNode {
  return {
    id: session.sessionId,
    title: session.title || "Untitled session",
    activity: activity(session),
    readOnly: session.sessionKind === "subagent",
    ...(children.length ? { children } : {}),
  };
}

async function refreshSessions(): Promise<void> {
  const summaries = await getBridge().listSessionSummaries({
    allProjects: true,
    includeArchived: true,
  });
  useSessions.getState().setAll(summaries);
}

function report(title: string, error: unknown): void {
  pushToast({ kind: "err", title, detail: formatBridgeError(error) });
}

export function AgenaSessionSidebar({
  onSessionSelected,
}: {
  onSessionSelected?: () => void;
} = {}) {
  const byId = useSessions((state) => state.byId);
  const order = useSessions((state) => state.order);
  const activeSessionId = useSessions((state) => state.activeSessionId);
  const transcripts = useTranscripts((state) => state.bySession);

  const { projects, globalSessions } = useMemo(() => {
    const sections = splitSessionSections(byId, order);
    const tasks = projectSidebarAgentTasks(transcripts, byId);
    const childIds = new Set(tasks.map((task) => task.childSessionId));
    const children = new Map<string, OpenChamberSessionNode[]>();
    for (const task of tasks) {
      const session = byId[task.childSessionId];
      if (!session) continue;
      const list = children.get(task.parentSessionId) ?? [];
      list.push(nodeOf(session));
      children.set(task.parentSessionId, list);
    }
    const makeNodes = (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const session = byId[id];
        return session && !childIds.has(id)
          ? [nodeOf(session, children.get(id))]
          : [];
      });
    return {
      projects: sections.projectGroups.map(
        (group): OpenChamberProjectNode => ({
          id: group.key,
          label: group.label,
          sessions: makeNodes(group.ids),
        }),
      ),
      globalSessions: makeNodes(sections.globalIds),
    };
  }, [byId, order, transcripts]);

  const createSession = useCallback(
    async (projectId: string | null) => {
      try {
        const group = projectId
          ? projects.find((project) => project.id === projectId)
          : undefined;
        const seed = group?.sessions[0]
          ? byId[group.sessions[0].id]
          : undefined;
        const input = seed
          ? createProjectSessionInput(seed)
          : createGlobalSessionInput();
        if (!input) throw new Error("Project metadata is incomplete");
        const id = await getBridge().createSession(input);
        await ensureSubscribed(id, 0);
        await refreshSessions();
        useSessions.getState().setActive(id);
        useUi.getState().requestComposerInsert("");
      } catch (error) {
        report("Could not create session", error);
      }
    },
    [byId, projects],
  );

  useEffect(
    () =>
      registerCommands([
        {
          id: "session.new",
          title: "New session",
          group: "Session",
          shortcut: "mod+n",
          run: () => void createSession(null),
        },
      ]),
    [createSession],
  );

  return (
    <OpenChamberSessionSidebar
      title="Agena"
      activeSessionId={activeSessionId}
      projects={projects}
      globalSessions={globalSessions}
      initialExpandedSessions={activeSessionId ? [activeSessionId] : []}
      actions={{
        selectSession: (sessionId) => {
          useSessions.getState().setActive(sessionId);
          onSessionSelected?.();
          void ensureSubscribed(sessionId).catch((error: unknown) =>
            report("Could not open session", error),
          );
        },
        createSession: (projectId) => void createSession(projectId),
        archiveSession: (sessionId) => {
          void getBridge()
            .updateSessionStatus(sessionId, "archived")
            .then(refreshSessions)
            .catch((error: unknown) =>
              report("Could not archive session", error),
            );
        },
        openSettings: () => useUi.getState().setSettingsOpen(true),
        openShortcuts: () => useUi.getState().setPaletteOpen(true),
        openAbout: () => useUi.getState().setSettingsOpen(true),
      }}
    />
  );
}
