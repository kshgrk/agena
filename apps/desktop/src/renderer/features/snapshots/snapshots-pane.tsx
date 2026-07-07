// Snapshot cards: create / restore (typed confirm, D-INV-8) / delete (plan D3).
import type { SnapshotSummary } from "@agena/protocol";
import {
  AlertTriangle,
  Camera,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getBridge } from "../../lib/bridge.ts";
import {
  Badge,
  type BadgeTone,
  Button,
  cx,
  EmptyState,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Modal,
  ModalClose,
  ModalDescription,
  ModalFooter,
  ModalTitle,
  PanelHeader,
  PanelShell,
  RelativeTime,
  Spinner,
  TextInput,
  toast,
} from "../../ui/index.ts";

const errMessage = (err: unknown): string =>
  typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : String(err);

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const KIND_BADGE: Record<
  SnapshotSummary["kind"],
  { tone: BadgeTone; label: string }
> = {
  manual: { tone: "neutral", label: "manual" },
  auto: { tone: "info", label: "auto" },
  pre_tool: { tone: "info", label: "pre-tool" },
  pre_restore: { tone: "warn", label: "safety" },
};

const labelOf = (snap: SnapshotSummary): string =>
  snap.name ?? snap.snapshotId.slice(-8);

// ---- confirm modals -----------------------------------------------------------

