// Session rail state: HTTP summaries + live status frames.
import type { SessionStatus, SessionSummary } from "@agena/protocol";
import { create } from "zustand";
import { getBridge } from "./transcript.ts";
import type { SessionsState } from "./types.ts";

export type SessionsStore = SessionsState & {
  /** Sessions the daemon no longer knows (toast-able; SESSION_NOT_FOUND). */
  lost: readonly string[];
  setAll: (summaries: SessionSummary[]) => void;
  upsert: (summary: SessionSummary) => void;
  /** Also persists lastActiveSessionId (fire-and-forget). */
  setActive: (sessionId: string | null) => void;
  setStatus: (sessionId: string, status: SessionStatus) => void;
  setTitle: (sessionId: string, title: string) => void;
  markLost: (sessionId: string) => void;
  /** ingest-internal: bump lastSeq/updatedAt when durable events arrive. */
  bump: (sessionId: string, seq: number, at: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
};

export const sessionsInitial: SessionsState & { lost: readonly string[] } = {
  byId: {},
  order: [],
  activeSessionId: null,
  loading: false,
  error: null,
  lost: [],
};

/** Newest-first: session ids are ULIDs, so lexicographic desc = time desc. */
const sortNewestFirst = (
  byId: Readonly<Record<string, SessionSummary>>,
): string[] => Object.keys(byId).sort((a, b) => b.localeCompare(a));

export const useSessions = create<SessionsStore>((set) => ({
  ...sessionsInitial,
  setAll: (summaries) =>
    set(() => {
      const byId: Record<string, SessionSummary> = {};
      for (const s of summaries) byId[s.sessionId] = s;
      return {
        byId,
        order: sortNewestFirst(byId),
        loading: false,
        error: null,
      };
    }),
  upsert: (summary) =>
    set((s) => {
      const byId = { ...s.byId, [summary.sessionId]: summary };
      return { byId, order: sortNewestFirst(byId) };
    }),
  setActive: (sessionId) => {
    set({ activeSessionId: sessionId });
    void getBridge()
      ?.savePersisted({ lastActiveSessionId: sessionId })
      .catch(() => {});
  },
  setStatus: (sessionId, status) =>
    set((s) => {
      const cur = s.byId[sessionId];
      if (!cur || cur.status === status) return s;
      return { byId: { ...s.byId, [sessionId]: { ...cur, status } } };
    }),
  setTitle: (sessionId, title) =>
    set((s) => {
      const cur = s.byId[sessionId];
      if (!cur || cur.title === title) return s;
      return { byId: { ...s.byId, [sessionId]: { ...cur, title } } };
    }),
  markLost: (sessionId) =>
    set((s) =>
      s.lost.includes(sessionId) ? s : { lost: [...s.lost, sessionId] },
    ),
  bump: (sessionId, seq, at) =>
    set((s) => {
      const cur = s.byId[sessionId];
      if (!cur || seq <= cur.lastSeq) return s;
      return {
        byId: {
          ...s.byId,
          [sessionId]: { ...cur, lastSeq: seq, updatedAt: at },
        },
      };
    }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
}));
