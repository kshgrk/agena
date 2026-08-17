import type { UserMessageAnchor } from "@agena/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { SelectionActions } from "../../features/composer/source-reference-ui.tsx";
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
import { parseReferenceText } from "../../store/source-reference.ts";
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

  // Reveal animations run only for blocks newer than the moment this surface
  // opened the session — replayed/paged history must never animate.
  const mountSeqRef = useRef<{ sessionId: string; seq: number } | null>(null);
  if (mountSeqRef.current?.sessionId !== sessionId) {
    mountSeqRef.current = {
      sessionId,
      seq: transcript?.lastSeq ?? Number.MAX_SAFE_INTEGER,
    };
  }
  // transcript wasn't loaded at mount: arm at the replay boundary so restored
  // history stays still while genuinely new blocks still animate
  if (mountSeqRef.current.seq === Number.MAX_SAFE_INTEGER && transcript?.live) {
    mountSeqRef.current.seq = transcript.lastSeq;
  }
  const mountSeq = mountSeqRef.current.seq;
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
        .flatMap((part) =>
          part.type === "text" ? [parseReferenceText(part.text).text] : [],
        )
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

  const animateUserMessageId = useMemo(() => {
    for (let i = visibleBlocks.length - 1; i >= 0; i--) {
      const block = visibleBlocks[i];
      if (block?.kind !== "user") continue;
      return block.seq > mountSeq ? block.messageId : null;
    }
    return null;
  }, [mountSeq, visibleBlocks]);

  // ids must mirror activityOf() in project-turns.ts
  const animateActivityIds = useMemo(() => {
    const ids = new Set<string>();
    for (const block of visibleBlocks) {
      if (block.seq <= mountSeq) continue;
      if (block.kind === "tool") ids.add(block.toolCallId);
      else if (block.kind === "approval") ids.add(block.approvalId);
      else if (block.kind === "runtime") ids.add(block.messageId);
      else if (block.kind === "marker") ids.add(`marker-${block.seq}`);
    }
    return ids;
  }, [mountSeq, visibleBlocks]);

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
      renderContent={({ content, role, streaming, message }) => {
        const body = <ContentView content={content} contentRole={role} />;
        return !streaming && message ? (
          <SelectionActions
            sessionId={sessionId}
            makeReference={(snapshot) => ({
              v: 1,
              id: crypto.randomUUID(),
              kind: "transcript",
              sessionId,
              ...(transcript?.branchId
                ? { branchId: transcript.branchId }
                : {}),
              eventSeq: message.sourceSeq,
              messageId: message.id,
              role: message.role,
              snapshot,
            })}
          >
            {body}
          </SelectionActions>
        ) : (
          body
        );
      }}
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
      animateUserMessageId={animateUserMessageId}
      animateActivityIds={animateActivityIds}
    />
  );
}
