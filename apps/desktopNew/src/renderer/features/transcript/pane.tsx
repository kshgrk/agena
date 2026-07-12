// Pane entry (ARCHITECTURE contract 1): the shell renders this with no props,
// so it binds the active session itself. SessionWorkspace keys its subtree by
// sessionId — per-session scroll/animation state resets via remount.
import { MessageSquare } from "lucide-react";
import { useSessions } from "../../store/index.ts";
import { EmptyState } from "../../ui/index.ts";
import { ChildSessionBanner } from "../agents/task-group.tsx";
import { Transcript } from "./transcript-pane.tsx";

export function TranscriptPane() {
  const sessionId = useSessions((s) => s.activeSessionId);
  if (!sessionId) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No session"
        hint="Pick or create a session to see its transcript."
      />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChildSessionBanner sessionId={sessionId} />
      <div className="min-h-0 flex-1">
        <Transcript sessionId={sessionId} />
      </div>
    </div>
  );
}
