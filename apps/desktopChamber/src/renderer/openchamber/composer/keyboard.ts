export function shouldSubmitComposerKey(
  event: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    isComposing: boolean;
    keyCode: number;
  },
  mobile: boolean,
): boolean {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.isComposing ||
    event.keyCode === 229
  ) {
    return false;
  }
  return !mobile || event.ctrlKey || event.metaKey;
}
