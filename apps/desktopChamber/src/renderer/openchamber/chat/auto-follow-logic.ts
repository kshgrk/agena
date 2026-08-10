export type AutoFollowState = "following" | "released";

export const bottomZone = (mobile: boolean, viewportHeight: number): number =>
  mobile ? 40 : Math.max(48, viewportHeight * 0.1);

export const distanceFromBottom = (element: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): number => element.scrollHeight - element.scrollTop - element.clientHeight;

export function followStateAfterScroll(input: {
  state: AutoFollowState;
  scrollingDown: boolean;
  distance: number;
  threshold: number;
  programmatic: boolean;
  animationGuarded: boolean;
}): AutoFollowState {
  if (input.distance <= 2) return "following";
  if (input.distance <= input.threshold) {
    return input.scrollingDown || input.state === "following"
      ? "following"
      : "released";
  }
  if (
    input.state === "following" &&
    (input.programmatic || input.animationGuarded)
  ) {
    return "following";
  }
  return "released";
}
