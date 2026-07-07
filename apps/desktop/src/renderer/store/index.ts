// Store barrel: pure reducers, zustand containers, and the single wire entry.

export { type ApprovalsStore, useApprovals } from "./approvals.ts";
export { type ConnectionStore, useConnection } from "./connection.ts";
export { ensureSubscribed, ingestBatch } from "./ingest.ts";
export { type SessionsStore, useSessions } from "./sessions.ts";
export {
  applyEvent,
  applyFrame,
  applySnapshot,
  getBridge,
  markSynced,
  prependOlderEvents,
  type TranscriptsStore,
  useTranscripts,
} from "./transcript.ts";
export * from "./types.ts";
export { type UiStore, useUi } from "./ui.ts";

import { approvalsInitial, useApprovals } from "./approvals.ts";
import { connectionInitial, useConnection } from "./connection.ts";
import { sessionsInitial, useSessions } from "./sessions.ts";
import { transcriptsInitial, useTranscripts } from "./transcript.ts";
import { uiInitial, useUi } from "./ui.ts";

/** Test helper: reset every store to its initial state. */
export function __resetAllStores(): void {
  useTranscripts.setState(transcriptsInitial);
  useSessions.setState(sessionsInitial);
  useApprovals.setState(approvalsInitial);
  useConnection.setState(connectionInitial);
  useUi.setState(uiInitial);
}
