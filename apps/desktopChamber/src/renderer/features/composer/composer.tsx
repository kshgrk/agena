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
  MAX_SOURCE_REFERENCES,
  parseReferenceText,
  type SourceReference,
  serializeReferenceText,
} from "../../store/source-reference.ts";
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
import { ComposerReferences } from "./source-reference-ui.tsx";

// ---- drafts (module store, hydrated once, debounce-persisted) ------------------

type ComposerDraft = { text: string; references: SourceReference[] };

type ComposerDraftsStore = {
  drafts: Readonly<Record<string, ComposerDraft>>;
  setDraft: (sessionId: string, text: string) => void;
  addReference: (sessionId: string, reference: SourceReference) => void;
  removeReference: (sessionId: string, id: string) => void;
  setReferenceNote: (sessionId: string, id: string, note: string) => void;
};

const EMPTY_DRAFT: ComposerDraft = { text: "", references: [] };

function referenceWithNote(
  reference: SourceReference,
  note: string,
): SourceReference {
  if (note) return { ...reference, note };
  const { note: _note, ...withoutNote } = reference;
  return withoutNote;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // full-record write (savePersisted replaces whole top-level records)
    const drafts = Object.fromEntries(
      Object.entries(useComposerDrafts.getState().drafts)
        .filter(([, draft]) => draft.text !== "" || draft.references.length > 0)
        .map(([sessionId, draft]) => [
          sessionId,
          serializeReferenceText(draft.text, draft.references),
        ]),
    );
    savePersistedPatch({ drafts });
  }, 500);
}

export const useComposerDrafts = create<ComposerDraftsStore>((set, get) => ({
  drafts: {},
  setDraft: (sessionId, text) => {
    set((s) => ({
      drafts: {
        ...s.drafts,
        [sessionId]: { ...(s.drafts[sessionId] ?? EMPTY_DRAFT), text },
      },
    }));
    scheduleSave();
  },
  addReference: (sessionId, reference) => {
    if (
      (get().drafts[sessionId]?.references.length ?? 0) >= MAX_SOURCE_REFERENCES
    ) {
      pushToast({
        kind: "warn",
        title: "Reference limit reached",
        detail: `Remove one before adding another (maximum ${MAX_SOURCE_REFERENCES}).`,
      });
      return;
    }
    set((s) => {
      const draft = s.drafts[sessionId] ?? EMPTY_DRAFT;
      return {
        drafts: {
          ...s.drafts,
          [sessionId]: {
            ...draft,
            references: [...draft.references, reference],
          },
        },
      };
    });
    scheduleSave();
  },
  removeReference: (sessionId, id) => {
    set((s) => {
      const draft = s.drafts[sessionId] ?? EMPTY_DRAFT;
      return {
        drafts: {
          ...s.drafts,
          [sessionId]: {
            ...draft,
            references: draft.references.filter((ref) => ref.id !== id),
          },
        },
      };
    });
    scheduleSave();
  },
  setReferenceNote: (sessionId, id, note) => {
    set((s) => {
      const draft = s.drafts[sessionId] ?? EMPTY_DRAFT;
      return {
        drafts: {
          ...s.drafts,
          [sessionId]: {
            ...draft,
            references: draft.references.map((ref) =>
              ref.id === id ? referenceWithNote(ref, note) : ref,
            ),
          },
        },
      };
    });
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
        drafts: {
          ...Object.fromEntries(
            Object.entries(p.drafts).map(([sessionId, value]) => [
              sessionId,
              parseReferenceText(value),
            ]),
          ),
          ...s.drafts,
        },
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

type DraftAttachment = {
  id: string;
  name: string;
  ref: BlobRef;
  kind: "image" | "file";
  previewUrl?: string;
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
  const draft = useComposerDrafts((s) => s.drafts[sessionId] ?? EMPTY_DRAFT);
  const value = draft.text;
  const references = draft.references;
  const setDraft = useComposerDrafts((s) => s.setDraft);
  const addReference = useComposerDrafts((s) => s.addReference);
  const removeReference = useComposerDrafts((s) => s.removeReference);
  const setReferenceNote = useComposerDrafts((s) => s.setReferenceNote);
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
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
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
    if (insert.sessionId && insert.sessionId !== sessionId) return;
    if (insert.text) {
      const cur = useComposerDrafts.getState().drafts[sessionId]?.text ?? "";
      setDraft(sessionId, cur ? `${cur}${insert.text}` : insert.text);
    }
    for (const reference of insert.references ?? []) {
      addReference(sessionId, reference);
    }
    composerRef.current?.focus();
  }, [insert, sessionId, setDraft, addReference]);

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
    const userText = value.trim();
    const text = serializeReferenceText(userText, references);
    const bridge = peekBridge();
    if (
      (!userText && references.length === 0 && attachments.length === 0) ||
      !connected ||
      sending ||
      uploading ||
      !bridge
    )
      return;
    const content: ContentBlock[] = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...attachments.map((attachment) =>
        attachment.kind === "image"
          ? {
              type: "image" as const,
              ref: attachment.ref,
              alt: attachment.name,
            }
          : {
              type: "file" as const,
              ref: attachment.ref,
              path: attachment.name,
            },
      ),
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
      useComposerDrafts.setState((state) => ({
        drafts: {
          ...state.drafts,
          [sessionId]: EMPTY_DRAFT,
        },
      }));
      scheduleSave();
      for (const attachment of attachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      setAttachments([]);
    } catch (e) {
      pushToast({ kind: "err", title: "Send failed", detail: errText(e) });
    } finally {
      setSending(false);
      composerRef.current?.focus();
    }
  }

  async function addAttachmentFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    const bridge = peekBridge();
    if (!bridge) return;
    if (attachments.length + files.length > 10) {
      pushToast({
        kind: "warn",
        title: "Attachment limit reached",
        detail: "A message can contain up to 10 attachments.",
      });
      return;
    }
    setUploading(true);
    try {
      for (const file of files) {
        if (
          file.type.startsWith("image/") ||
          /\.(?:bmp|gif|jpe?g|png|webp)$/i.test(file.name)
        ) {
          const prepared = await uploadableImage(file);
          const ref = await bridge.uploadImage(
            prepared.bytes,
            prepared.mimeType,
          );
          setAttachments((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              name: file.name || "image",
              ref,
              kind: "image",
              previewUrl: URL.createObjectURL(file),
            },
          ]);
          continue;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const ref = await bridge.uploadAttachment(
          bytes,
          file.type || "application/octet-stream",
          file.name,
        );
        setAttachments((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            name: file.name,
            ref,
            kind: "file",
          },
        ]);
      }
    } catch (error) {
      pushToast({
        kind: "err",
        title: "Attachment upload failed",
        detail: errText(error),
      });
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(id: string): void {
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((attachment) => attachment.id !== id);
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
        onAttachFiles={(files) => void addAttachmentFiles([...files])}
        onRemoveAttachment={removeAttachment}
        attachments={attachments.map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType:
            attachment.ref.mimeType ??
            (attachment.kind === "image"
              ? "image/*"
              : "application/octet-stream"),
          ...(attachment.previewUrl
            ? { previewUrl: attachment.previewUrl }
            : {}),
        }))}
        contextAttachments={
          <ComposerReferences
            references={references}
            onRemove={(id) => removeReference(sessionId, id)}
            onNoteChange={(id, note) => setReferenceNote(sessionId, id, note)}
          />
        }
        hasContext={references.length > 0}
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
