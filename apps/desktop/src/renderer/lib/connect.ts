// Connect + first-load bootstrap. Shared by main.tsx (startup) and the
// reconnect banner in app.tsx; a failed connect leaves a usable shell.
import type { PersistedState } from "../../shared/bridge.ts";
import {
  ensureSubscribed,
  useApprovals,
  useConnection,
  useSessions,
} from "../store/index.ts";
import { toast } from "../ui/index.ts";
import { getBridge } from "./bridge.ts";

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : "Connection failed";
}

export async function connectAndBootstrap(
  persisted: PersistedState,
): Promise<void> {
  const bridge = getBridge();

  try {
    const info = await bridge.connect(persisted.activeProfile ?? undefined);
    useConnection.getState().setInfo(info);
  } catch (err) {
    const retryable =
      (err as { retryable?: unknown } | null)?.retryable === true;
    useConnection.getState().setStatus("closed", errMsg(err));
    toast(
      `Could not connect: ${errMsg(err)}${retryable ? " — use Retry in the banner" : ""}`,
      { tone: "err" },
    );
    return;
  }

  // Bootstrap in parallel; the sessions rail owns its own error/loading UI.
  await Promise.all([
    bridge
      .listApprovals()
      .then((a) => useApprovals.getState().seedFromHttp(a))
      .catch(() => {}),
    bridge
      .listSessionSummaries({ allProjects: true, includeArchived: true })
      .then((summaries) => {
        useSessions.getState().setAll(summaries);
        const { byId, order, activeSessionId } = useSessions.getState();
        if (activeSessionId) return; // the user already picked one
        const last = persisted.lastActiveSessionId;
        const next = (last && byId[last] ? last : order[0]) ?? null;
        if (next) {
          useSessions.getState().setActive(next);
          ensureSubscribed(next).catch((err) =>
            toast(errMsg(err), { tone: "err" }),
          );
        }
      })
      .catch(() => {}),
  ]);
}
