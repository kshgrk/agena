import type { UserMessageAnchor } from "@agena/protocol";
import { useEffect, useMemo, useState } from "react";
import { BlockView, ContentView } from "../../features/transcript/blocks.tsx";
import { visibleCodexSubagentBlocks } from "../../features/transcript/codex-subagent.ts";
import { UserMessageActions } from "../../features/transcript/session-actions.tsx";
import { ToolCard } from "../../features/transcript/tool-card.tsx";
import {
  getBridge,
  useConnection,
  useSessions,
  useTranscripts,
} from "../../store/index.ts";
import type { UserBlock } from "../../store/types.ts";
import {
  ChamberChatSurface,
  completeTurnBlocks,
  projectTurns,
} from "../chat/index.ts";

const EMPTY_BLOCKS = [] as const;

/** Connects the source-ported OpenChamber timeline to Agena durable events. */
export function AgenaChamberChat({
  sessionId,
  mobile = false,
}: {
  sessionId: string;
  mobile?: boolean;
}) {
  const transcript = useTranscripts((state) => state.bySession[sessionId]);
  const loadingEarlier = useTranscripts(
    (state) => state.loadingOlder[sessionId] ?? false,
  );
  const loadingPromptId = useTranscripts(
    (state) => state.loadingPrompt[sessionId] ?? null,
  );
  const session = useSessions((state) => state.byId[sessionId]);
  const connected = useConnection((state) => Boolean(state.info));
  const [promptIndex, setPromptIndex] = useState<UserMessageAnchor[]>([]);

  const blocks = useMemo(
    () =>
      visibleCodexSubagentBlocks(session, transcript?.blocks ?? EMPTY_BLOCKS),
    [session, transcript?.blocks],
  );
  const oldestSeq = transcript?.rawEvents[0]?.seq;
  const canLoadEarlier = transcript?.historyInitialized
    ? transcript.hasOlderHistory
    : oldestSeq !== undefined && oldestSeq > 1;
  const visibleBlocks = useMemo(
    () => completeTurnBlocks(blocks, canLoadEarlier),
    [blocks, canLoadEarlier],
  );
  const timeline = useMemo(
    () =>
      projectTurns(
        visibleBlocks,
        transcript?.hasNewerHistory ? null : (transcript?.inFlight ?? null),
      ),
    [transcript?.hasNewerHistory, transcript?.inFlight, visibleBlocks],
  );
  const users = useMemo(
    () =>
      new Map(
        visibleBlocks
          .filter((block): block is UserBlock => block.kind === "user")
          .map((block) => [block.messageId, block]),
      ),
    [visibleBlocks],
  );
  const prompts = useMemo(() => {
    const indexed = new Map<string, UserMessageAnchor & { loaded?: boolean }>(
      promptIndex.map((prompt) => [prompt.messageId, { ...prompt }]),
    );
    for (const block of users.values()) {
      const text = block.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(" ")
        .trim();
      indexed.set(block.messageId, {
        messageId: block.messageId,
        seq: block.seq,
        preview: indexed.get(block.messageId)?.preview ?? text.slice(0, 320),
        createdAt: block.at,
        loaded: true,
      });
    }
    return [...indexed.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((prompt) => ({
        ...prompt,
        loaded: users.has(prompt.messageId),
      }));
  }, [promptIndex, users]);

  useEffect(() => {
    setPromptIndex([]);
    if (!connected) return;
    let cancelled = false;
    void getBridge()
      ?.listUserMessages(sessionId)
      .then((messages) => {
        if (!cancelled) setPromptIndex(messages);
      });
    return () => {
      cancelled = true;
    };
  }, [connected, sessionId]);

  return (
    <ChamberChatSurface
      sessionKey={sessionId}
      timeline={timeline}
      working={Boolean(transcript?.inFlight)}
      mobile={mobile}
      renderContent={({ content }) => <ContentView content={content} />}
      renderActivity={({ activity, expanded, toggleExpanded }) => (
        <div className="transcript-column px-4">
          {activity.block.kind === "tool" &&
          activity.block.name !== "subagent" ? (
            <ToolCard
              block={activity.block}
              open={expanded}
              onOpenChange={(next) => {
                if (next !== expanded) toggleExpanded();
                if (
                  next &&
                  activity.block.kind === "tool" &&
                  activity.block.detailsState === "summary"
                ) {
                  void useTranscripts
                    .getState()
                    .loadToolDetails(sessionId, activity.block.toolCallId);
                }
              }}
            />
          ) : (
            <BlockView block={activity.block} sessionId={sessionId} />
          )}
        </div>
      )}
      renderOrphan={({ block }) => (
        <BlockView block={block} sessionId={sessionId} />
      )}
      renderUserActions={(message) => {
        const block = users.get(message.id);
        return block ? (
          <UserMessageActions sessionId={sessionId} block={block} />
        ) : null;
      }}
      canLoadEarlier={canLoadEarlier}
      loadingEarlier={loadingEarlier}
      onLoadEarlier={() => {
        void useTranscripts.getState().prependOlder(sessionId);
      }}
      prompts={prompts}
      loadingPromptId={loadingPromptId}
      onSelectPrompt={(messageId) =>
        useTranscripts.getState().revealMessage(sessionId, messageId)
      }
      hasNewer={transcript?.hasNewerHistory ?? false}
      onLoadLatest={() => useTranscripts.getState().loadLatest(sessionId)}
    />
  );
}
