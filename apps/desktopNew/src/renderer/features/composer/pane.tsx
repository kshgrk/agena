// Pane entry (ARCHITECTURE contract 1): the shell renders this with no props
// under the transcript; it binds the active session itself and renders nothing
// when no session is selected (the transcript pane owns that empty state).
import { useSessions } from "../../store/index.ts";
import { Composer } from "./composer.tsx";

export function ComposerPane() {
  const sessionId = useSessions((s) => s.activeSessionId);
  if (!sessionId) return null;
  return <Composer sessionId={sessionId} />;
}
