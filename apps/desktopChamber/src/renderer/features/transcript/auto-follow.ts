export type FollowState = "following" | "released";

/** Scroll events caused by layout/virtualizer work do not release follow. */
export function nextFollowState({
  current,
  userIntent,
  previousTop,
  currentTop,
  distanceFromBottom,
  bottomThreshold,
}: {
  current: FollowState;
  userIntent: boolean;
  previousTop: number;
  currentTop: number;
  distanceFromBottom: number;
  bottomThreshold: number;
}): FollowState {
  if (!userIntent) return current;
  if (currentTop < previousTop - 1) return "released";
  if (distanceFromBottom <= bottomThreshold) return "following";
  return current;
}

export function bottomThreshold(clientHeight: number): number {
  return Math.max(48, clientHeight * 0.1);
}
