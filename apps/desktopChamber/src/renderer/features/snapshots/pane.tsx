// Snapshots pane: list with relative times, create with optional name,
// restore behind a typed-confirm dialog (destructive — a safety pre_restore
// snapshot is taken first), delete behind a plain confirm. Toasts on every
// completion (ARCHITECTURE contract 4). Improves on the old app by also
// refreshing when a snapshot.* event lands in the active session.
import type { SnapshotSummary } from "@agena/protocol";
import { Camera, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import { formatBridgeError } from "../../lib/errors.ts";
import { formatBytes } from "../../lib/format.ts";
import {
  pushToast,
  useSessions,
  useTranscripts,
  useUi,
} from "../../store/index.ts";
import {
  Badge,
  Button,
  cx,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  IconButton,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  RelativeTime,
  Spinner,
} from "../../ui/index.ts";
import {
  confirmPhrase,
  KIND_BADGE,
  snapshotLabel,
  visibleSnapshots,
} from "./snapshots-lib.ts";

type ListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshots: SnapshotSummary[] };

/** Dialogs are DOM overlays — participate in D-INV-3 overlay counting. */
function useOverlay(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    useUi.getState().enterOverlay();
    return () => useUi.getState().exitOverlay();
  }, [open]);
}

// ---- confirm dialogs -----------------------------------------------------------

