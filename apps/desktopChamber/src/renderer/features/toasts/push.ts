// Action-carrying toasts. The store's Toast shape (foundation-owned) has no
// action field, so actions live here keyed by toast id; ToastsHost looks them
// up at render time. Queueing/auto-dismiss stay in store/ui pushToast
// (ARCHITECTURE cross-feature contract 4).
import type { ToastKind } from "../../store/index.ts";
import { pushToast, useUi } from "../../store/index.ts";

export type ToastAction = { label: string; run: () => void };

const actions = new Map<number, ToastAction>();

/** pushToast plus one action button (design.md §14: a single "View"-style link). */
export function pushToastWithAction(input: {
  kind: ToastKind;
  title: string;
  detail?: string;
  action: ToastAction;
}): void {
  const before = new Set(useUi.getState().toasts.map((t) => t.id));
  pushToast({
    kind: input.kind,
    title: input.title,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  });
  // pushToast sets state synchronously; the one new id is ours.
  const added = useUi.getState().toasts.find((t) => !before.has(t.id));
  if (added) actions.set(added.id, input.action);
}

export function toastAction(id: number): ToastAction | undefined {
  return actions.get(id);
}

/** Drop entries for toasts no longer rendered anywhere (host housekeeping). */
export function pruneToastActions(alive: ReadonlySet<number>): void {
  for (const id of actions.keys()) {
    if (!alive.has(id)) actions.delete(id);
  }
}
