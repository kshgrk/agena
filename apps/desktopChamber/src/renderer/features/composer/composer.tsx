// Composer (design.md §6, features.md §5.2): rounded-2xl surface at the
// bottom of the column — autosize textarea (44px → 40vh), implicit send mode
// (idle=prompt, running=steer/followUp with a visible Steer/Queue control and
// SESSION_BUSY/TURN_NOT_ACTIVE auto-convert via send.ts), model + thinking
// ghost chips fed by runtimeInfo, Esc two-step abort, Enter/⌘Enter send,
// per-session drafts persisted through the bridge, disabled while
// disconnected. Ported from apps/desktop composer.tsx onto the new kit.
import type {
  BlobRef,
  ContentBlock,
  ModelRef,
  ThinkingLevel,
} from "@agena/protocol";
import { Brain, ChevronDown, Cpu, Ellipsis, Gauge, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { peekBridge } from "../../lib/bridge.ts";
import { formatUsageStatus } from "../../lib/runtime-status.ts";
import {
  ChamberComposer,
  type ChamberComposerHandle,
} from "../../openchamber/composer/index.ts";
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
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
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
    const bridge = peekBridge();
    await bridge?.compact(sessionId);
    pushToast({ kind: "ok", title: "History compacted" });
    if (bridge) {
      void bridge
        .runtimeInfo(sessionId)
        .then((info) => useConnection.getState().setRuntime(sessionId, info))
        .catch(() => {});
    }
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
  "agena-composer-control inline-flex h-6 max-w-44 items-center gap-1 rounded-md px-2 text-xs " +
  "text-fg-secondary transition-colors duration-100 hover:bg-fg/6 hover:text-fg " +
  "[&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-fg-muted";

type DraftImage = {
  id: string;
  name: string;
  ref: BlobRef;
  previewUrl: string;
};

async function uploadableImage(
  file: File,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (file.size <= 3_000_000) {
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type,
    };
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.82, 0.68, 0.52]) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality),
    );
    if (blob && blob.size <= 3_000_000) {
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mimeType: "image/jpeg",
      };
    }
  }
  throw new Error("Image is too large after resizing");
}

// ---- component ------------------------------------------------------------------------

