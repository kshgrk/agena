// Composer (design.md §6, features.md §5.2): rounded-2xl surface at the
// bottom of the column — autosize textarea (44px → 40vh), implicit send mode
// (idle=prompt, running=steer/followUp with a visible Steer/Queue control and
// SESSION_BUSY/TURN_NOT_ACTIVE auto-convert via send.ts), model + thinking
// ghost chips fed by runtimeInfo, Esc two-step abort, Enter/⌘Enter send,
// per-session drafts persisted through the bridge, disabled while
// disconnected. Ported from apps/desktop composer.tsx onto the new kit.
import type { ModelRef, ThinkingLevel } from "@agena/protocol";
import {
  ArrowUp,
  Brain,
  ChevronDown,
  Cpu,
  Ellipsis,
  Square,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { peekBridge } from "../../lib/bridge.ts";
import {
  pushToast,
  registerCommands,
  savePersistedPatch,
  useConnection,
  useTranscripts,
  useUi,
} from "../../store/index.ts";
import {
  Badge,
  cx,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Segmented,
  Tooltip,
} from "../../ui/index.ts";
import { ModelPicker } from "./model-picker.tsx";
import { errText, performSend } from "./send.ts";

// ---- drafts (module store, hydrated once, debounce-persisted) ------------------

type ComposerDraftsStore = {
  drafts: Readonly<Record<string, string>>;
  setDraft: (sessionId: string, text: string) => void;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // full-record write (savePersisted replaces whole top-level records)
    const drafts = Object.fromEntries(
      Object.entries(useComposerDrafts.getState().drafts).filter(
        ([, v]) => v !== "",
      ),
    );
    savePersistedPatch({ drafts });
  }, 500);
}

export const useComposerDrafts = create<ComposerDraftsStore>((set) => ({
  drafts: {},
  setDraft: (sessionId, text) => {
    set((s) => ({ drafts: { ...s.drafts, [sessionId]: text } }));
    scheduleSave();
  },
}));

// ponytail: hydrate once per app run; a mock↔daemon bridge switch mid-session
// won't rehydrate (accepted in the old app too — see features.md §8.4)
let hydrateStarted = false;

function hydrateDrafts(): void {
  if (hydrateStarted) return;
  hydrateStarted = true;
  void peekBridge()
    ?.loadPersisted()
    .then((p) => {
      // in-session typing wins over persisted values
      useComposerDrafts.setState((s) => ({
        drafts: { ...p.drafts, ...s.drafts },
      }));
    })
    .catch(() => {});
}

// ---- shared actions ---------------------------------------------------------------

async function abortTurn(sessionId: string): Promise<void> {
  try {
    await peekBridge()?.abort(sessionId);
  } catch (e) {
    pushToast({ kind: "err", title: "Abort failed", detail: errText(e) });
  }
}

async function compactHistory(sessionId: string): Promise<void> {
  try {
    await peekBridge()?.compact(sessionId);
    pushToast({ kind: "ok", title: "History compacted" });
  } catch (e) {
    pushToast({ kind: "err", title: "Compaction failed", detail: errText(e) });
  }
}

const isActive = (
  t:
    | ReturnType<typeof useTranscripts.getState>["bySession"][string]
    | undefined,
): boolean =>
  (t?.runtimeStatus?.state !== undefined && t.runtimeStatus.state !== "idle") ||
  (t?.inFlight ?? null) !== null;

// ---- ghost chips (design.md §6: model + thinking selectors) -------------------------

const chipCls =
  "inline-flex h-6 max-w-44 items-center gap-1 rounded-md px-2 text-xs " +
  "text-fg-secondary transition-colors duration-100 hover:bg-fg/6 hover:text-fg " +
  "[&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg-muted";

// ---- component ------------------------------------------------------------------------

