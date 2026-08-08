// Connection status + per-session runtime controls + the boot sequence.
// bridge.md §4: every renderer (re)load is connect() → loadPersisted() →
// subscribe() each session of interest from its cursor. SDK-level reconnects
// re-subscribe by themselves and only surface here via onStatus.
import type { RuntimeInfoAck } from "@agena/protocol";
import { create } from "zustand";
import type {
  BridgeConnectionState,
  ConnectedInfo,
} from "../../shared/bridge.ts";
import { useApprovals } from "./approvals.ts";
import { useSessions } from "./sessions.ts";
import { getBridge } from "./transcript.ts";
import type { ConnectionSlice } from "./types.ts";
import { loadPersistedState, pushToast } from "./ui.ts";

export type ConnectionStore = ConnectionSlice & {
  setStatus: (state: BridgeConnectionState, detail?: string) => void;
  setInfo: (info: ConnectedInfo | null) => void;
  /** Fill runtime controls lazily from a runtimeInfo() ack. */
  setRuntime: (sessionId: string, info: RuntimeInfoAck) => void;
  setFastMode: (sessionId: string, enabled: boolean) => void;
};

export const connectionInitial: ConnectionSlice = {
  state: "connecting",
  detail: null,
  info: null,
  runtime: {},
};

export const useConnection = create<ConnectionStore>((set) => ({
  ...connectionInitial,
  setStatus: (state, detail) => set({ state, detail: detail ?? null }),
  setInfo: (info) => set({ info }),
  setRuntime: (sessionId, info) =>
    set((s) => ({
      runtime: {
        ...s.runtime,
        [sessionId]: {
          thinkingLevel: info.thinkingLevel,
          availableModels: info.availableModels,
          availableThinkingLevels: info.availableThinkingLevels,
          ...(info.fastMode ? { fastMode: info.fastMode } : {}),
          ...(info.sessionUsage ? { sessionUsage: info.sessionUsage } : {}),
          ...(info.subscriptionUsage
            ? { subscriptionUsage: info.subscriptionUsage }
            : {}),
          ...(info.model ? { model: info.model } : {}),
        },
      },
    })),
  setFastMode: (sessionId, enabled) =>
    set((s) => {
      const runtime = s.runtime[sessionId];
      if (!runtime?.fastMode) return {};
      return {
        runtime: {
          ...s.runtime,
          [sessionId]: {
            ...runtime,
            fastMode: {
              ...runtime.fastMode,
              enabled,
              active: enabled && runtime.fastMode.available,
            },
          },
        },
      };
    }),
}));

/** Refresh every session whose model controls have already been loaded. */
export async function refreshRuntimeInfo(): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  await Promise.all(
    Object.keys(useConnection.getState().runtime).map(async (sessionId) => {
      const info = await bridge.runtimeInfo(sessionId);
      useConnection.getState().setRuntime(sessionId, info);
    }),
  );
}

// ---- boot sequence ---------------------------------------------------------------

const errMsg = (err: unknown): string =>
  err instanceof Error
    ? err.message
    : typeof (err as { message?: unknown } | null)?.message === "string"
      ? String((err as { message: string }).message)
      : "Something went wrong";

/**
 * Connect and bootstrap the renderer (also the Retry-banner handler). A failed
 * connect leaves a usable shell: status "closed" + an error toast, nothing
 * throws. Safe to call again after failure or from a fresh renderer load.
 */
export async function connectAndBootstrap(profileName?: string): Promise<void> {
  const bridge = getBridge();
  if (!bridge) {
    useConnection.getState().setStatus("closed", "no bridge installed");
    return;
  }

  // A fresh connect() tears down main's client + subscriptions — mirror that.
  const { ensureSubscribed, resetSubscriptions } = await import("./ingest.ts");
  resetSubscriptions();
  const persisted = await loadPersistedState();

  let info: ConnectedInfo;
  try {
    info = await bridge.connect(
      profileName ?? persisted.activeProfile ?? undefined,
    );
  } catch (err) {
    const msg = errMsg(err);
    useConnection.getState().setStatus("closed", msg);
    const retryable =
      (err as { retryable?: unknown } | null)?.retryable === true;
    pushToast({
      kind: "err",
      title: "Failed to connect to daemon",
      detail: retryable ? `${msg} — use Retry to reconnect` : msg,
    });
    return;
  }
  useConnection.getState().setInfo(info);

  // Seed pending approvals in parallel; event-derived entries win on merge.
  void bridge
    .listApprovals()
    .then((a) => useApprovals.getState().seedFromHttp(a))
    .catch(() => {});

  useSessions.getState().setLoading(true);
  try {
    const summaries = await bridge.listSessionSummaries({
      allProjects: true,
      includeArchived: true,
    });
    useSessions.getState().setAll(summaries);
  } catch (err) {
    useSessions.getState().setError(errMsg(err));
    return;
  }

  // Activate: keep the current session if still known, else the persisted
  // last-active one, else the newest; then subscribe it from its cursor.
  const s = useSessions.getState();
  const next =
    s.activeSessionId && s.byId[s.activeSessionId]
      ? s.activeSessionId
      : persisted.lastActiveSessionId && s.byId[persisted.lastActiveSessionId]
        ? persisted.lastActiveSessionId
        : (s.order[0] ?? null);
  if (!next) return;
  if (next !== s.activeSessionId) s.setActive(next);
  try {
    await ensureSubscribed(next);
  } catch (err) {
    pushToast({
      kind: "err",
      title: "Failed to subscribe to session",
      detail: errMsg(err),
    });
  }
}