export function Composer({
  sessionId,
  mobile = false,
}: {
  sessionId: string;
  mobile?: boolean;
}) {
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
  const [uploading, setUploading] = useState(false);
  const [images, setImages] = useState<DraftImage[]>([]);
  const composerRef = useRef<ChamberComposerHandle | null>(null);
  const lastInsertNonce = useRef(useUi.getState().composerInsert?.nonce ?? 0);
  const wasActive = useRef(active);

  useEffect(() => hydrateDrafts(), []);

  // fetch runtime controls lazily on first render for this session
  useEffect(() => {
    if (runtime || !connected) return;
    void peekBridge()
      ?.runtimeInfo(sessionId)
      .then((info) => useConnection.getState().setRuntime(sessionId, info))
      .catch(() => {});
  }, [sessionId, runtime, connected]);

  useEffect(() => {
    if (wasActive.current && !active && connected) {
      void peekBridge()
        ?.runtimeInfo(sessionId)
        .then((info) => useConnection.getState().setRuntime(sessionId, info))
        .catch(() => {});
    }
    wasActive.current = active;
  }, [active, connected, sessionId]);

  // cross-pane "insert into composer" (nonce re-triggers on the same text;
  // an empty insert is the "focus composer" signal)
  useEffect(() => {
    if (!insert || insert.nonce === lastInsertNonce.current) return;
    lastInsertNonce.current = insert.nonce;
    if (insert.text) {
      const cur = useComposerDrafts.getState().drafts[sessionId] ?? "";
      setDraft(sessionId, cur ? `${cur}${insert.text}` : insert.text);
    }
    composerRef.current?.focus();
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
        run: () => composerRef.current?.focus(),
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
    if (
      (!text && images.length === 0) ||
      !connected ||
      sending ||
      uploading ||
      !bridge
    )
      return;
    const content: ContentBlock[] = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...images.map((image) => ({
        type: "image" as const,
        ref: image.ref,
        alt: image.name,
      })),
    ];
    setSending(true);
    try {
      const out = await performSend(
        {
          prompt: (t) => bridge.prompt(sessionId, t),
          steer: (t) => bridge.steer(sessionId, t),
          followUp: (t) => bridge.followUp(sessionId, t),
        },
        { active, queueMode, text, content },
      );
      if (out.notice) pushToast({ kind: "info", title: out.notice });
      setDraft(sessionId, "");
      for (const image of images) URL.revokeObjectURL(image.previewUrl);
      setImages([]);
    } catch (e) {
      pushToast({ kind: "err", title: "Send failed", detail: errText(e) });
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  }

  async function addImageFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    const bridge = peekBridge();
    if (!bridge) return;
    setUploading(true);
    try {
      const added = await Promise.all(
        files.map(async (file) => {
          const prepared = await uploadableImage(file);
          const ref = await bridge.uploadImage(
            prepared.bytes,
            prepared.mimeType,
          );
          return {
            id: crypto.randomUUID(),
            name: file.name || "image",
            ref,
            previewUrl: URL.createObjectURL(file),
          };
        }),
      );
      setImages((current) => [...current, ...added]);
    } catch (error) {
      pushToast({
        kind: "err",
        title: "Image upload failed",
        detail: errText(error),
      });
    } finally {
      setUploading(false);
    }
  }

  function removeImage(id: string): void {
    setImages((current) => {
      const removed = current.find((image) => image.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((image) => image.id !== id);
    });
  }

  function onStop(): void {
    if (confirming) {
      setConfirming(false);
      void abortTurn(sessionId);
    } else {
      setConfirming(true);
    }
  }

  async function pickModel(model: ModelRef): Promise<void> {
    try {
      const bridge = peekBridge();
      if (!bridge) return;
      const ack = await bridge.setModel(sessionId, model);
      useConnection.setState((current) => {
        const existing = current.runtime[sessionId];
        return existing
          ? {
              runtime: {
                ...current.runtime,
                [sessionId]: { ...existing, model: ack.model },
              },
            }
          : {};
      });
      void bridge
        .runtimeInfo(sessionId)
        .then((info) => useConnection.getState().setRuntime(sessionId, info))
        .catch(() => {});
    } catch (e) {
      pushToast({
        kind: "err",
        title: "Model change failed",
        detail: errText(e),
      });
    }
  }

  async function toggleFastMode(enabled: boolean): Promise<void> {
    try {
      const state = await peekBridge()?.setFastMode(sessionId, enabled);
      if (!state) return;
      useConnection.setState((current) => {
        const existing = current.runtime[sessionId];
        return existing
          ? {
              runtime: {
                ...current.runtime,
                [sessionId]: { ...existing, fastMode: state },
              },
            }
          : {};
      });
    } catch (error) {
      pushToast({
        kind: "err",
        title: "Fast mode change failed",
        detail: errText(error),
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

  const modelAvailable = runtime?.availableModels.some(
    (model) =>
      model.provider === runtime.model?.provider &&
      model.id === runtime.model.id,
  );
  const modelLabel = modelAvailable
    ? (runtime?.model?.id ?? "model")
    : "Choose model";
  const usageLabel = formatUsageStatus(
    runtime?.subscriptionUsage,
    runtime?.sessionUsage,
  );

  const modelControl = active ? (
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
      onPick={(model) => void pickModel(model)}
      mobile={mobile}
    />
  );
  const thinkingControl = (
    <Menu>
      <MenuTrigger>
        <button type="button" aria-label="Thinking level" className={chipCls}>
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
  );
  const menuControl = (
    <Menu>
      <MenuTrigger>
        <button type="button" aria-label="More" className={cx(chipCls, "px-1")}>
          <Ellipsis />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuCheckboxItem
          checked={runtime?.fastMode?.enabled ?? false}
          disabled={
            !runtime?.fastMode?.available && !runtime?.fastMode?.enabled
          }
          onCheckedChange={(checked) => void toggleFastMode(checked === true)}
        >
          Fast mode
        </MenuCheckboxItem>
        <MenuItem onSelect={() => void compactHistory(sessionId)}>
          Compact history
        </MenuItem>
      </MenuContent>
    </Menu>
  );
  const usageControl = usageLabel ? (
    mobile ? (
      <Menu>
        <MenuTrigger>
          <button
            type="button"
            aria-label="View usage limit"
            className={cx(chipCls, "px-1")}
          >
            <Gauge />
          </button>
        </MenuTrigger>
        <MenuContent align="end" className="min-w-56">
          <MenuLabel>Usage limit</MenuLabel>
          <div className="px-2 pb-2 text-sm tabular-nums text-fg">
            {usageLabel}
          </div>
          <div className="px-2 pb-2 text-xs text-fg-muted">
            {runtime?.subscriptionUsage
              ? "ChatGPT Codex weekly quota remaining"
              : "Cumulative cost for this session"}
          </div>
        </MenuContent>
      </Menu>
    ) : (
      <span className="truncate text-2xs tabular-nums text-fg-muted">
        {usageLabel}
      </span>
    )
  ) : null;
  const queueControls = (
    <>
      {steerCount > 0 ? <Badge tone="accent">{steerCount} steer</Badge> : null}
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
          {...(mobile ? { className: "agena-composer-segmented" } : {})}
        />
      ) : null}
    </>
  );

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

      <ChamberComposer
        ref={composerRef}
        value={value}
        onChange={(text) => setDraft(sessionId, text)}
        onSubmit={() => void doSend()}
        onAbort={onStop}
        onAttachFiles={(files) => void addImageFiles([...files])}
        onRemoveAttachment={removeImage}
        attachments={images.map((image) => ({
          id: image.id,
          name: image.name,
          mimeType: image.ref.mimeType ?? "image/*",
          previewUrl: image.previewUrl,
        }))}
        disabled={!connected || sending}
        running={active}
        uploading={uploading}
        mobile={mobile}
        placeholder={
          !connected
            ? "Reconnecting…"
            : active
              ? queueMode === "steer"
                ? "Steer the running turn…"
                : "Queue a follow-up for after this turn…"
              : "Prompt the agent…"
        }
        leadingActions={queueControls}
        modelControl={modelControl}
        thinkingControl={thinkingControl}
        fastModeIndicator={
          runtime?.fastMode?.active ? (
            <Zap aria-label="Fast mode active" className="size-3.5 text-warn" />
          ) : null
        }
        usage={usageControl}
        menuControl={menuControl}
      />
    </div>
  );
}
