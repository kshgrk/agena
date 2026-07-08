// Composer (plan §7.6): implicit mode (idle=prompt, active=steer/followUp),
// Esc abort-with-confirm, per-session drafts persisted via the bridge, model /
// thinking / compact controls fed by runtimeInfo.
import type { ModelRef, ThinkingLevel } from "@agena/protocol";
import { ArrowUp, ChevronDown, Ellipsis, Square } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { getBridge } from "../../lib/bridge.ts";
import { useCommands } from "../../store/commands.ts";
import { useConnection, useTranscripts, useUi } from "../../store/index.ts";
import {
  Badge,
  Button,
  cx,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Tooltip,
  toast,
} from "../../ui/index.ts";

// ---- drafts (module store, hydrated once, debounce-persisted) ----------------

type ComposerDraftsStore = {
  drafts: Readonly<Record<string, string>>;
  setDraft: (sessionId: string, text: string) => void;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const drafts = Object.fromEntries(
        Object.entries(useComposerDrafts.getState().drafts).filter(
          ([, v]) => v !== "",
        ),
      );
      void getBridge()
        .savePersisted({ drafts })
        .catch(() => {});
    } catch {
      // no bridge (tests) — nothing to persist to
    }
  }, 500);
}

export const useComposerDrafts = create<ComposerDraftsStore>((set) => ({
  drafts: {},
  setDraft: (sessionId, text) => {
    set((s) => ({ drafts: { ...s.drafts, [sessionId]: text } }));
    scheduleSave();
  },
}));

let hydrateStarted = false;

function hydrateDrafts(): void {
  if (hydrateStarted) return;
  hydrateStarted = true;
  try {
    void getBridge()
      .loadPersisted()
      .then((p) => {
        // in-session typing wins over persisted values
        useComposerDrafts.setState((s) => ({
          drafts: { ...p.drafts, ...s.drafts },
        }));
      })
      .catch(() => {});
  } catch {
    // no bridge (tests)
  }
}

// ---- shared error/action helpers ---------------------------------------------

function errCode(e: unknown): string {
  return typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof e.code === "string"
    ? e.code
    : "";
}

function errText(e: unknown): string {
  return typeof e === "object" &&
    e !== null &&
    "message" in e &&
    typeof e.message === "string"
    ? e.message
    : "Something went wrong";
}

async function abortTurn(sessionId: string): Promise<void> {
  try {
    await getBridge().abort(sessionId);
  } catch (e) {
    toast(errText(e), { tone: "err" });
  }
}

async function compactHistory(sessionId: string): Promise<void> {
  try {
    await getBridge().compact(sessionId);
    toast("History compacted", { tone: "ok" });
  } catch (e) {
    toast(errText(e), { tone: "err" });
  }
}

// ---- component -----------------------------------------------------------------

const MAX_HEIGHT = 172; // 8 rows × 20px leading + vertical padding

const pickerCls =
  "inline-flex h-6 max-w-44 items-center gap-1 rounded px-1.5 text-xs text-ink-dim transition-colors " +
  "hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent";