function RestoreConfirm({
  target,
  onDone,
  onClose,
}: {
  target: SnapshotSummary;
  onDone: () => void;
  onClose: () => void;
}) {
  const phrase = confirmPhrase(target);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  useOverlay(true);
  const matches = typed === phrase;

  const restore = () => {
    if (!matches || busy) return;
    setBusy(true);
    (async () => getBridge().restoreSnapshot(target.snapshotId))()
      .then(({ safetySnapshotId }) => {
        pushToast({
          kind: "ok",
          title: `Restored “${snapshotLabel(target)}”`,
          detail: `Safety snapshot …${safetySnapshotId.slice(-6)} taken first`,
        });
        onDone();
      })
      .catch((err: unknown) => {
        setBusy(false);
        pushToast({
          kind: "err",
          title: "Restore failed",
          detail: formatBridgeError(err),
        });
      });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} size="sm">
      <DialogTitle>Restore snapshot?</DialogTitle>
      <DialogDescription>
        Every file under /workspace reverts to “{snapshotLabel(target)}”.
        Session history is untouched, and a safety snapshot is taken first — but
        current file changes will be overwritten.
      </DialogDescription>
      <label className="mb-1 mt-4 block text-xs font-medium text-fg-secondary">
        Type <span className="font-mono text-danger">{phrase}</span> to confirm
      </label>
      <Input
        autoFocus
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") restore();
        }}
        placeholder={phrase}
      />
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="danger-ghost"
          icon={<RotateCcw />}
          disabled={!matches || busy}
          onClick={restore}
        >
          {busy ? "Restoring…" : "Restore"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function DeleteConfirm({
  target,
  onDone,
  onClose,
}: {
  target: SnapshotSummary;
  onDone: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  useOverlay(true);

  const remove = () => {
    if (busy) return;
    setBusy(true);
    (async () => getBridge().deleteSnapshot(target.snapshotId))()
      .then(() => {
        pushToast({
          kind: "ok",
          title: `Deleted snapshot “${snapshotLabel(target)}”`,
        });
        onDone();
      })
      .catch((err: unknown) => {
        setBusy(false);
        pushToast({
          kind: "err",
          title: "Delete failed",
          detail: formatBridgeError(err),
        });
      });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} size="sm">
      <DialogTitle>Delete snapshot?</DialogTitle>
      <DialogDescription>
        “{snapshotLabel(target)}” ({formatBytes(target.sizeBytes)}) is removed
        permanently. Files under /workspace are not affected.
      </DialogDescription>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="danger-ghost"
          icon={<Trash2 />}
          disabled={busy}
          onClick={remove}
        >
          {busy ? "Deleting…" : "Delete"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ---- rows ----------------------------------------------------------------------

function SnapshotRow({
  snapshot,
  onRestore,
  onDelete,
}: {
  snapshot: SnapshotSummary;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const kind = KIND_BADGE[snapshot.kind];
  return (
    <div className="group flex items-center gap-2 rounded-lg border border-border-subtle bg-surface p-3">
      <Camera className="size-4 shrink-0 text-fg-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cx(
              "truncate text-sm font-medium",
              snapshot.name ? "text-fg" : "font-mono text-fg-muted",
            )}
            title={snapshot.snapshotId}
          >
            {snapshotLabel(snapshot)}
          </span>
          <Badge tone={kind.tone}>{kind.label}</Badge>
        </div>
        <div className="text-xs text-fg-muted">
          <span className="tabular-nums">
            {formatBytes(snapshot.sizeBytes)}
          </span>
          {" · "}
          <RelativeTime iso={snapshot.createdAt} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <IconButton label="Restore…" size="sm" onClick={onRestore}>
          <RotateCcw />
        </IconButton>
        <IconButton
          label="Delete…"
          size="sm"
          variant="danger-ghost"
          onClick={onDelete}
        >
          <Trash2 />
        </IconButton>
      </div>
    </div>
  );
}

// ---- the pane -------------------------------------------------------------------

export function SnapshotsPane() {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<SnapshotSummary | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<SnapshotSummary | null>(
    null,
  );

  const refresh = useCallback(() => {
    (async () => getBridge().listSnapshots())()
      .then((snapshots) =>
        setList({ kind: "ready", snapshots: visibleSnapshots(snapshots) }),
      )
      .catch((err: unknown) =>
        setList({ kind: "error", message: formatBridgeError(err) }),
      );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // refresh when a snapshot.* event lands in the active session (only the
  // last few raw events are scanned — new events are always at the tail)
  const activeSessionId = useSessions((s) => s.activeSessionId);
  const lastSnapshotSeq = useTranscripts((s) => {
    const transcript = activeSessionId
      ? s.bySession[activeSessionId]
      : undefined;
    if (!transcript) return 0;
    const raw = transcript.rawEvents;
    for (let i = raw.length - 1; i >= Math.max(0, raw.length - 20); i--) {
      const row = raw[i]!;
      if (row.type.startsWith("snapshot.")) return row.seq;
    }
    return 0;
  });
  const seenSnapshotSeq = useRef(lastSnapshotSeq);
  useEffect(() => {
    if (lastSnapshotSeq > seenSnapshotSeq.current) refresh();
    seenSnapshotSeq.current = lastSnapshotSeq;
  }, [lastSnapshotSeq, refresh]);

  const create = () => {
    if (creating) return;
    const trimmed = name.trim();
    setCreating(true);
    (async () =>
      getBridge().createSnapshot(trimmed ? { name: trimmed } : undefined))()
      .then((snapshot) => {
        pushToast({
          kind: "ok",
          title: `Snapshot “${snapshotLabel(snapshot)}” created`,
        });
        setNaming(false);
        setName("");
        refresh();
      })
      .catch((err: unknown) =>
        pushToast({
          kind: "err",
          title: "Snapshot failed",
          detail: formatBridgeError(err),
        }),
      )
      .finally(() => setCreating(false));
  };

  const body = useMemo(() => {
    switch (list.kind) {
      case "loading":
        return (
          <div className="flex h-full items-center justify-center">
            <Spinner className="text-fg-muted" />
          </div>
        );
      case "error":
        return (
          <EmptyState
            icon={Camera}
            title="Couldn't load snapshots"
            hint={list.message}
            action={
              <Button icon={<RefreshCw />} onClick={refresh}>
                Retry
              </Button>
            }
          />
        );
      case "ready":
        if (list.snapshots.length === 0) {
          return (
            <EmptyState
              icon={Camera}
              title="No snapshots yet"
              hint="Capture the workspace before risky changes."
              action={
                <Button
                  variant="primary"
                  icon={<Plus />}
                  onClick={() => setNaming(true)}
                >
                  New snapshot
                </Button>
              }
            />
          );
        }
        return (
          <div className="flex flex-col gap-2 p-3">
            {list.snapshots.map((snapshot) => (
              <SnapshotRow
                key={snapshot.snapshotId}
                snapshot={snapshot}
                onRestore={() => setRestoreTarget(snapshot)}
                onDelete={() => setDeleteTarget(snapshot)}
              />
            ))}
          </div>
        );
    }
  }, [list, refresh]);

  return (
    <Panel>
      <PanelHeader
        title="Snapshots"
        actions={
          <>
            <IconButton label="Refresh" size="sm" onClick={refresh}>
              <RefreshCw />
            </IconButton>
            <Button
              size="sm"
              icon={<Plus />}
              onClick={() => setNaming((v) => !v)}
            >
              New snapshot
            </Button>
          </>
        }
      />
      {naming ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle p-2">
          <Input
            autoFocus
            fieldSize="md"
            placeholder="Snapshot name (optional)"
            value={name}
            disabled={creating}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
              else if (e.key === "Escape") {
                setNaming(false);
                setName("");
              }
            }}
          />
          <Button variant="primary" disabled={creating} onClick={create}>
            {creating ? "Creating…" : "Create"}
          </Button>
        </div>
      ) : null}
      <PanelBody>{body}</PanelBody>
      {restoreTarget ? (
        <RestoreConfirm
          target={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onDone={() => {
            setRestoreTarget(null);
            refresh();
          }}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteConfirm
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDone={() => {
            setDeleteTarget(null);
            refresh();
          }}
        />
      ) : null}
    </Panel>
  );
}
