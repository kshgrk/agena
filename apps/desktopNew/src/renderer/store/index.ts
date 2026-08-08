// Store barrel: pure reducers, zustand containers, the single wire entry, and
// the bridge wiring (subscribeBridge). Boot order (features.md §0): wire
// streams BEFORE connecting, then connectAndBootstrap after first paint.

export { type ApprovalsStore, useApprovals } from "./approvals.ts";
export {
  allCommands,
  type Command,
  commandForShortcut,
  registerCommands,
  runCommand,
  shortcutLabel,
  shortcutMatches,
  useCommands,
} from "./commands.ts";
export {
  type ConnectionStore,
  connectAndBootstrap,
  useConnection,
} from "./connection.ts";
export { ensureSubscribed, ingestBatch, resetSubscriptions } from "./ingest.ts";
export { type SessionsStore, useSessions } from "./sessions.ts";
export {
  activeBranchBlocks,
  applyEvent,
  applyFrame,
  applySnapshot,
  getBridge,
  markSynced,
  needsRecentHistory,
  prependOlderEvents,
  type TranscriptsStore,
  useTranscripts,
} from "./transcript.ts";
export * from "./types.ts";
export {
  applyThemeToDocument,
  buildCursorRecord,
  hasOverlay,
  hydrateUiFromPersisted,
  loadPersistedState,
  persistCursorsNow,
  pushToast,
  savePersistedPatch,
  schedulePersistCursors,
  type UiStore,
  useUi,
} from "./ui.ts";

import type { AgenaBridge } from "../../shared/bridge.ts";
import { approvalsInitial, useApprovals } from "./approvals.ts";
import { connectionInitial, useConnection } from "./connection.ts";
import { ingestBatch } from "./ingest.ts";
import { sessionsInitial, useSessions } from "./sessions.ts";
import { transcriptsInitial, useTranscripts } from "./transcript.ts";
import { schedulePersistCursors, uiInitial, useUi } from "./ui.ts";

/**
 * Attach the store pipeline to a bridge: every batch flows through ingestBatch
 * (the ONLY wire entry), connection status lands in useConnection, and replay
 * cursors are persisted lazily (full-record writes) as syncs/events advance
 * them. Returns an unsubscribe function. Call once at boot, before connect().
 */
export function subscribeBridge(bridge: AgenaBridge): () => void {
  const offBatch = bridge.onBatch((batch) => {
    ingestBatch(batch);
    if (
      batch.events.length > 0 ||
      batch.syncs.length > 0 ||
      batch.lostSessions.length > 0
    ) {
      schedulePersistCursors();
    }
  });
  const offStatus = bridge.onStatus((state, detail) => {
    useConnection.getState().setStatus(state, detail);
  });
  return () => {
    offBatch();
    offStatus();
  };
}

/** Test helper: reset every store to its initial state. */
export function __resetAllStores(): void {
  useTranscripts.setState(transcriptsInitial);
  useSessions.setState(sessionsInitial);
  useApprovals.setState(approvalsInitial);
  useConnection.setState(connectionInitial);
  useUi.setState(uiInitial);
}
