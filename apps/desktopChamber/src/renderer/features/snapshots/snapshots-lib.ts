// Pure helpers for the snapshots pane. Node-safe (type-only import).
import type { SnapshotSummary } from "@agena/protocol";

/** Non-deleted snapshots, newest first (createdAt desc, id desc tiebreak). */
export function visibleSnapshots(
  snapshots: readonly SnapshotSummary[],
): SnapshotSummary[] {
  return snapshots
    .filter((s) => s.status !== "deleted")
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        b.snapshotId.localeCompare(a.snapshotId),
    );
}

/** Display label: the name, or the id tail for unnamed snapshots. */
export function snapshotLabel(
  s: Pick<SnapshotSummary, "name" | "snapshotId">,
): string {
  return s.name ?? s.snapshotId.slice(-8);
}

/** What the user must type to confirm a restore (D-INV-8 typed confirm). */
export function confirmPhrase(s: Pick<SnapshotSummary, "name">): string {
  return s.name ?? "restore";
}

export const KIND_BADGE: Record<
  SnapshotSummary["kind"],
  { label: string; tone: "neutral" | "info" | "warn" }
> = {
  manual: { label: "manual", tone: "neutral" },
  auto: { label: "auto", tone: "info" },
  pre_tool: { label: "pre-tool", tone: "info" },
  pre_restore: { label: "safety", tone: "warn" },
};
