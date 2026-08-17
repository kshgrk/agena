import { CopyPlus, GitFork, PencilLine, Undo2 } from "lucide-react";
import { getBridge } from "../../lib/bridge.ts";
import { formatBridgeError } from "../../lib/errors.ts";
import {
  ensureSubscribed,
  pushToast,
  useSessions,
  useUi,
} from "../../store/index.ts";
import { parseReferenceText } from "../../store/source-reference.ts";
import type { UserBlock } from "../../store/types.ts";
import { Button, IconButton } from "../../ui/index.ts";

async function openDerivedSession(
  sessionId: string,
  sourceMessageId: string | undefined,
  mode: "fork" | "clone",
  draft?: string,
): Promise<void> {
  try {
    const bridge = getBridge();
    const child = await bridge.forkSession(sessionId, sourceMessageId, mode);
    await ensureSubscribed(child.sessionId, 0);
    const summaries = await bridge.listSessionSummaries({
      allProjects: true,
      includeArchived: true,
    });
    useSessions.getState().setAll(summaries);
    useSessions.getState().setActive(child.sessionId);
    if (draft !== undefined) {
      restoreComposerDraft(draft, child.sessionId);
    }
  } catch (error) {
    pushToast({
      kind: "err",
      title:
        mode === "clone"
          ? "Could not clone conversation"
          : "Could not fork conversation",
      detail: formatBridgeError(error),
    });
  }
}

function restoreComposerDraft(value: string, sessionId: string): void {
  const parsed = parseReferenceText(value);
  useUi
    .getState()
    .requestComposerContent(parsed.text, parsed.references, sessionId);
}

async function editInSession(
  sessionId: string,
  sourceMessageId: string,
): Promise<void> {
  try {
    const editorText = await getBridge().navigateSession(
      sessionId,
      sourceMessageId,
    );
    restoreComposerDraft(editorText, sessionId);
  } catch (error) {
    pushToast({
      kind: "err",
      title: "Could not edit this message",
      detail: formatBridgeError(error),
    });
  }
}

export function UserMessageActions({
  sessionId,
  block,
}: {
  sessionId: string;
  block: UserBlock;
}) {
  return (
    <>
      <IconButton
        label="Edit and branch"
        size="sm"
        data-session-action="edit-branch"
        data-source-message-id={block.messageId}
        onClick={(event) => {
          event.stopPropagation();
          void editInSession(sessionId, block.messageId);
        }}
      >
        <PencilLine />
      </IconButton>
      <IconButton
        label="Fork from here"
        size="sm"
        data-session-action="fork-message"
        data-source-message-id={block.messageId}
        onClick={(event) => {
          event.stopPropagation();
          void openDerivedSession(sessionId, block.messageId, "fork");
        }}
      >
        <GitFork />
      </IconButton>
    </>
  );
}

export function SessionLineage({ sessionId }: { sessionId: string }) {
  const sessions = useSessions((state) => state.byId);
  const session = sessions[sessionId];
  const lineage = session?.derivedFrom;
  const parent = lineage ? sessions[lineage.parentSessionId] : undefined;

  if (session?.sessionKind === "subagent") return null;

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-3 text-xs text-fg-muted"
      data-session-lineage={lineage?.mode ?? "root"}
    >
      {lineage ? (
        <GitFork className="size-3.5" />
      ) : (
        <CopyPlus className="size-3.5" />
      )}
      {lineage ? (
        <>
          <span>
            {lineage.mode === "clone" ? "Cloned" : "Branched"} from{" "}
            <strong className="font-medium text-fg">
              {parent?.title ?? "parent conversation"}
            </strong>
          </span>
          <span className="hidden font-mono text-2xs text-fg-faint lg:inline">
            {lineage.parentSessionId.slice(-6)}
          </span>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            icon={<Undo2 />}
            onClick={() => {
              useSessions.getState().setActive(lineage.parentSessionId);
              void ensureSubscribed(lineage.parentSessionId);
            }}
          >
            Back to parent
          </Button>
        </>
      ) : (
        <>
          <span className="flex-1">Conversation</span>
          <Button
            size="sm"
            variant="ghost"
            icon={<CopyPlus />}
            data-session-action="clone-conversation"
            onClick={() =>
              void openDerivedSession(sessionId, undefined, "clone")
            }
          >
            Clone
          </Button>
        </>
      )}
    </div>
  );
}