export function Composer({ sessionId }: { sessionId: string }) {
  const value = useComposerDrafts((s) => s.drafts[sessionId] ?? "");
  const setDraft = useComposerDrafts((s) => s.setDraft);
  const active = useTranscripts((s) => {
    const t = s.bySession[sessionId];
    return (
      (t?.runtimeStatus?.state !== undefined &&
        t.runtimeStatus.state !== "idle") ||
      (t?.inFlight ?? null) !== null
    );
  });
  const steerCount = useTranscripts(
    (s) => s.bySession[sessionId]?.queue.steerCount ?? 0,
  );
  const followUpCount = useTranscripts(
    (s) => s.bySession[sessionId]?.queue.followUpCount ?? 0,
  );
  const connected = useConnection((s) => s.state === "connected");
  const runtime = useConnection((s) => s.runtime[sessionId]);
  const insert = useUi((s) => s.composerInsert);

  const [queueMode, setQueueMode] = useState<"steer" | "followUp">("steer");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const lastInsertNonce = useRef(useUi.getState().composerInsert?.nonce ?? 0);

  useEffect(() => hydrateDrafts(), []);

  // auto-grow 1→8 rows (value is controlled, so onInput alone would miss
  // programmatic changes like clear-on-send and composerInsert)
  // biome-ignore lint/correctness/useExhaustiveDependencies: value is the trigger for re-measuring scrollHeight
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  // fetch runtime controls lazily on first render for this session
  useEffect(() => {
    if (runtime || !connected) return;
    getBridge()
      .runtimeInfo(sessionId)
      .then((info) => useConnection.getState().setRuntime(sessionId, info))
      .catch(() => {});
  }, [sessionId, runtime, connected]);

  // cross-pane "insert into composer" (nonce re-triggers on same text)
  useEffect(() => {
    if (!insert || insert.nonce === lastInsertNonce.current) return;
    lastInsertNonce.current = insert.nonce;
    const cur = useComposerDrafts.getState().drafts[sessionId] ?? "";
    setDraft(sessionId, cur ? `${cur}${insert.text}` : insert.text);
    taRef.current?.focus();
  }, [insert, sessionId, setDraft]);

  // turn ended elsewhere → drop the abort confirm strip
  useEffect(() => {
    if (!active) setConfirming(false);
  }, [active]);

  // palette/keyboard commands (§7.8): registry is the single owner
  useEffect(() => {
    return useCommands.getState().register([
      {
        id: "composer.focus",
        title: "Focus composer",
        group: "Composer",
        chord: "mod+l",
        run: () => taRef.current?.focus(),
      },
      {
        id: "turn.abort",
        title: "Abort turn",
        group: "Session",
        keywords: ["stop", "cancel", "esc"],
        enabled: () => {
          const t = useTranscripts.getState().bySession[sessionId];
          return (
            (t?.runtimeStatus?.state !== undefined &&
              t.runtimeStatus.state !== "idle") ||
            (t?.inFlight ?? null) !== null
          );
        },
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
    if (!text || !connected || sending) return;
    setSending(true);
    const bridge = getBridge();
    try {
      if (active) {
        try {
          await (queueMode === "steer"
            ? bridge.steer(sessionId, text)
            : bridge.followUp(sessionId, text));
        } catch (e) {
          // turn ended while typing → silently resend as prompt (§7.6)
          if (errCode(e) === "TURN_NOT_ACTIVE")
            await bridge.prompt(sessionId, text);
          else throw e;
        }
      } else {
        try {
          await bridge.prompt(sessionId, text);
        } catch (e) {
          // lost the prompt race → auto-convert to steer with a notice (§7.6)
          if (errCode(e) === "SESSION_BUSY") {
            await bridge.steer(sessionId, text);
            toast("Turn already active — sent as steer", { tone: "info" });
          } else throw e;
        }
      }
      setDraft(sessionId, "");
    } catch (e) {
      toast(errText(e), { tone: "err" });
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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void doSend();
    } else if (e.key === "Escape" && active) {
      e.preventDefault();
      onStop();
    }
  }

  async function pickModel(model: ModelRef): Promise<void> {
    try {
      const ack = await getBridge().setModel(sessionId, model);
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
      toast(errText(e), { tone: "err" });
    }
  }

  async function pickThinking(thinkingLevel: ThinkingLevel): Promise<void> {
    try {
      const ack = await getBridge().setThinkingLevel(sessionId, thinkingLevel);
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
      toast(errText(e), { tone: "err" });
    }
  }

  const canSend = connected && !sending && value.trim() !== "";
  const modelLabel = runtime?.model?.id ?? "model";

  return (
    <div className="flex flex-col gap-1.5">
      {confirming ? (
        <div className="flex items-center gap-2 rounded border border-err/30 bg-err/10 px-2 py-1 text-xs text-ink">
          <span className="font-medium">Abort turn?</span>
          <span className="text-ink-mute">Esc again to confirm</span>
          <span className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="danger" onClick={onStop}>
              Abort
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              Keep going
            </Button>
          </span>
        </div>
      ) : null}

      <div
        className={cx(
          "rounded-md border bg-app transition-colors",
          active
            ? "border-accent/60 ring-1 ring-accent/25"
            : "border-border focus-within:border-border-strong",
        )}
      >
        <div className="flex items-start gap-2 px-2.5 pt-2">
          <textarea
            ref={taRef}
            rows={1}
            value={value}
            disabled={!connected}
            placeholder={
              active ? "Steer the agent… (Enter)" : "Prompt… (Enter to send)"
            }
            aria-label="Composer"
            onChange={(e) => setDraft(sessionId, e.target.value)}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 resize-none overflow-y-auto bg-transparent font-mono text-[13px] leading-5 text-ink outline-none placeholder:text-ink-mute disabled:opacity-50"
          />
          {active ? (
            // biome-ignore lint/a11y/useSemanticElements: segmented control; fieldset default styling fights the flex layout
            <div
              role="group"
              aria-label="Send mode"
              className="flex shrink-0 items-center rounded border border-border p-px text-[11px]"
            >
              <button
                type="button"
                aria-pressed={queueMode === "steer"}
                onClick={() => setQueueMode("steer")}
                className={cx(
                  "rounded-sm px-1.5 py-0.5 transition-colors",
                  queueMode === "steer"
                    ? "bg-raised text-ink"
                    : "text-ink-mute hover:text-ink-dim",
                )}
              >
                Steer
              </button>
              <button
                type="button"
                aria-pressed={queueMode === "followUp"}
                onClick={() => setQueueMode("followUp")}
                className={cx(
                  "rounded-sm px-1.5 py-0.5 transition-colors",
                  queueMode === "followUp"
                    ? "bg-raised text-ink"
                    : "text-ink-mute hover:text-ink-dim",
                )}
              >
                Queue follow-up
              </button>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-0.5 px-1.5 py-1.5">
          {active ? (
            <Tooltip content="between turns only">
              <button
                type="button"
                aria-disabled="true"
                className={cx(pickerCls, "opacity-50")}
              >
                <span className="truncate">{modelLabel}</span>
                <ChevronDown className="size-3 shrink-0 text-ink-mute" />
              </button>
            </Tooltip>
          ) : (
            <Menu>
              <MenuTrigger>
                <button type="button" aria-label="Model" className={pickerCls}>
                  <span className="truncate">{modelLabel}</span>
                  <ChevronDown className="size-3 shrink-0 text-ink-mute" />
                </button>
              </MenuTrigger>
              <MenuContent>
                {(runtime?.availableModels ?? []).map((m) => (
                  <MenuItem
                    key={`${m.provider}/${m.id}`}
                    onSelect={() => void pickModel(m)}
                    className={
                      m.id === runtime?.model?.id ? "text-accent" : undefined
                    }
                  >
                    {m.id}
                  </MenuItem>
                ))}
                {(runtime?.availableModels ?? []).length === 0 ? (
                  <MenuItem disabled>no models</MenuItem>
                ) : null}
              </MenuContent>
            </Menu>
          )}

          <Menu>
            <MenuTrigger>
              <button
                type="button"
                aria-label="Thinking level"
                className={pickerCls}
              >
                <span className="truncate">
                  {runtime?.thinkingLevel ?? "thinking"}
                </span>
                <ChevronDown className="size-3 shrink-0 text-ink-mute" />
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
              <IconButton label="More" size="sm">
                <Ellipsis />
              </IconButton>
            </MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => void compactHistory(sessionId)}>
                Compact history
              </MenuItem>
            </MenuContent>
          </Menu>

          {!connected ? (
            <span className="px-1 text-[11px] text-ink-mute">
              reconnecting…
            </span>
          ) : null}

          <span className="ml-auto flex items-center gap-1.5">
            {steerCount > 0 ? (
              <Badge tone="info">{steerCount} steer</Badge>
            ) : null}
            {followUpCount > 0 ? (
              <Badge tone="neutral">{followUpCount} queued</Badge>
            ) : null}
            {active ? (
              <Tooltip
                content={confirming ? "Click again to confirm" : "Stop turn"}
              >
                <button
                  type="button"
                  aria-label="Stop turn"
                  onClick={onStop}
                  className="flex size-7 items-center justify-center rounded-full border border-err/30 bg-err/10 text-err transition-colors hover:bg-err/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-err"
                >
                  <Square className="size-3 fill-current" />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content="Send">
                <button
                  type="button"
                  aria-label="Send"
                  disabled={!canSend}
                  onClick={() => void doSend()}
                  className="flex size-7 items-center justify-center rounded-full bg-accent text-on-accent transition-colors hover:bg-accent-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-40"
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