export function Composer({ sessionId }: { sessionId: string }) {
  const value = useComposerDrafts((s) => s.drafts[sessionId] ?? "");
  const setDraft = useComposerDrafts((s) => s.setDraft);
  const active = useTranscripts((s) => isActive(s.bySession[sessionId]));
  const steerCount = useTranscripts(
    (s) => s.bySession[sessionId]?.queue.steerCount ?? 0,
  );
  const followUpCount = useTranscripts(
    (s) => s.bySession[sessionId]?.queue.followUpCount ?? 0,
  );
  const connState = useConnection((s) => s.state);
  const connected = connState === "connected";
  const runtime = useConnection((s) => s.runtime[sessionId]);
  const insert = useUi((s) => s.composerInsert);

  const [queueMode, setQueueMode] = useState<"steer" | "followUp">("steer");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const lastInsertNonce = useRef(useUi.getState().composerInsert?.nonce ?? 0);

  useEffect(() => hydrateDrafts(), []);

  // autosize 44px → 40vh (CSS max-h caps; JS tracks content height)
  // biome-ignore lint/correctness/useExhaustiveDependencies: value is the trigger for re-measuring
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  // fetch runtime controls lazily on first render for this session
  useEffect(() => {
    if (runtime || !connected) return;
    void peekBridge()
      ?.runtimeInfo(sessionId)
      .then((info) => useConnection.getState().setRuntime(sessionId, info))
      .catch(() => {});
  }, [sessionId, runtime, connected]);

  // cross-pane "insert into composer" (nonce re-triggers on the same text;
  // an empty insert is the "focus composer" signal)
  useEffect(() => {
    if (!insert || insert.nonce === lastInsertNonce.current) return;
    lastInsertNonce.current = insert.nonce;
    if (insert.text) {
      const cur = useComposerDrafts.getState().drafts[sessionId] ?? "";
      setDraft(sessionId, cur ? `${cur}${insert.text}` : insert.text);
    }
    taRef.current?.focus();
  }, [insert, sessionId, setDraft]);

  // turn ended elsewhere → drop the abort confirm strip
  useEffect(() => {
    if (!active) setConfirming(false);
  }, [active]);

  // command registry (ARCHITECTURE contract 2)
  useEffect(() => {
    return registerCommands([
      {
        id: "composer.focus",
        title: "Focus composer",
        group: "Composer",
        shortcut: "mod+l",
        run: () => taRef.current?.focus(),
      },
      {
        id: "turn.abort",
        title: "Abort turn",
        group: "Session",
        keywords: ["stop", "cancel", "esc"],
        when: () => isActive(useTranscripts.getState().bySession[sessionId]),
        run: () => void abortTurn(sessionId),
      },
      {
        id: "session.compact",
        title: "Compact history",
        group: "Session",
        keywords: ["context", "summarize"],
        run: () => void compactHistory(sessionId),
      },
    ]);
  }, [sessionId]);

  async function doSend(): Promise<void> {
    const text = value.trim();
    const bridge = peekBridge();
    if (!text || !connected || sending || !bridge) return;
    setSending(true);
    try {
      const out = await performSend(
        {
          prompt: (t) => bridge.prompt(sessionId, t),
          steer: (t) => bridge.steer(sessionId, t),
          followUp: (t) => bridge.followUp(sessionId, t),
        },
        { active, queueMode, text },
      );
      if (out.notice) pushToast({ kind: "info", title: out.notice });
      setDraft(sessionId, "");
    } catch (e) {
      pushToast({ kind: "err", title: "Send failed", detail: errText(e) });
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  }

  function onStop(): void {
    if (confirming) {
      setConfirming(false);
      void abortTurn(sessionId);
    } else {
      setConfirming(true);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    const plainEnter =
      e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing;
    const modEnter = e.key === "Enter" && (e.metaKey || e.ctrlKey);
    if (plainEnter || modEnter) {
      e.preventDefault();
      void doSend();
    } else if (e.key === "Escape" && active) {
      e.preventDefault();
      onStop();
    }
  }

  async function pickModel(model: ModelRef): Promise<void> {
    try {
      const ack = await peekBridge()?.setModel(sessionId, model);
      if (!ack) return;
      useConnection.setState((s) => {
        const r = s.runtime[sessionId];
        return r
          ? {
              runtime: {
                ...s.runtime,
                [sessionId]: { ...r, model: ack.model },
              },
            }
          : {};
      });
    } catch (e) {
      pushToast({
        kind: "err",
        title: "Model change failed",
        detail: errText(e),
      });
    }
  }

  async function pickThinking(thinkingLevel: ThinkingLevel): Promise<void> {
    try {
      const ack = await peekBridge()?.setThinkingLevel(
        sessionId,
        thinkingLevel,
      );
      if (!ack) return;
      useConnection.setState((s) => {
        const r = s.runtime[sessionId];
        return r
          ? {
              runtime: {
                ...s.runtime,
                [sessionId]: { ...r, thinkingLevel: ack.thinkingLevel },
              },
            }
          : {};
      });
    } catch (e) {
      pushToast({
        kind: "err",
        title: "Thinking level change failed",
        detail: errText(e),
      });
    }
  }

  const canSend = connected && !sending && value.trim() !== "";
  const modelAvailable = runtime?.availableModels.some(
    (model) =>
      model.provider === runtime.model?.provider &&
      model.id === runtime.model.id,
  );
  const modelLabel = modelAvailable
    ? (runtime?.model?.id ?? "model")
    : "Choose model";

  return (
    <div className="transcript-column pb-3 pt-2">
      {confirming ? (
        <div className="mb-1.5 flex animate-fade-slide-in items-center gap-2 rounded-lg border border-danger/35 bg-danger/10 px-3 py-1.5 text-xs">
          <span className="font-medium text-fg">Abort turn?</span>
          <span className="text-fg-muted">Esc again to confirm</span>
          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={onStop}
              className="h-6 rounded-md px-2 text-xs font-medium text-danger transition-colors duration-100 hover:bg-danger/10"
            >
              Abort
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="h-6 rounded-md px-2 text-xs text-fg-secondary transition-colors duration-100 hover:bg-fg/6"
            >
              Keep going
            </button>
          </span>
        </div>
      ) : null}

      <div className="rounded-2xl border border-border bg-surface transition-colors duration-100 focus-within:border-accent/50">
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          disabled={!connected}
          placeholder={
            !connected
              ? "Reconnecting…"
              : active
                ? queueMode === "steer"
                  ? "Steer the running turn…"
                  : "Queue a follow-up for after this turn…"
                : "Prompt the agent…"
          }
          aria-label="Composer"
          onChange={(e) => setDraft(sessionId, e.target.value)}
          onKeyDown={onKeyDown}
          className="block max-h-[40vh] min-h-11 w-full resize-none overflow-y-auto bg-transparent px-4 pt-3 text-base text-fg outline-none placeholder:text-fg-muted disabled:opacity-50"
        />

        <div className="flex items-center gap-1 px-2.5 pb-2.5 pt-1">
          {active ? (
            <Tooltip content="Model changes apply between turns only">
              <button
                type="button"
                aria-disabled="true"
                className={cx(chipCls, "opacity-50")}
              >
                <Cpu />
                <span className="truncate">{modelLabel}</span>
                <ChevronDown />
              </button>
            </Tooltip>
          ) : (
            <ModelPicker
              models={runtime?.availableModels ?? []}
              current={runtime?.model}
              label={modelLabel}
              chipCls={chipCls}
              onPick={(m) => void pickModel(m)}
            />
          )}

          <Menu>
            <MenuTrigger>
              <button
                type="button"
                aria-label="Thinking level"
                className={chipCls}
              >
                <Brain />
                <span className="truncate">
                  {runtime?.thinkingLevel ?? "thinking"}
                </span>
                <ChevronDown />
              </button>
            </MenuTrigger>
            <MenuContent>
              {(runtime?.availableThinkingLevels ?? []).map((level) => (
                <MenuItem
                  key={level}
                  onSelect={() => void pickThinking(level)}
                  className={
                    level === runtime?.thinkingLevel ? "text-accent" : undefined
                  }
                >
                  {level}
                </MenuItem>
              ))}
              {(runtime?.availableThinkingLevels ?? []).length === 0 ? (
                <MenuItem disabled>unavailable</MenuItem>
              ) : null}
            </MenuContent>
          </Menu>

          <Menu>
            <MenuTrigger>
              <button
                type="button"
                aria-label="More"
                className={cx(chipCls, "px-1")}
              >
                <Ellipsis />
              </button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => void compactHistory(sessionId)}>
                Compact history
              </MenuItem>
            </MenuContent>
          </Menu>

          {!connected ? (
            <span className="px-1 text-2xs text-fg-muted">reconnecting…</span>
          ) : null}

          <span className="ml-auto flex items-center gap-1.5">
            {steerCount > 0 ? (
              <Badge tone="accent">{steerCount} steer</Badge>
            ) : null}
            {followUpCount > 0 ? <Badge>{followUpCount} queued</Badge> : null}

            {active ? (
              <Segmented
                ariaLabel="Send mode"
                value={queueMode}
                onValueChange={setQueueMode}
                options={[
                  { value: "steer", label: "Steer" },
                  { value: "followUp", label: "Queue" },
                ]}
              />
            ) : null}

            {active ? (
              <Tooltip
                content={confirming ? "Click again to confirm" : "Stop turn"}
                shortcut="Esc"
              >
                <button
                  type="button"
                  aria-label="Stop turn"
                  onClick={onStop}
                  className="flex size-7 items-center justify-center rounded-md bg-danger/10 text-danger transition-colors duration-100 hover:bg-danger/16"
                >
                  <Square className="size-3 fill-current" />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content="Send" shortcut="⏎">
                <button
                  type="button"
                  aria-label="Send"
                  disabled={!canSend}
                  onClick={() => void doSend()}
                  className="flex size-7 items-center justify-center rounded-md bg-accent text-accent-fg transition-colors duration-100 hover:bg-accent-hover active:bg-accent-active disabled:pointer-events-none disabled:opacity-40"
                >
                  <ArrowUp className="size-4" />
                </button>
              </Tooltip>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