function RestoreConfirm({
  target,
  onClose,
  onRestored,
}: {
  target: SnapshotSummary;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const phrase = target.name ?? "restore";
  const canRestore = typed === phrase && !busy;

  const restore = () => {
    setBusy(true);
    getBridge()
      .restoreSnapshot(target.snapshotId)
      .then(({ safetySnapshotId }) => {
        toast(
          `Restored “${labelOf(target)}” — safety snapshot ${safetySnapshotId.slice(-6)} taken first`,
          { tone: "ok" },
        );
        onRestored();
        onClose();
      })
      .catch((err) => {
        toast(errMessage(err), { tone: "err" });
        setBusy(false);
      });
  };

  return (
    <Modal open onOpenChange={(open) => !open && !busy && onClose()} size="sm">
      <ModalTitle>Restore snapshot</ModalTitle>
      <ModalDescription>
        Files under /workspace revert to “{labelOf(target)}” (
        {humanSize(target.sizeBytes)}). Session history is untouched. A safety
        snapshot (pre_restore) is taken first, so the restore is itself
        reversible.
      </ModalDescription>
      <label
        htmlFor="restore-confirm"
        className="mt-3 block text-xs text-ink-dim"
      >
        Type <span className="font-mono text-ink">{phrase}</span> to confirm
        <TextInput
          id="restore-confirm"
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canRestore) restore();
          }}
          disabled={busy}
          spellCheck={false}
          className="mt-1.5 font-mono"
        />
      </label>
      <ModalFooter>
        <ModalClose asChild>
          <Button disabled={busy}>Cancel</Button>
        </ModalClose>
        <Button
          variant="danger"
          disabled={!canRestore}
          onClick={restore}
          icon={busy ? <Spinner /> : null}
        >
          {busy ? "Restoring…" : "Restore"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function DeleteConfirm({
  target,
  onClose,
  onDeleted,
}: {
  target: SnapshotSummary;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const del = () => {
    setBusy(true);
    getBridge()
      .deleteSnapshot(target.snapshotId)
      .then(() => {
        toast(`Snapshot “${labelOf(target)}” deleted`, { tone: "ok" });
        onDeleted();
        onClose();
      })
      .catch((err) => {
        toast(errMessage(err), { tone: "err" });
        setBusy(false);
      });
  };

  return (
    <Modal open onOpenChange={(open) => !open && !busy && onClose()} size="sm">
      <ModalTitle>Delete snapshot</ModalTitle>
      <ModalDescription>
        “{labelOf(target)}” ({humanSize(target.sizeBytes)},{" "}
        {KIND_BADGE[target.kind].label}) is removed from snapshot storage. Files
        under /workspace are not affected.
      </ModalDescription>
      <ModalFooter>
        <ModalClose asChild>
          <Button disabled={busy}>Cancel</Button>
        </ModalClose>
        <Button variant="danger" disabled={busy} onClick={del}>
          {busy ? "Deleting…" : "Delete"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

// ---- pane -----------------------------------------------------------------

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; snapshots: SnapshotSummary[] };

export function SnapshotsPane() {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<SnapshotSummary | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<SnapshotSummary | null>(
    null,
  );

  const refresh = useCallback(() => {
    getBridge()
      .listSnapshots()
      .then((all) =>
        setList({
          status: "ready",
          snapshots: all
            .filter((s) => s.status !== "deleted")
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        }),
      )
      .catch((err) => setList({ status: "error", message: errMessage(err) }));
  }, []);

  useEffect(refresh, [refresh]);

  const cancelCreate = () => {
    setCreating(false);
    setName("");
  };

  const create = () => {
    const trimmed = name.trim();
    setBusy(true);
    getBridge()
      .createSnapshot(trimmed ? { name: trimmed } : undefined)
      .then((snap) => {
        toast(`Snapshot “${labelOf(snap)}” created`, { tone: "ok" });
        cancelCreate();
        refresh();
      })
      .catch((err) => toast(errMessage(err), { tone: "err" }))
      .finally(() => setBusy(false));
  };

  return (
    <PanelShell>
      <PanelHeader
        title="Snapshots"
        actions={
          <Button
            size="sm"
            icon={<Plus />}
            onClick={() => setCreating(true)}
            disabled={creating}
          >
            New snapshot
          </Button>
        }
      />
      {creating ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border p-2">
          <TextInput
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) create();
              if (e.key === "Escape" && !busy) cancelCreate();
            }}
            placeholder="Snapshot name (optional)"
            disabled={busy}
            spellCheck={false}
          />
          <Button variant="solid" onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </Button>
          <IconButton label="Cancel" onClick={cancelCreate} disabled={busy}>
            <X />
          </IconButton>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {list.status === "loading" ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-ink-mute">
            <Spinner /> loading snapshots…
          </div>
        ) : list.status === "error" ? (
          <EmptyState
            icon={AlertTriangle}
            title="Could not load snapshots"
            hint={list.message}
            action={
              <Button size="sm" onClick={refresh}>
                Retry
              </Button>
            }
          />
        ) : list.snapshots.length === 0 ? (
          <EmptyState
            icon={Camera}
            title="No snapshots yet"
            hint="Capture /workspace before risky work."
            action={
              <Button
                size="sm"
                icon={<Plus />}
                onClick={() => setCreating(true)}
              >
                New snapshot
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-1.5 p-2">
            {list.snapshots.map((snap) => (
              <div
                key={snap.snapshotId}
                className="flex items-center gap-2.5 rounded-md border border-border bg-raised/40 px-3 py-2"
              >
                <Camera className="size-4 shrink-0 text-ink-mute" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={cx(
                        "truncate text-xs font-medium",
                        snap.name ? "text-ink" : "font-mono text-ink-dim",
                      )}
                    >
                      {labelOf(snap)}
                    </span>
                    <Badge tone={KIND_BADGE[snap.kind].tone}>
                      {KIND_BADGE[snap.kind].label}
                    </Badge>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-mute">
                    <span>{humanSize(snap.sizeBytes)}</span>
                    <span>·</span>
                    <RelativeTime iso={snap.createdAt} />
                  </div>
                </div>
                <Menu>
                  <MenuTrigger>
                    <IconButton size="sm" label="Snapshot actions">
                      <MoreHorizontal />
                    </IconButton>
                  </MenuTrigger>
                  <MenuContent align="end">
                    <MenuItem onSelect={() => setRestoreTarget(snap)}>
                      <RotateCcw /> Restore…
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      className="text-err [&>svg]:text-err"
                      onSelect={() => setDeleteTarget(snap)}
                    >
                      <Trash2 /> Delete…
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </div>
            ))}
          </div>
        )}
      </div>
      {restoreTarget ? (
        <RestoreConfirm
          target={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onRestored={refresh}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteConfirm
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={refresh}
        />
      ) : null}
    </PanelShell>
  );
}
